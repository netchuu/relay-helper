import type { z } from "zod";
import {
  type DeliveryCheck,
  REPLY_DATA_BYTES,
  type RpcError,
  type RpcMethod,
  RpcSchemas,
  type SendResult,
  sessionNameLength,
  type Turn,
  type TurnFullResult,
  type TurnStats,
} from "../../../protocol/index.ts";
import type { RelayConfig } from "../config.ts";
import { errMessage, log } from "../log.ts";
import { platform } from "../platform/index.ts";
import {
  AttachmentError,
  type AttachmentStore,
  attachmentFields,
  composeMessage,
  words,
} from "./attachments.ts";
import { ensurePushKey, revokeDevice } from "./auth.ts";
import type { Broker } from "./broker.ts";
import { audit, type DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import { notePhoneTyped, phoneTypePending } from "./hooks.ts";
import { DeliveryError, deliver, type TypeOps, WaitForPause, WaitForUnlock } from "./inject.ts";
import { liveActions, liveMessages, parseMessagesJson } from "./messages.ts";
import type { Notifier } from "./notifier.ts";
import type { PresenceMonitor } from "./presence.ts";
import { publicSession, type Registry, type SessionRecord } from "./registry.ts";
import { withoutIdeContext } from "./render.ts";
import { type ReplyQueue, reasonOfPause, type WaitReason } from "./replyQueue.ts";
import { SentMessages } from "./sentMessages.ts";
import { liveStep, parseStepsJson } from "./steps.ts";
import { StopError, type TurnStopper } from "./stop.ts";
import {
  TRANSCRIPT_TURN_PREFIX,
  transcriptPathFor,
  transcriptTurns,
  transcriptTurnText,
} from "./transcript.ts";

export interface RpcDeps {
  db: DB;
  events: EventLog;
  registry: Registry;
  broker: Broker;
  presence: PresenceMonitor;
  config: RelayConfig;
  /** Present when APNs or FCM is configured. */
  notifier?: Notifier | null;
  /** The phone's Stop (session.interrupt). */
  stopper?: TurnStopper;
  /** Replies waiting for the Mac to be unlocked (desktop-ide-delivery). */
  replies?: ReplyQueue;
  /** Photos and files from the phone (attachments). */
  attachments?: AttachmentStore;
  /** How replies reach terminals; tests swap them. */
  typeOps?: TypeOps;
  /** How long `session.send` waits for a pause itself before the reply queue takes over; tests shorten it. */
  pauseWait?: { inlineMs: number; pollMs: number };
}

/**
 * How long `session.send` waits for a pause in your typing before answering "queued" and leaving the message to the
 * reply queue: well inside the phone's 20 s reply timeout, so the phone shows "Sending…" and then sent, and never
 * "Couldn't send" for a message that will arrive.
 */
export const INLINE_PAUSE_WAIT = { inlineMs: 12_000, pollMs: 500 };

export type RpcOutcome = { result: unknown } | { error: RpcError };

type Handler<M extends RpcMethod> = (
  params: z.infer<(typeof RpcSchemas)[M]>,
  actor: string,
) => Promise<unknown> | unknown;

class RpcFailure extends Error {
  constructor(
    readonly code: RpcError["code"],
    message: string,
  ) {
    super(message);
  }
}

/**
 * A list of newest-first items cut (oldest dropped) until its JSON fits one reply. The phone sees a shorter page, as
 * when a session has little history.
 */
function fitReply<T>(items: T[]): T[] {
  let size = 2;
  const kept: T[] = [];
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (kept.length === 0 && size + bytes > REPLY_DATA_BYTES) {
      // One turn alone is too big (a huge prompt): its prompt becomes a preview so the page always fits.
      const small = shrinkPrompt(item);
      kept.push(small);
      size += Buffer.byteLength(JSON.stringify(small)) + 1;
      continue;
    }
    size += bytes;
    if (size > REPLY_DATA_BYTES) {
      log.warn("session.turns cut to fit the frame limit", { kept: kept.length, of: items.length });
      break;
    }
    kept.push(item);
  }
  return kept;
}

