import type { z } from "zod";
import {
  type DeliveryCheck,
  type ModelResult,
  REPLY_DATA_BYTES,
  type RpcError,
  type RpcMethod,
  RpcSchemas,
  type SendResult,
  type SessionCommands,
  type SessionResumed,
  type SessionStarted,
  sessionNameLength,
  type Turn,
  type TurnFullResult,
  type TurnStats,
  type TurnStep,
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
import type { Handover } from "./handover.ts";
import { type HeadlessSessions, ResumeError } from "./headless.ts";
import type { HeldReplies } from "./held.ts";
import { dropPhoneTyped, notePhoneTyped, phoneTypeDelivered, phoneTypePending } from "./hooks.ts";
import {
  confirmModelSwitch,
  DeliveryError,
  deliver,
  modelResultsOnScreen,
  PHONE_PREFIX,
  type TypeOps,
  WaitForPause,
  WaitForUnlock,
} from "./inject.ts";
import { liveActions, liveMessages, parseMessagesJson } from "./messages.ts";
import type { Notifier } from "./notifier.ts";
import { pendingPicks } from "./pendingPick.ts";
import type { PresenceMonitor } from "./presence.ts";
import { fitEvent, fitPrompts } from "./promptFit.ts";
import {
  commandRouteOf,
  processAlive,
  publicSession,
  type Registry,
  type SessionRecord,
} from "./registry.ts";
import { withoutIdeContext } from "./render.ts";
import { type ReplyQueue, reasonOfPause, type WaitReason } from "./replyQueue.ts";
import { SentMessages } from "./sentMessages.ts";
import { slashCommandsFor } from "./slashCommands.ts";
import { StartError, sessionDirectories, startSession } from "./startSession.ts";
import { liveStep, parseStepsJson } from "./steps.ts";
import { StopError, type TurnStopper } from "./stop.ts";
import type { TerminalLauncher } from "./terminalHost.ts";
import { withoutOutput } from "./timeline.ts";
import {
  TRANSCRIPT_TURN_PREFIX,
  transcriptPathFor,
  transcriptTurns,
  transcriptTurnText,
  withoutRecordedCopies,
} from "./transcript.ts";

export interface RpcDeps {
  /** Sends for a chat wait while it moves to the person's terminal. */
  handover?: Handover;
  db: DB;
  events: EventLog;
  registry: Registry;
  broker: Broker;
  presence: PresenceMonitor;
  config: RelayConfig;
  /** Present when APNs or FCM is configured. */
  notifier?: Notifier | null;
  /** The real `claude` binary, for `session.start`; null or missing: starting isn't available. */
  claudeBin?: string | null;
  /** Where `session.start` runs a new session so the helper can type into it; missing: `claude --bg`. */
  terminal?: TerminalLauncher | null;
  /** The phone's Stop (session.interrupt). */
  stopper?: TurnStopper;
  /** Replies Claude Code holds at the Mac (held-replies). */
  held?: HeldReplies;
  /** Replies waiting for the Mac to be unlocked (desktop-ide-delivery). */
  replies?: ReplyQueue;
  /** Photos and files from the phone (attachments). */
  attachments?: AttachmentStore;
  /** How replies reach terminals; tests swap them. */
  typeOps?: TypeOps;
  /** How long `session.send` waits for a pause itself before the reply queue takes over; tests shorten it. */
  pauseWait?: { inlineMs: number; pollMs: number };
  /** Claude Code processes the helper owns for sessions continued without a terminal (`session.resume`). */
  headless?: HeadlessSessions;
  /** Whether a session's conversation is still on disk, so it can be resumed; tests replace the check. */
  hasTranscript?: (session: SessionRecord) => boolean;
}

/** How long `session.send` waits for a typing pause before answering "queued"; well inside the phone's 20 s timeout. */
export const INLINE_PAUSE_WAIT = { inlineMs: 12_000, pollMs: 500 };

export type RpcOutcome = { result: unknown } | { error: RpcError };

/**
 * `overRelay`: the reply goes in one relay frame, so long prompt texts in it are cut. Direct callers pass none.
 * `pieces`: the phone reassembles pieces, so a reply of any size is sent whole and nothing is cut.
 */
export type RpcOpts = { overRelay?: boolean; pieces?: boolean };

type Handler<M extends RpcMethod> = (
  params: z.infer<(typeof RpcSchemas)[M]>,
  actor: string,
  opts: RpcOpts,
) => Promise<unknown> | unknown;

class RpcFailure extends Error {
  constructor(
    readonly code: RpcError["code"],
    message: string,
    /** The session can be continued with `session.resume` (RpcError.canResume). */
    readonly canResume?: true,
  ) {
    super(message);
  }
}

/** Newest-first items, oldest dropped until the JSON fits one reply. */
function fitReply<T>(items: T[], opts: RpcOpts, reserve = 0): T[] {
  if (opts.pieces) return items;
  let size = 2 + reserve;
  const kept: T[] = [];
  for (const item of opts.overRelay ? items.map(withoutStepOutputs) : items) {
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

/** A turn for a phone that doesn't reassemble pieces: its steps without their command output. */
function withoutStepOutputs<T>(item: T): T {
  const steps = (item as { steps?: TurnStep[] }).steps;
  return steps?.some((s) => s.output !== undefined) ? { ...item, steps: steps.map(withoutOutput) } : item;
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

type RpcCall = (method: string, params: unknown, actor: string, opts?: RpcOpts) => Promise<RpcOutcome>;

export type DaemonRpc = RpcCall & {
  /** Types the model and effort picks that waited for Claude to go idle; the daemon calls it before it drains queued replies. */
  applyPicks: (sessionId?: string) => Promise<void>;
};

/** Claude started working between the check and the typing: the pick waits. */
class StillBusy extends Error {}

export function createRpc(d: RpcDeps): DaemonRpc {
  async function resumeSession(
    { sessionId, text }: { sessionId: string; text: string },
    actor: string,
    onWritten?: () => void,
  ): Promise<SessionResumed> {
    const session = d.registry.get(sessionId);
    if (!session) throw new RpcFailure("not_found", "session not found");
    if (!d.headless) throw new RpcFailure("unavailable", "Sessions can't be continued on this computer.");
    if (d.headless.has(sessionId))
      throw new RpcFailure("conflict", "This session already runs in Relay. Send the message as a reply.");
    // Never a second copy of a session that is still alive: its terminal, app or editor has the process.
    if (session.pid !== null && processAlive(session.pid))
      throw new RpcFailure(
        "conflict",
        "This session is still running on the computer. Reply to it instead of continuing it again.",
      );
    if (session.status !== "ended" && session.pid === null)
      throw new RpcFailure(
        "conflict",
        "This session is still listed as running. Reply to it instead of continuing it again.",
      );
    if (!hasTranscript(session))
      throw new RpcFailure("not_found", "This session's conversation is no longer on the computer.");
    await inOrder(sessionId, async () => {
      notePhoneTyped(sessionId, text, false, undefined, true);
      try {
        await (d.headless as HeadlessSessions).resume(session, text, onWritten);
      } catch (err) {
        dropPhoneTyped(sessionId, text);
        if (err instanceof ResumeError) throw new RpcFailure(err.code, err.message);
        throw err;
      }
    });
    audit(d.db, actor, "session.resume", { sessionId, chars: text.length });
    return { via: "headless" } satisfies SessionResumed;
  }

  /** The turn a session is working on right now, or null. */
  const liveTurn = (sessionId: string, opts: RpcOpts) => {
    const shown = opts.overRelay && !opts.pieces ? withoutOutput<TurnStep> : (a: TurnStep) => ({ ...a });
    const row = d.db
      .query(
        "SELECT id, prompt, started_at FROM turns WHERE session_id = ? AND ended_at IS NULL AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(sessionId) as { id: string; prompt: string | null; started_at: number } | null;
    if (!row) return null;
    const step = liveStep(sessionId, row.id);
    const files = attachmentFields(d.db, sessionId, row.prompt, row.id);
    const messages = liveMessages(sessionId, row.id);
    const actions = liveActions(sessionId, row.id);
    return {
      turnId: row.id,
      prompt: row.prompt ?? "",
      startedAt: row.started_at,
      ...files,
      ...(step ? { step } : {}),
      ...(messages.length ? { messages } : {}),
      ...(actions.length ? { actions: actions.map(shown) } : {}),
    };
  };

  const handlers: { [M in RpcMethod]: Handler<M> } = {
    sync: ({ sinceSeq }, _actor, opts) => {
      const oldest = d.events.oldestSeq();
      const latestSeq = d.events.latestSeq();
      // Too far behind (events pruned) or first connect: send a snapshot plus the current seq.
      if (sinceSeq === 0 || sinceSeq < oldest - 1) {
        const sessions = d.registry.list().map(publicSession);
        const presence = d.presence.get();
        // The prompts get what the sessions and presence leave of one reply; long texts in them are cut if needed.
        const room = REPLY_DATA_BYTES - Buffer.byteLength(JSON.stringify({ sessions, presence })) - 1024;
        return {
          snapshot: {
            sessions,
            prompts:
              opts.overRelay && !opts.pieces
                ? fitPrompts(d.broker.listOpen(), Math.max(room, 0), "first")
                : d.broker.listOpen(),
            presence,
          },
          events: [],
          latestSeq,
        };
      }
      // A replay cut by count or size says so, and its latestSeq is the last event sent, so the phone asks again.
      const page = d.events.syncPage(sinceSeq, {
        maxBytes: REPLY_DATA_BYTES,
        keepOversized: opts.pieces,
        fit: opts.overRelay && !opts.pieces ? fitEvent : undefined,
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

    "sessions.directories": () => sessionDirectories(d.db),

    "session.start": async ({ directory, text, name }, actor) => {
      try {
        const { sessionId } = await startSession({
          db: d.db,
          registry: d.registry,
          claudeBin: d.claudeBin,
          terminal: d.terminal,
          directory,
          ...(text === undefined ? {} : { text }),
          ...(name ? { name } : {}),
        });
        // The directory and the length, never the message.
        audit(d.db, actor, "session.start", { sessionId, directory, chars: text?.length ?? 0 });
        return { sessionId } satisfies SessionStarted;
      } catch (err) {
        if (err instanceof StartError) {
          // Launched but the session wasn't found: still a start, audited without the message.
          if (err.launched)
            audit(d.db, actor, "session.start", {
              ...(err.launched.shortId ? { sessionId: err.launched.shortId } : {}),
              directory,
              chars: text?.length ?? 0,
            });
          throw new RpcFailure(err.code, err.message);
        }
        throw err;
      }
    },

    "session.resume": async (params, actor) => {
      const { sessionId, sendId } = params;
      // A repeat (the first call's reply was lost, or it is still starting Claude Code) never starts a second message.
      if (sendId) {
        const earlier = sent.get(sessionId, sendId);
        if (earlier && (await earlier.catch(() => null))) return { via: "headless" } satisfies SessionResumed;
      }
      if (!sendId) return await resumeSession(params, actor);
      const k = `${sessionId}\u0000${sendId}`;
      let written: (ok: boolean) => void = () => {};
      resumeWritten.set(
        k,
        new Promise<boolean>((resolve) => {
          written = resolve;
        }),
      );
      const resuming = resumeSession(params, actor, () => written(true));
      // A start that fails after the write ends the process and forgets the id: the phone watches for the turn and
      // offers Try Again as a new send if none comes.
      const done = () => {
        written(false);
        resumeWritten.delete(k);
      };
      resuming.then(done, done);
      return await sent.track(sessionId, sendId, resuming);
    },

    "session.turns": ({ sessionId, limit, before, withLive }, _actor, opts) => {
      const page = (reserve: number) => {
        // Inclusive of `before`: a turn closed by the next prompt ends exactly when that one started.
        const rows = d.db
          .query(
            "SELECT * FROM turns WHERE session_id = ? AND ended_at IS NOT NULL AND ended_at <= ? ORDER BY ended_at DESC LIMIT ?",
          )
          .all(sessionId, before ?? Number.MAX_SAFE_INTEGER, limit) as TurnRow[];
        const recorded = rows.map((r) => ({
          ...toTurn(r),
          ...attachmentFields(d.db, sessionId, r.prompt, r.id),
        }));
        if (recorded.length >= limit) return fitReply(recorded, opts, reserve);
        // Fill older history (before Relay's hooks saw this session) from Claude Code's transcript.
        const session = d.registry.get(sessionId);
        const path = session ? transcriptPathFor(session) : null;
        if (!session || !path) return fitReply(recorded, opts, reserve);
        const oldest = recorded.length ? Math.min(...recorded.map((t) => t.startedAt ?? t.endedAt)) : before;
        const older = transcriptTurns(sessionId, path, {
          limit: limit - recorded.length,
          previewChars: d.config.previewChars,
          working: session.status === "working" && recorded.length === 0,
          before: oldest,
          cwd: session.cwd,
        });
        // A turn with no known start can't be matched to its transcript copy by time; match by answer.
        const startless = d.db
          .query(
            "SELECT summary, ended_at FROM turns WHERE session_id = ? AND started_at IS NULL AND ended_at IS NOT NULL",
          )
          .all(sessionId) as { summary: string | null; ended_at: number }[];
        return fitReply(
          [
            ...recorded,
            ...withoutRecordedCopies(older, startless).map((t) => ({
              ...t,
              ...attachmentFields(d.db, sessionId, t.prompt),
            })),
          ],
          opts,
          reserve,
        );
      };
      if (!withLive) return page(0);
      // A phone that asked for it gets the running turn in the same reply, so opening a chat is one round trip.
      const live = liveTurn(sessionId, opts);
      return { turns: page(Buffer.byteLength(JSON.stringify(live)) + 32), live };
    },

    "session.send": async ({ sessionId, text: message, attachments: ids, sendId }, actor) => {
      // A retried message gets the first answer, never typed twice; a failed one is sent again.
      if (sendId) {
        for (;;) {
          const earlier = sent.get(sessionId, sendId);
          if (!earlier) break;
          const first = await earlier.catch(() => null);
          if (!first) continue;
          audit(d.db, actor, "session.send", { sessionId, via: first.via, repeat: true });
          // Still waiting: why, as of now.
          const reason = first.via === "queued" ? d.replies?.reasonOf(sessionId) : undefined;
          const held = first.via === "socket" && d.held?.isHeld(sessionId);
          return {
            via: first.via,
            ...(reason ? { reason } : {}),
            ...(held ? { heldAtMac: true as const } : {}),
            repeat: true,
          } satisfies SendResult;
        }
      }
      const sending = send(sessionId, message, ids, actor, sendId);
      return await (sendId ? sent.track(sessionId, sendId, sending) : sending);
    },

    "session.delivered": async ({ sessionId, sendId }) => {
      const pending = sent.get(sessionId, sendId)?.catch(() => null);
      const wrote = resumeWritten.get(`${sessionId}\u0000${sendId}`);
      // A resume whose text is already on stdin counts as delivered while it still waits for system/init.
      const first = pending
        ? await Promise.race([
            pending,
            wrote?.then((ok) => (ok ? { via: "headless" as const } : pending)) ?? pending,
          ])
        : null;
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

    "attachment.discard": async (params, actor) => {
      // A send that has taken its turn holds this file until it has delivered (or failed): wait, then delete.
      while (held.has(params.id)) await held.get(params.id);
      // A message that waits in the reply queue is typed later with this file's path: keep the file until then.
      const saved = d.attachments?.savedFile(params.id);
      if (saved && d.replies?.list(saved.sessionId).some((r) => r.text.includes(saved.path)))
        throw new RpcFailure("conflict", "A message that includes this file is waiting to be sent.");
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

    "session.model": async ({ sessionId, model, effort }, actor) => {
      const queue = () => {
        pendingPicks.set(sessionId, model !== undefined ? "model" : "effort", (model ?? effort) as string);
        d.registry.publish(sessionId);
        audit(d.db, actor, "session.model", { sessionId, model, effort, via: "queued" });
        return { via: "queued" } satisfies ModelResult;
      };
      const session = d.registry.get(sessionId);
      if (!session || session.status === "ended")
        throw new RpcFailure("not_found", "This session has ended.");
      // A message already waiting goes after the pick, which the queue timer types first.
      // A pick already waiting keeps its place: typing this one now would let the older one overwrite it later.
      const waiting = pendingPicks.ids().includes(sessionId);
      if (waiting || modelBusy(sessionId) || (d.replies && d.replies.list(sessionId).length > 0))
        return queue();
      try {
        const res = await typePick(sessionId, model, effort);
        // Claude Code reports the model itself (PostModelSwitch); the effort comes with the status line.
        audit(d.db, actor, "session.model", { sessionId, model, effort, via: res.via });
        return { via: res.via } satisfies ModelResult;
      } catch (err) {
        if (err instanceof StillBusy) return queue();
        throw err;
      }
    },

    "session.commands": ({ sessionId }) => {
      const session = d.registry.get(sessionId);
      if (!session) throw new RpcFailure("not_found", "session not found");
      const route = d.headless?.has(session.id)
        ? "helper"
        : (commandRouteOf(session) ?? (canResume(session) ? "resume" : null));
      return {
        commands: slashCommandsFor(session.cwd),
        run: route !== null && route !== "inbox",
        ...(route ? { route } : {}),
      } satisfies SessionCommands;
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

    "prompts.open": (_params, _actor, opts) =>
      opts.overRelay && !opts.pieces
        ? fitPrompts(d.broker.listOpen(), REPLY_DATA_BYTES, "first")
        : d.broker.listOpen(),

    "prompts.recent": ({ limit }, _actor, opts) =>
      opts.overRelay && !opts.pieces ? fitPrompts(d.broker.listRecent(limit)) : d.broker.listRecent(limit),

    "turn.full": ({ turnId, offset }, _actor, opts) => {
      const piece = (text: string) => (opts.pieces ? { text: text.slice(offset) } : textPiece(text, offset));
      if (turnId.startsWith(TRANSCRIPT_TURN_PREFIX)) {
        const [sessionId, uuid] = turnId.slice(TRANSCRIPT_TURN_PREFIX.length).split(":");
        const session = sessionId ? d.registry.get(sessionId) : null;
        const path = session ? transcriptPathFor(session) : null;
        const text = path && uuid ? transcriptTurnText(path, uuid) : null;
        if (text === null) throw new RpcFailure("not_found", "turn not found");
        return piece(text);
      }
      const row = d.db.query("SELECT full_text FROM turns WHERE id = ?").get(turnId) as {
        full_text: string | null;
      } | null;
      if (!row) throw new RpcFailure("not_found", "turn not found");
      return piece(row.full_text ?? "");
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
      // Both services use apns_token; only APNs (hex) tokens are lowercased, FCM ones are case-sensitive.
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

    "session.live": ({ sessionId }, _actor, opts) => liveTurn(sessionId, opts),

    "push.key": (_params, actor) => {
      const deviceId = actor.startsWith("device:") ? actor.slice("device:".length) : null;
      if (!deviceId) throw new RpcFailure("bad_request", "only a paired device has a push key");
      return { key: ensurePushKey(d.db, deviceId) };
    },

    "push.test": async () => {
      if (!d.notifier)
        throw new RpcFailure("unavailable", "push is not configured: pair this computer with a relay");
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
  /** Per resume with a sendId: settles true once its text is on stdin, false when the resume ends without that. */
  const resumeWritten = new Map<string, Promise<boolean>>();

  /** session.send without its `sendId`: checks the message, then types it in (or queues it) after earlier ones. */
  async function send(
    sessionId: string,
    message: string,
    ids: string[] | undefined,
    actor: string,
    sendId?: string,
  ): Promise<SendResult> {
    const arrived = Date.now();
    const withFiles = (ids?.length ?? 0) > 0;
    if (!withFiles && !message) throw new RpcFailure("bad_request", words.empty);
    const session = d.registry.get(sessionId);
    // A session the helper is continuing right now still reads 'ended' until its process announces itself.
    const gone = (s: SessionRecord | null | undefined): boolean =>
      !s || (s.status === "ended" && !d.headless?.has(sessionId));
    const goneError = (s: SessionRecord | null | undefined) =>
      new RpcFailure(
        "not_found",
        withFiles ? words.sessionGone : "session not found or ended",
        s && canResume(s) ? true : undefined,
      );
    if (!session || gone(session)) throw goneError(session);
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
    if (pendingPicks.ids().includes(sessionId)) await applyPicks(sessionId);
    // One send per session at a time, so messages waiting for a pause arrive in the order they were sent.
    return await inOrder(sessionId, async () => {
      // A chat moving to the person's terminal has no typing route until it is done; then the new one counts.
      await d.handover?.settled(sessionId);
      // Waited behind a resume that failed: the session is still ended.
      const now = d.registry.get(sessionId);
      if (!now || gone(now)) throw goneError(now);
      // A file discarded while this message waited its turn: refuse whole rather than hand over a path that is gone.
      if (withFiles) attempt(() => attachmentsOrFail().forSend(sessionId, ids ?? []));
      // From here to the end of the delivery a discard of these files waits (no await between the check and the hold).
      let release = (): void => {};
      if (withFiles) {
        const done = new Promise<void>((resolve) => {
          release = resolve;
        });
        for (const id of ids ?? []) held.set(id, done);
      }
      try {
        const res = await sendNow(now, text, arrived, sendId);
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
        if (err instanceof DeliveryError)
          throw new RpcFailure("unavailable", err.message, canResume(session) ? true : undefined);
        throw err;
      } finally {
        if (withFiles) for (const id of ids ?? []) held.delete(id);
        release();
      }
    });
  }

  const hasTranscript = d.hasTranscript ?? ((s: SessionRecord) => transcriptPathFor(s) !== null);

  /** The session has no live Claude Code process and its conversation is on disk: `session.resume` can continue it. */
  function canResume(session: SessionRecord): boolean {
    if (!d.headless || !d.claudeBin || d.headless.has(session.id)) return false;
    if (session.pid !== null && processAlive(session.pid)) return false;
    if (session.status !== "ended" && session.pid === null) return false;
    return hasTranscript(session);
  }

  const sending = new Map<string, Promise<unknown>>();
  /** Attachment ids a send is delivering right now, each with a promise that settles when that send is over. */
  const held = new Map<string, Promise<void>>();

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

  /** Types the message in or sends it by another route; after a few seconds' wait for a pause it is queued (`via: "queued"`). */
  async function sendNow(
    session: SessionRecord,
    text: string,
    arrived: number,
    sendId?: string,
  ): Promise<{ via: string; reason?: WaitReason; heldAtMac?: true }> {
    const sessionId = session.id;
    // A session the helper runs itself: no terminal to wait for, the message goes straight to its process.
    if (d.headless?.has(sessionId)) {
      notePhoneTyped(sessionId, text, false, sendId, true);
      try {
        return await deliver(
          session,
          text,
          { idleSeconds: null, userTypingNow: false, preferTyping: false, headless: d.headless },
          d.typeOps,
        );
      } catch (err) {
        dropPhoneTyped(sessionId, text);
        throw err;
      }
    }
    const waiting = d.replies?.list(sessionId) ?? [];
    // Replies already waiting go first: keep the order the person sent them in.
    if (d.replies && waiting.length > 0) {
      d.replies.add(sessionId, text, arrived, waiting[waiting.length - 1]?.waitsFor, sendId);
      return queued(d.replies.reasonOf(sessionId));
    }
    const timing = d.pauseWait ?? INLINE_PAUSE_WAIT;
    for (;;) {
      // Fresh reading, not the 5 s presence poll: never type into a terminal while you are typing.
      const { idleSeconds, locked } = await platform.presence.read({
        tmuxSockets: session.tmuxSocket ? [session.tmuxSocket] : [],
      });
      const waited = Date.now() - arrived;
      // Before typing: the UserPromptSubmit hook arrives before deliver() returns and must know it came from the phone.
      notePhoneTyped(sessionId, text, true, sendId);
      // Watching for the hook before the post: a message through the inbox that Claude Code doesn't take is held.
      const watch = d.held?.expect(sessionId, `${PHONE_PREFIX}\n${text}`, { sendId });
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
            headless: d.headless,
          },
          d.typeOps,
        );
        phoneTypeDelivered(sessionId, text);
        if (res.submitted === false) {
          const name = session.name ?? session.project ?? "the session";
          d.events.emit({
            type: "session.notice",
            sessionId,
            level: "error",
            text: `Your message to ${name} was typed but not sent. Press Enter at the computer, or send it again.`,
          });
        }
        if (res.via !== "socket") watch?.cancel();
        else if (watch && (await watch.wait())) return { ...res, heldAtMac: true };
        return res;
      } catch (err) {
        watch?.cancel();
        // Nothing was typed: a prompt the person types at the Mac next must not match this message.
        dropPhoneTyped(sessionId, text);
        if (err instanceof WaitForUnlock && d.replies) {
          d.replies.add(sessionId, text, arrived, "unlock", sendId);
          d.replies.setReason(sessionId, "locked");
          return queued("locked");
        }
        // The chat moved to the person's terminal while this was typing into the one Relay ran: send it there.
        const moved = d.registry.get(sessionId);
        if (session.ptySocket && moved && moved.ptySocket !== session.ptySocket && moved.status !== "ended")
          return sendNow(moved, text, arrived, sendId);
        if (!(err instanceof WaitForPause)) throw err;
        // `relay shell` already waited up to 15 s for you to stop typing in that tab: don't ask it again here.
        const wait = Math.max(timing.pollMs, err.retryInMs ?? 0);
        const again =
          !(err.route === "pty" && err.reason === "typing") &&
          Date.now() - arrived + wait < timing.inlineMs &&
          !d.broker.hasOpen(sessionId);
        if (again || !d.replies) {
          await Bun.sleep(wait);
          continue;
        }
        log.info("waiting to type", { sessionId, route: err.route, reason: err.reason });
        d.replies.add(sessionId, text, arrived, "pause", sendId);
        const why = reasonOfPause(err);
        if (why) d.replies.setReason(sessionId, why);
        if (err.retryInMs !== undefined) d.replies.retryIn(sessionId, err.retryInMs);
        return queued(why ?? undefined);
      }
    }
  }

  /** The answer for a message that waits: why too, when the helper knows. */
  function queued(reason: WaitReason | undefined): { via: string; reason?: WaitReason } {
    return reason ? { via: "queued", reason } : { via: "queued" };
  }

  /** Claude is working or waiting for an answer: the prompt isn't free for a command. */
  const modelBusy = (sessionId: string) =>
    d.registry.get(sessionId)?.status === "working" || d.broker.hasOpen(sessionId);

  /** Types `/model` or `/effort` into the session once it's idle; throws `StillBusy` when Claude started working meanwhile. */
  async function typePick(sessionId: string, model: string | undefined, effort: string | undefined) {
    const command = model !== undefined ? `/model ${model}` : `/effort ${effort}`;
    return await inOrder(sessionId, async () => {
      const session = d.registry.get(sessionId);
      if (!session || session.status === "ended")
        throw new RpcFailure("not_found", "This session has ended.");
      if (modelBusy(sessionId)) throw new StillBusy();
      const { idleSeconds, locked } = await platform.presence.read({
        tmuxSockets: session.tmuxSocket ? [session.tmuxSocket] : [],
      });
      try {
        const resultsBefore = model !== undefined ? await modelResultsOnScreen(session, d.typeOps) : 0;
        const delivered = await deliver(
          session,
          command,
          {
            idleSeconds,
            userTypingNow: idleSeconds !== null && idleSeconds < 8,
            preferTyping: true,
            locked: locked === true,
            terminalOnly: true,
          },
          d.typeOps,
        );
        // Answered before the next queued message is typed, which would land in the question.
        if (model !== undefined) {
          const answer = await confirmModelSwitch(session, delivered.via, model, d.typeOps, resultsBefore);
          if (answer === "other")
            throw new RpcFailure("conflict", "The computer is asking something else. Answer it there.");
        }
        return delivered;
      } catch (err) {
        if (err instanceof WaitForPause)
          throw new RpcFailure(
            "conflict",
            err.reason === "draft"
              ? "There is text in the prompt at the computer. Send or clear it first."
              : "Someone is typing at the computer. Try again in a moment.",
          );
        if (err instanceof DeliveryError)
          throw new RpcFailure("unavailable", "This session can't be changed from the phone.");
        throw err;
      }
    });
  }

  const applyingPicks = new Map<string, Promise<boolean>>();

  /** Types the picks made while Claude worked (or one session's) as soon as it is idle; a failure drops them and tells the phone why. */
  async function applyPicks(only?: string): Promise<void> {
    for (const id of only ? [only] : pendingPicks.ids()) {
      // One run per session: a caller arriving mid-pick waits for it, then looks again for picks queued meanwhile.
      while (pendingPicks.ids().includes(id)) {
        const running = applyingPicks.get(id);
        if (running) {
          await running;
          continue;
        }
        const run = applyPicksFor(id).finally(() => applyingPicks.delete(id));
        applyingPicks.set(id, run);
        if (!(await run)) break;
      }
    }
  }

  async function applyPicksFor(id: string): Promise<boolean> {
    const session = d.registry.get(id);
    if (!session || session.status === "ended") {
      pendingPicks.clear(id);
      return true;
    }
    if (modelBusy(id)) return false;
    try {
      for (const kind of ["model", "effort"] as const) {
        const value = pendingPicks.get(id)[kind];
        if (value === undefined) continue;
        const res = await typePick(
          id,
          kind === "model" ? value : undefined,
          kind === "effort" ? value : undefined,
        );
        // A newer pick that arrived while this one was typed stays queued.
        if (pendingPicks.get(id)[kind] === value) pendingPicks.clear(id, kind);
        d.registry.publish(id);
        audit(d.db, "queue", "session.model", { sessionId: id, [kind]: value, via: res.via });
      }
    } catch (err) {
      if (err instanceof StillBusy) return false;
      const message =
        err instanceof RpcFailure && err.message ? err.message : "Couldn't change the model. Try again.";
      if (!(err instanceof RpcFailure)) log.error("queued pick failed", { err: errMessage(err) });
      pendingPicks.clear(id);
      pendingPicks.refuse(id, message);
      d.registry.publish(id);
      pendingPicks.clearRefusal(id);
    }
    return true;
  }

  function attachmentsOrFail(): AttachmentStore {
    if (!d.attachments) throw new RpcFailure("unavailable", "Files can't be sent to this computer.");
    return d.attachments;
  }

  const call: RpcCall = async (method, params, actor, opts = {}) => {
    // Own keys only: "toString", "constructor" and "__proto__" are `in` every object.
    if (!Object.hasOwn(RpcSchemas, method))
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
      return { result: await handler(parsed.data as never, actor, opts) };
    } catch (err) {
      if (err instanceof RpcFailure)
        return {
          error: {
            code: err.code,
            message: err.message,
            ...(err.canResume ? { canResume: true as const } : {}),
          },
        };
      log.error("rpc failed", { method, err: errMessage(err) });
      return { error: { code: "internal", message: "internal error" } };
    }
  };
  return Object.assign(call, { applyPicks });
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
