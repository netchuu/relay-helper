import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRef, AttachmentUpload } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { AttachmentStore } from "../src/daemon/attachments.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

/** A message with a photo that waits in the reply queue keeps the photo until it is typed. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLiveSteps();
});
const SID = "queued-photo-1";
type Outcome<T> = { result?: T; error?: { code: string; message: string } };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-queued-att-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(join(dir, "relay.db"));
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events, () => {});
  const config = { previewChars: 600, preferTyping: false } as RelayConfig;
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = {
    noteLocalActivity: () => {},
    get: () => ({ mode: "auto", present: true, idleSeconds: 0, locked: false }),
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const attachments = new AttachmentStore(db, join(dir, "attachments"), {});
  const replies = new ReplyQueue(db, events, registry);
  const rpc = createRpc({
    db,
    events,
    registry,
    broker,
    presence,
    config,
    steps,
    attachments,
    replies,
  } as unknown as RpcDeps);
  const call = async <T>(method: string, params: object): Promise<Outcome<T>> =>
    (await rpc(method, params, "device:d1")) as Outcome<T>;
  await hooks.handle(
    {
      payload: {
        hook_event_name: "SessionStart",
        session_id: SID,
        cwd: dir,
        transcript_path: transcript,
      },
      env: { socket: join(dir, "inbox.sock"), token: "tok" },
    } as HookEnvelope,
    new AbortController().signal,
  );
  const upload = async (): Promise<AttachmentRef> => {
    const bytes = randomBytes(64);
    const up = (
      await call<AttachmentUpload>("attachment.begin", {
        sessionId: SID,
        name: "a.png",
        mime: "image/png",
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      })
    ).result as AttachmentUpload;
    await call("attachment.chunk", {
      id: up.id,
      index: 0,
      data: Buffer.from(bytes).toString("base64"),
    });
    return (await call<AttachmentRef>("attachment.end", { id: up.id })).result as AttachmentRef;
  };
  return { call, replies, upload };
}

test("a discard in flight while the send is queued leaves the file the queued text points at", async () => {
  const { call, replies, upload } = await setup();
  replies.add(SID, "earlier", Date.now(), "unlock");
  const ref = await upload();
  const send = call<{ via: string }>("session.send", {
    sessionId: SID,
    text: "look",
    attachments: [ref.id],
  });
  await new Promise((r) => setTimeout(r, 0));
  const discard = await call("attachment.discard", { id: ref.id });
  const sent = await send;
  expect(sent.result?.via).toBe("queued");
  expect(discard.error?.code).toBe("conflict");
  expect(existsSync(ref.path)).toBe(true);
  expect(replies.list(SID).some((r) => r.text.includes(ref.path))).toBe(true);
});

test("a discard after the send was queued is refused too, and the file stays", async () => {
  const { call, replies, upload } = await setup();
  replies.add(SID, "earlier", Date.now(), "unlock");
  const ref = await upload();
  await call("session.send", { sessionId: SID, text: "look", attachments: [ref.id] });
  const discard = await call("attachment.discard", { id: ref.id });
  expect(discard.error?.code).toBe("conflict");
  expect(existsSync(ref.path)).toBe(true);
});

test("a discard with no queued message for the file still deletes it", async () => {
  const { call, replies, upload } = await setup();
  replies.add(SID, "earlier", Date.now(), "unlock");
  const ref = await upload();
  const discard = await call<{ discarded: boolean }>("attachment.discard", { id: ref.id });
  expect(discard.result?.discarded).toBe(true);
  expect(existsSync(ref.path)).toBe(false);
});
