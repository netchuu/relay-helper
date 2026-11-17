import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadOrCreateIdentity, PhoneChannel } from "../src/daemon/e2e.ts";
import { freePort, type LocalWorker, startLocalWorker } from "./support/local-worker.ts";

const REPO = resolve(import.meta.dir, "../..");
const HOME = join(process.env.RELAY_TEST_ROOT ?? "/tmp", `relay-unpair-reply-${process.pid}`);
const APP_PORT = freePort();
const SOCK = join(HOME, "hook.sock");
let relayUrl = "";
const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}
let worker: LocalWorker | null = null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

const pairCode = async () =>
  (
    (await fetch("http://relay/admin/pair", { method: "POST", unix: SOCK }).then((r) => r.json())) as {
      code: string;
    }
  ).code;

const revokeFromMac = (id: string) =>
  fetch("http://relay/admin/devices/revoke", { method: "POST", unix: SOCK, body: JSON.stringify({ id }) });

async function pairDirect(name: string): Promise<{ token: string; deviceId: string }> {
  const code = await pairCode();
  return (await fetch(`http://127.0.0.1:${APP_PORT}/pair`, {
    method: "POST",
    body: JSON.stringify({ code, deviceName: name }),
  }).then((r) => r.json())) as { token: string; deviceId: string };
}

async function openDirect(token: string) {
  const inbox: Record<string, unknown>[] = [];
  const state = { closed: null as number | null };
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  ws.onmessage = (m) => inbox.push(JSON.parse(String(m.data)));
  ws.onclose = (e) => (state.closed = e.code);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  ws.send(JSON.stringify({ id: 1, method: "ping" }));
  await waitFor(async () => inbox.find((m) => m.id === 1), 5000);
  return { ws, inbox, state };
}

async function openRelay() {
  const identity = await waitFor(async () => {
    try {
      return loadOrCreateIdentity(join(HOME, "identity.json"));
    } catch {
      return null;
    }
  });
  const inbox: Record<string, unknown>[] = [];
  const state = { closed: null as number | null };
  const phone = await waitFor(async () => {
    const channel = new PhoneChannel(identity.boxPublic);
    const ws = new WebSocket(`${relayUrl}/v1/connect?role=phone&mac=${identity.macId}`);
    ws.binaryType = "arraybuffer";
    let hs!: () => void;
    const got = new Promise<void>((r) => (hs = r));
    ws.onclose = (e) => (state.closed = e.code);
    ws.onmessage = (m) => {
      const bytes = new Uint8Array(m.data as ArrayBuffer);
      if (bytes[0] === 0x02) {
        channel.receiveHandshake(bytes);
        hs();
      } else inbox.push(JSON.parse(channel.open(bytes)));
    };
    const opened = await new Promise<boolean>((r) => {
      ws.onopen = () => r(true);
      ws.onerror = () => r(false);
    });
    if (!opened) return null;
    ws.send(channel.hello());
    const ok = await Promise.race([got.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!ok) {
      ws.close();
      return null;
    }
    state.closed = null;
    return { ws, channel };
  });
  const send = (id: number, method: string, params: object = {}) =>
    phone.ws.send(phone.channel.seal(JSON.stringify({ id, method, params })));
  const code = await pairCode();
  send(1, "pair", { code, deviceName: "Relay phone" });
  const paired = await waitFor(async () => inbox.find((m) => m.id === 1), 5000);
  const result = paired.result as { token: string; deviceId: string };
  expect(result.token.length).toBeGreaterThan(30);
  send(2, "ping");
  await waitFor(async () => inbox.find((m) => m.id === 2), 5000);
  return { send, inbox, state, deviceId: result.deviceId };
}

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  worker = await startLocalWorker({ cloudDir: join(REPO, "cloud"), stateDir: join(HOME, "worker"), env });
  relayUrl = `ws://127.0.0.1:${worker.port}`;
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: APP_PORT, claudeBin: "/usr/bin/false", preferTyping: false, relayUrl }),
  );
  daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
    env,
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(() => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok));
}, 90_000);

afterAll(async () => {
  daemon?.kill();
  await worker?.stop();
  rmSync(HOME, { recursive: true, force: true });
});

test("over the relay: device.unpair is answered with ok, then the stream closes", async () => {
  const phone = await openRelay();
  phone.send(3, "device.unpair");
  await waitFor(async () => phone.state.closed !== null, 10_000);
  const reply = phone.inbox.find((m) => m.type === "rpc" && m.id === 3);
  expect(reply?.result).toEqual({ ok: true });
}, 60_000);

test("direct WebSocket: device.unpair is answered with ok before the 4401 close", async () => {
  const { token } = await pairDirect("Direct phone");
  const { ws, inbox, state } = await openDirect(token);
  ws.send(JSON.stringify({ id: 2, method: "device.unpair" }));
  await waitFor(async () => state.closed !== null, 10_000);
  const reply = inbox.find((m) => m.type === "rpc" && m.id === 2);
  expect(reply?.result).toEqual({ ok: true });
  expect(state.closed).toBe(4401);
}, 30_000);

test("a device revoked from the Mac loses its direct WebSocket at once", async () => {
  const { token, deviceId } = await pairDirect("Revoked direct");
  const { state } = await openDirect(token);
  await revokeFromMac(deviceId);
  await waitFor(async () => state.closed !== null, 2000);
  expect(state.closed).toBe(4401);
}, 30_000);

test("a device revoked from the Mac loses its relay stream at once", async () => {
  const phone = await openRelay();
  await revokeFromMac(phone.deviceId);
  await waitFor(async () => phone.state.closed !== null, 2000);
  expect(phone.state.closed).not.toBeNull();
}, 60_000);