/** A copy of a turn-like item with its `prompt` cut (never splitting a character) until its JSON fits one reply. */
function shrinkPrompt<T>(item: T): T {
  const prompt = (item as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string") return item;
  let end = prompt.length;
  for (;;) {
    end = Math.floor(end * 0.7);
    if (end > 0 && isHighSurrogate(prompt.charCodeAt(end - 1))) end--;
    const cut = { ...item, prompt: end > 0 ? `${prompt.slice(0, end)}…` : "…" };
    if (end <= 0 || Buffer.byteLength(JSON.stringify(cut)) + 3 <= REPLY_DATA_BYTES) return cut;
  }
}

/** One piece of a long text for `turn.full`: from `offset`, as much as fits one reply, never splitting a character. */
function textPiece(text: string, offset: number): TurnFullResult {
  let end = Math.min(text.length, offset + 60_000);
  for (;;) {
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    const piece = text.slice(offset, end);
    if (end - offset <= 1 || Buffer.byteLength(JSON.stringify(piece)) <= REPLY_DATA_BYTES) {
      return end < text.length ? { text: piece, more: true, nextOffset: end } : { text: piece };
    }
    end = offset + Math.floor((end - offset) * 0.7);
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function createRpc(
  d: RpcDeps,
): (method: string, params: unknown, actor: string) => Promise<RpcOutcome> {
  const handlers: { [M in RpcMethod]: Handler<M> } = {
    sync: ({ sinceSeq }) => {
      const oldest = d.events.oldestSeq();
      const latestSeq = d.events.latestSeq();
      // Too far behind (events pruned) or first connect: send a snapshot plus the current seq.
      if (sinceSeq === 0 || sinceSeq < oldest - 1) {
        return {
          snapshot: {
            sessions: d.registry.list().map(publicSession),
            prompts: d.broker.listOpen(),
            presence: d.presence.get(),
          },
          events: [],
          latestSeq,
        };
      }
      // A replay cut by count or size says so, and its latestSeq is the last event sent, so the phone asks again.
      const page = d.events.syncPage(sinceSeq, {
        maxBytes: REPLY_DATA_BYTES,
        dropped: (event, bytes) =>
          log.warn("sync left out an event too big for one reply", {
            seq: event.seq,
            type: event.type,
            bytes,
          }),
      });
      return page.more
        ? { events: page.events, latestSeq: page.latestSeq, more: true }
        : { events: page.events, latestSeq: page.latestSeq };
    },

    "sessions.list": ({ includeEnded }) => d.registry.list(includeEnded).map(publicSession),

    "session.turns": ({ sessionId, limit }) => {
      const rows = d.db
        .query(
          "SELECT * FROM turns WHERE session_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?",
        )
        .all(sessionId, limit) as TurnRow[];
      const recorded = rows.map((r) => ({ ...toTurn(r), ...attachmentFields(d.db, sessionId, r.prompt) }));
      if (recorded.length >= limit) return fitReply(recorded);
      // Fill older history (before Relay's hooks saw this session) from Claude Code's transcript.
      const session = d.registry.get(sessionId);
      const path = session ? transcriptPathFor(session) : null;
      if (!session || !path) return fitReply(recorded);
      const oldest = recorded.length ? Math.min(...recorded.map((t) => t.startedAt ?? t.endedAt)) : undefined;
      const older = transcriptTurns(sessionId, path, {
        limit: limit - recorded.length,
        previewChars: d.config.previewChars,
        working: session.status === "working" && recorded.length === 0,
        before: oldest,
        cwd: session.cwd,
      });
      return fitReply([
        ...recorded,
        ...older.map((t) => ({ ...t, ...attachmentFields(d.db, sessionId, t.prompt) })),
      ]);
    },

    "session.send": async ({ sessionId, text: message, attachments: ids, sendId }, actor) => {
      // The same message again (Try Again after its reply was lost): answered as the first time, never typed
      // twice. One still on its way is waited for; one that failed is sent now.
      if (sendId) {
        for (;;) {
          const earlier = sent.get(sessionId, sendId);
          if (!earlier) break;
          const first = await earlier.catch(() => null);
          if (!first) continue;
          audit(d.db, actor, "session.send", { sessionId, via: first.via, repeat: true });
          // Still waiting: why, as of now.
          const reason = first.via === "queued" ? d.replies?.reasonOf(sessionId) : undefined;
          return { via: first.via, ...(reason ? { reason } : {}), repeat: true } satisfies SendResult;
        }
      }
      const sending = send(sessionId, message, ids, actor);
      return await (sendId ? sent.track(sessionId, sendId, sending) : sending);
    },

    "session.delivered": async ({ sessionId, sendId }) => {
      const first = await sent.get(sessionId, sendId)?.catch(() => null);
      return (first ? { delivered: true, via: first.via } : { delivered: false }) satisfies DeliveryCheck;
    },

    "attachment.begin": (params, actor) => {
      const store = attachmentsOrFail();
      const session = d.registry.get(params.sessionId);
      if (!session || session.status === "ended") throw new RpcFailure("not_found", words.sessionGone);
      const upload = attempt(() => store.begin(params));
      audit(d.db, actor, "attachment.begin", {
        sessionId: params.sessionId,
        id: upload.id,
        size: params.size,
      });
      return upload;
    },

    "attachment.chunk": (params) => attempt(() => attachmentsOrFail().chunk(params)),

    "attachment.end": (params) => attempt(() => attachmentsOrFail().end(params)),

    "attachment.discard": (params, actor) => {
      const result = attempt(() => attachmentsOrFail().discard(params));
      if (result.discarded) audit(d.db, actor, "attachment.discard", { id: params.id });
      return result;
    },

    "attachment.get": async (params) => {
      const store = attachmentsOrFail();
      try {
        return await store.get(params);
      } catch (err) {
        if (err instanceof AttachmentError) throw new RpcFailure(err.code, err.message);
        throw err;
      }
    },

    "session.rename": ({ sessionId, name }, actor) => {
      // Ended sessions too: they're still listed, and a resumed session keeps its ID.
      const renamed = d.registry.rename(sessionId, name);
      if (!renamed) throw new RpcFailure("not_found", "session not found");
      audit(d.db, actor, "session.rename", { sessionId, chars: name ? sessionNameLength(name) : 0 });
      return publicSession(renamed);
    },

    "session.interrupt": async ({ sessionId }, actor) => {
      if (!d.stopper) throw new RpcFailure("unavailable", "stopping isn't available");
      try {
        return await d.stopper.interrupt(sessionId, actor);
      } catch (err) {
        if (err instanceof StopError) throw new RpcFailure(err.code, err.message);
        throw err;
      }
    },

    "session.pin": ({ sessionId, pinned }, actor) => {
      // Ended sessions too: they keep the pin, and a resumed session comes back pinned.
      const updated = d.registry.pin(sessionId, pinned);
      if (!updated) throw new RpcFailure("not_found", "session not found");
      audit(d.db, actor, "session.pin", { sessionId, pinned });
      return publicSession(updated);
    },

    "prompt.answer": ({ promptId, answer }, actor) => {
      const res = d.broker.answer(promptId, answer, actor);
      if (!res.ok) throw new RpcFailure(res.code, res.message);
      return { ok: true };
    },

    "prompts.open": () => d.broker.listOpen(),

    "prompts.recent": ({ limit }) => d.broker.listRecent(limit),

    "turn.full": ({ turnId, offset }) => {
      if (turnId.startsWith(TRANSCRIPT_TURN_PREFIX)) {
        const [sessionId, uuid] = turnId.slice(TRANSCRIPT_TURN_PREFIX.length).split(":");
        const session = sessionId ? d.registry.get(sessionId) : null;
        const path = session ? transcriptPathFor(session) : null;
        const text = path && uuid ? transcriptTurnText(path, uuid) : null;
        if (text === null) throw new RpcFailure("not_found", "turn not found");
        return textPiece(text, offset);
      }
      const row = d.db.query("SELECT full_text FROM turns WHERE id = ?").get(turnId) as {
        full_text: string | null;
      } | null;
      if (!row) throw new RpcFailure("not_found", "turn not found");
      return textPiece(row.full_text ?? "", offset);
    },

    ping: () => ({ ok: true }),

    "presence.get": () => d.presence.get(),

    "presence.set": ({ mode }, actor) => {
      audit(d.db, actor, "presence.set", { mode });
      return d.presence.setMode(mode);
    },

    "device.registerPush": ({ platform, token, environment }, actor) => {
      const deviceId = actor.startsWith("device:") ? actor.slice("device:".length) : null;
      if (!deviceId) throw new RpcFailure("bad_request", "only a paired device can register for push");
      // The token lives in apns_token for both services. APNs tokens are hex (case-insensitive);
      // FCM tokens are case-sensitive, so only APNs ones are normalised.
      d.db
        .query("UPDATE devices SET apns_token = ?, apns_env = ?, push_platform = ? WHERE id = ?")
        .run(platform === "apns" ? token.toLowerCase() : token, environment, platform, deviceId);
      return { ok: true, pushEnabled: Boolean(d.notifier?.supports(platform)) };
    },

    "device.unpair": (_params, actor) => {
      const deviceId = actor.startsWith("device:") ? actor.slice("device:".length) : null;
      if (!deviceId) throw new RpcFailure("bad_request", "only a paired device can unpair itself");
      return { ok: revokeDevice(d.db, deviceId, actor) };
    },

    "session.live": ({ sessionId }) => {
      const row = d.db
        .query(
          "SELECT id, prompt, started_at FROM turns WHERE session_id = ? AND ended_at IS NULL AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(sessionId) as { id: string; prompt: string | null; started_at: number } | null;
      if (!row) return null;
      const step = liveStep(sessionId, row.id);
      const files = attachmentFields(d.db, sessionId, row.prompt);
      const messages = liveMessages(sessionId, row.id);
      const actions = liveActions(sessionId, row.id);
      return {
        turnId: row.id,
        prompt: row.prompt ?? "",
        startedAt: row.started_at,
        ...files,
        ...(step ? { step } : {}),
        ...(messages.length ? { messages } : {}),
        ...(actions.length ? { actions: actions.map((a) => ({ ...a })) } : {}),
      };
    },

    "push.key": (_params, actor) => {
      const deviceId = actor.startsWith("device:") ? actor.slice("device:".length) : null;
      if (!deviceId) throw new RpcFailure("bad_request", "only a paired device has a push key");
      return { key: ensurePushKey(d.db, deviceId) };
    },

    "push.test": async () => {
      if (!d.notifier)
        throw new RpcFailure(
          "unavailable",
          "push is not configured (~/.relay/apns/apns.json or ~/.relay/fcm/service-account.json)",
        );
      const sent = await d.notifier.pushAll({
        title: "Relay works",
        body: "Notifications from your Mac reach this phone.",
        category: "NOTICE",
        threadId: "relay",
        data: {},
      });
      return { sent };
    },
  };

  const sent = new SentMessages(undefined, undefined, undefined, d.db);

  /** session.send without its `sendId`: checks the message, then types it in (or queues it) after earlier ones. */
  async function send(
    sessionId: string,
    message: string,
    ids: string[] | undefined,
    actor: string,
  ): Promise<SendResult> {
    const arrived = Date.now();
    const withFiles = (ids?.length ?? 0) > 0;
    if (!withFiles && !message) throw new RpcFailure("bad_request", words.empty);
    const session = d.registry.get(sessionId);
    if (!session || session.status === "ended")
      throw new RpcFailure("not_found", withFiles ? words.sessionGone : "session not found or ended");
    let text = message;
    let files = 0;
    if (withFiles) {
      const store = attachmentsOrFail();
      const refs = attempt(() => store.forSend(sessionId, ids ?? []));
      text = composeMessage(message, refs);
      files = refs.length;
    }
    if (d.broker.hasOpen(sessionId))
      throw new RpcFailure("conflict", "the session is waiting for an answer; answer its prompt instead");
    // One send per session at a time, so messages waiting for a pause arrive in the order they were sent.
    return await inOrder(sessionId, async () => {
      try {
        const res = await sendNow(session, text, arrived);
        if (files > 0 && res.via === "socket")
          d.events.emit({
            type: "session.notice",
            sessionId,
            level: "attention",
            text: "Sent as a note; images arrive as file paths.",
          });
        audit(d.db, actor, "session.send", { sessionId, via: res.via, chars: text.length, files });
        return res;
      } catch (err) {
        if (err instanceof DeliveryError) throw new RpcFailure("unavailable", err.message);
        throw err;
      }
    });
  }

  const sending = new Map<string, Promise<unknown>>();

  /** Runs `fn` after the session's earlier sends have finished. */
  function inOrder<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const before = sending.get(sessionId) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const settled = run.then(
      () => {},
      () => {},
    );
    sending.set(sessionId, settled);
    void settled.then(() => {
      if (sending.get(sessionId) === settled) sending.delete(sessionId);
    });
    return run;
  }

  /**
   * Types the message in, or sends it through the session's other routes. When it has to wait (the Mac locked for
   * the desktop app, or you typing in that terminal or a draft in its prompt), it waits here for a pause for a few
   * seconds, then goes into the reply queue: `via: "queued"`.
   */
  async function sendNow(
    session: SessionRecord,
    text: string,
    arrived: number,
  ): Promise<{ via: string; reason?: WaitReason }> {
    const sessionId = session.id;
    const waiting = d.replies?.list(sessionId) ?? [];
    // Replies already waiting go first: keep the order the person sent them in.
    if (d.replies && waiting.length > 0) {
      d.replies.add(sessionId, text, arrived, waiting[waiting.length - 1]?.waitsFor);
      return queued(d.replies.reasonOf(sessionId));
    }
    const timing = d.pauseWait ?? INLINE_PAUSE_WAIT;
    for (;;) {
      // Fresh reading, not the 5 s presence poll: never type into a terminal while you are typing.
      const { idleSeconds, locked } = await platform.presence.read({
        tmuxSockets: session.tmuxSocket ? [session.tmuxSocket] : [],
      });
      const waited = Date.now() - arrived;
      // Before typing: its UserPromptSubmit hook arrives before deliver() returns (the desktop and IDE routes
      // wait for the transcript), and must know this came from the phone, not the person at the Mac.
      notePhoneTyped(sessionId, text);
      try {
        const res = await deliver(
          session,
          text,
          {
            submitted: () => !phoneTypePending(sessionId, text),
            idleSeconds,
            userTypingNow: idleSeconds !== null && idleSeconds < 8,
            preferTyping: d.config.preferTyping,
            locked: locked === true,
            // Only without a reply queue (never in the daemon): no one would type it later.
            typeAnyway: !d.replies && waited >= timing.inlineMs,
          },
          d.typeOps,
        );
        if (res.submitted === false) {
          const name = session.name ?? session.project ?? "the session";
          d.events.emit({
            type: "session.notice",
            sessionId,
            level: "error",
            text: `Your message to ${name} was typed but not sent. Press Enter at the computer, or send it again.`,
          });
        }
        return res;
      } catch (err) {
        if (err instanceof WaitForUnlock && d.replies) {
          d.replies.add(sessionId, text, arrived, "unlock");
          d.replies.setReason(sessionId, "locked");
          return queued("locked");
        }
        if (!(err instanceof WaitForPause)) throw err;
        // `relay shell` already waited up to 15 s for you to stop typing in that tab: don't ask it again here.
        const again =
          !(err.route === "pty" && err.reason === "typing") &&
          Date.now() - arrived + timing.pollMs < timing.inlineMs &&
          !d.broker.hasOpen(sessionId);
        if (again || !d.replies) {
          await Bun.sleep(timing.pollMs);
          continue;
        }
        log.info("waiting to type", { sessionId, route: err.route, reason: err.reason });
        d.replies.add(sessionId, text, arrived, "pause");
        const why = reasonOfPause(err);
        if (why) d.replies.setReason(sessionId, why);
        return queued(why ?? undefined);
      }
    }
  }

  /** The answer for a message that waits: why too, when the helper knows. */
  function queued(reason: WaitReason | undefined): { via: string; reason?: WaitReason } {
    return reason ? { via: "queued", reason } : { via: "queued" };
  }

  function attachmentsOrFail(): AttachmentStore {
    if (!d.attachments) throw new RpcFailure("unavailable", "Files can't be sent to this computer.");
    return d.attachments;
  }

  return async (method, params, actor) => {
    if (!(method in RpcSchemas))
      return { error: { code: "bad_request", message: `unknown method ${method}` } };
    const m = method as RpcMethod;
    const parsed = RpcSchemas[m].safeParse(params ?? {});
    if (!parsed.success)
      return {
        error: {
          code: "bad_request",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      };
    try {
      const handler = handlers[m] as Handler<typeof m>;
      return { result: await handler(parsed.data as never, actor) };
    } catch (err) {
      if (err instanceof RpcFailure) return { error: { code: err.code, message: err.message } };
      log.error("rpc failed", { method, err: errMessage(err) });
      return { error: { code: "internal", message: "internal error" } };
    }
  };
}

/** Runs an attachment step, turning its refusal into the RPC error with the same plain sentence. */
function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AttachmentError) throw new RpcFailure(err.code, err.message);
    throw err;
  }
}

interface TurnRow {
  id: string;
  session_id: string;
  prompt: string | null;
  full_text: string | null;
  summary: string | null;
  truncated: number;
  stats_json: string | null;
  failed: number;
  stopped: number;
  started_at: number | null;
  ended_at: number;
  steps_json?: string | null;
  messages_json?: string | null;
}

function toTurn(r: TurnRow): Turn {
  return {
    id: r.id,
    sessionId: r.session_id,
    // Turns recorded before the IDE context was left out still have it.
    prompt: r.prompt === null ? null : withoutIdeContext(r.prompt),
    summary: r.summary ?? "",
    fullLength: r.full_text?.length ?? 0,
    truncated: r.truncated === 1,
    stats: r.stats_json
      ? (JSON.parse(r.stats_json) as TurnStats)
      : { durationMs: null, toolCalls: 0, filesEdited: [] },
    failed: r.failed === 1,
    ...(r.stopped === 1 ? { stopped: true } : {}),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ...parseStepsJson(r.steps_json),
    ...parseMessagesJson(r.messages_json),
  };
}
