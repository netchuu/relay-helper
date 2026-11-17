import type { Prompt, RelayEvent, Turn } from "../../../protocol/index.ts";
import { errMessage, log } from "../log.ts";
import { runsInBackground } from "./background.ts";
import type { Broker } from "./broker.ts";
import type { DB } from "./db.ts";
import { hasShortenedCd } from "./decisions.ts";
import type { EventLog } from "./events.ts";
import { type Fcm, type FcmMessage, isDeadFcmToken } from "./fcm.ts";
import type { PresenceMonitor } from "./presence.ts";
import { type Apns, type ApnsEnvironment, isDeadToken } from "./push.ts";
import { redact } from "./redact.ts";
import type { Registry } from "./registry.ts";
import { sealForPhone } from "./relayPush.ts";
import { firstLine } from "./render.ts";
import { head } from "./text.ts";

/** Notification categories the iOS app registers; Android maps the same. */
export const Category = {
  question: "QUESTION",
  plan: "PLAN",
  permission: "PERMISSION",
  permissionAlways: "PERMISSION_ALWAYS",
  /** Only "Review…" (opens the app) and Deny: for approvals the notification can't show in full. */
  permissionReview: "PERMISSION_REVIEW",
  done: "DONE",
  notice: "NOTICE",
} as const;

export type PushPlatform = "apns" | "fcm";

interface PushTarget {
  id: string;
  apns_token: string;
  apns_env: ApnsEnvironment;
  push_platform: PushPlatform;
  push_key: string | null;
}

/** The parts of the senders the notifier uses, so tests can stand in for Apple and Google. */
export interface PushSenders {
  apns?: Pick<Apns, "send"> | null;
  fcm?: Pick<Fcm, "send"> | null;
}

export interface Alert {
  title: string;
  body: string;
  category: string;
  threadId: string;
  collapseId?: string;
  data: Record<string, unknown>;
  /** Lets the Notification Service Extension turn question options into buttons. */
  mutable?: boolean;
}

/** The visible text Apple, Google and the relay see; the phone shows the decrypted text instead. */
export const GENERIC_ALERT = { title: "Relay", body: "New activity on your Mac" } as const;

/** The alert for a phone without a push key: no text, which would cross Apple, Google and the relay in plaintext. */
export const contentFreeAlert = (): Alert => ({
  ...GENERIC_ALERT,
  category: Category.notice,
  threadId: "relay",
  collapseId: "relay-activity",
  data: {},
});

const clip = (s: string, n: number) => (s.length > n ? `${head(s, n - 1)}…` : s);

/** Builds the alert for an event, or null when it isn't worth a push. Pure, so it is unit tested. */
export function alertFor(event: RelayEvent, sessionName: (id: string) => string): Alert | null {
  switch (event.type) {
    case "prompt.opened":
      return promptAlert(event.prompt, sessionName(event.prompt.sessionId));
    case "turn.done":
      // You stopped it yourself: nothing to tell you.
      if (event.turn.stopped) return null;
      return turnAlert(event.turn, sessionName(event.turn.sessionId));
    case "session.notice":
      if (event.level === "info") return null;
      return {
        title: sessionName(event.sessionId),
        body: clip(event.text, 180),
        category: Category.notice,
        threadId: event.sessionId,
        data: { sessionId: event.sessionId },
      };
    default:
      return null;
  }
}

export function promptAlert(prompt: Prompt, name: string): Alert {
  const base = {
    threadId: prompt.sessionId,
    collapseId: prompt.id,
    data: { promptId: prompt.id, sessionId: prompt.sessionId, kind: prompt.kind },
  };
  switch (prompt.payload.kind) {
    case "question": {
      const [first, ...rest] = prompt.payload.questions;
      const simple =
        prompt.payload.questions.length === 1 && first && !first.multiSelect && first.options.length <= 4;
      return {
        ...base,
        title: `${name} asks`,
        body: clip(`${first?.question ?? "A question"}${rest.length ? ` (+${rest.length} more)` : ""}`, 180),
        category: Category.question,
        mutable: Boolean(simple),
        data: {
          ...base.data,
          // Only a single, single-choice question can be answered with buttons.
          ...(simple && first
            ? { question: first.question, options: first.options.map((o) => clip(o.label, 40)) }
            : {}),
        },
      };
    }
    case "plan": {
      const steps = prompt.payload.plan.split("\n").filter((l) => /^\s*(\d+\.|[-*])\s/.test(l)).length;
      return {
        ...base,
        title: `${name} has a plan`,
        body: clip(`${firstLine(prompt.payload.plan, 120)}${steps ? ` · ${steps} steps` : ""}`, 180),
        category: Category.plan,
      };
    }
    case "permission": {
      const shown = redact(prompt.payload.summary || prompt.payload.toolName);
      return {
        ...base,
        title: `${name} wants to run ${prompt.payload.toolName}`,
        body: clip(shown, 180),
        category: needsReview(prompt.payload.toolName, prompt.payload.summary, shown)
          ? Category.permissionReview
          : prompt.payload.canAlwaysAllow
            ? Category.permissionAlways
            : Category.permission,
      };
    }
  }
}

/** Allow from the lock screen only when the notification shows the whole request. */
export function needsReview(tool: string, summary: string, shown: string): boolean {
  if (shown !== summary || summary.length > 180 || summary.includes("\n")) return true;
  // A long `cd` was shortened on the card (decisions.ts): the whole command needs reading in the app.
  if (hasShortenedCd(summary)) return true;
  // For file writes the summary is only the path; the content needs reading.
  return ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool);
}

export function turnAlert(turn: Turn, name: string): Alert {
  return {
    title: turn.failed ? `${name} failed` : `${name} is done`,
    body: clip(firstLine(turn.summary, 180) || "Finished.", 180),
    category: Category.done,
    threadId: turn.sessionId,
    data: { sessionId: turn.sessionId, turnId: turn.id },
  };
}

/** Most plaintext UTF-8 bytes one sealed push may carry (relay limits: 4,096 APNs, 4,000 FCM data). */
export const MAX_SEALED_BYTES = 2800;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** The alert cut to fit MAX_SEALED_BYTES: question first, then buttons, then title and body. */
export function fitAlert(alert: Alert): Alert {
  const plain = (a: Alert) => ({ title: a.title, body: a.body, data: a.data });
  if (jsonBytes(plain(alert)) <= MAX_SEALED_BYTES) return alert;
  const question = alert.data.question;
  if (typeof question === "string") {
    const fits = (n: number) =>
      jsonBytes(plain({ ...alert, data: { ...alert.data, question: clip(question, n) } })) <=
      MAX_SEALED_BYTES;
    let lo = 0;
    let hi = question.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    if (fits(lo)) {
      return { ...alert, data: { ...alert.data, question: clip(question, lo) } };
    }
  }
  // Still too big (huge name, options or ids): the title and body only, and no buttons.
  const { question: _q, options: _o, ...rest } = alert.data;
  const bare: Alert = { ...alert, title: clip(alert.title, 100), body: clip(alert.body, 180), data: rest };
  if (jsonBytes(plain(bare)) <= MAX_SEALED_BYTES) return bare;
  return { ...bare, title: GENERIC_ALERT.title, body: GENERIC_ALERT.body, data: {} };
}

const sealAlert = (alert: Alert, pushKey: string): string => {
  const a = fitAlert(alert);
  return sealForPhone(pushKey, { title: a.title, body: a.body, data: a.data });
};

/** The APNs payload with the text sealed for one phone: Apple sees a generic alert, the category and a blob. */
export function sealedApnsPayload(alert: Alert, pushKey: string): object {
  return {
    aps: {
      alert: { ...GENERIC_ALERT },
      sound: "default",
      category: alert.category,
      "thread-id": alert.threadId,
      "mutable-content": 1,
    },
    relay: { v: 1, enc: sealAlert(alert, pushKey) },
  };
}

/** The FCM message with the text sealed for one phone; Google sees only the category and thread id. */
export function sealedFcmMessage(alert: Alert, pushKey: string): FcmMessage {
  return {
    data: {
      v: "1",
      enc: sealAlert(alert, pushKey),
      category: alert.category,
      threadId: alert.threadId,
    },
    android: {
      priority: "high",
      ...(alert.collapseId ? { collapse_key: alert.collapseId.slice(0, 64) } : {}),
      ttl: "3600s",
    },
  };
}

/** The APNs payload in plain text: pushAll uses it only for contentFreeAlert, which has nothing to hide. */
export function apnsPayload(alert: Alert): object {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      category: alert.category,
      "thread-id": alert.threadId,
      ...(alert.mutable ? { "mutable-content": 1 } : {}),
    },
    relay: alert.data,
  };
}

/** The plain-text FCM message, data-only; FCM data values must be strings, so `options` is a JSON string. */
export function fcmMessage(alert: Alert): FcmMessage {
  const data: Record<string, string> = {
    title: alert.title,
    body: alert.body,
    category: alert.category,
    threadId: alert.threadId,
  };
  for (const [key, value] of Object.entries(alert.data)) {
    if (value === undefined || value === null) continue;
    data[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return {
    data,
    android: {
      priority: "high",
      ...(alert.collapseId ? { collapse_key: alert.collapseId.slice(0, 64) } : {}),
      ttl: "3600s",
    },
  };
}

/** Pushes to paired phones while you are away from the Mac, never while you are at it. */
export class Notifier {
  private unsubscribe: (() => void) | null = null;
  private wasPresent = true;
  /** Open prompts the phone has already been told about (their own push, or a reminder). */
  private readonly told = new Set<string>();
  /** A "done" alert held back while background shells or agents still run; sent when the last ends. */
  private readonly heldDone = new Map<string, Alert>();

  constructor(
    private readonly db: DB,
    private readonly events: EventLog,
    private readonly presence: PresenceMonitor,
    private readonly registry: Registry,
    private readonly broker: Broker,
    private readonly senders: PushSenders,
  ) {}

  /** Whether pushes to devices on this platform can be sent at all. */
  supports(platform: PushPlatform): boolean {
    return Boolean(this.senders[platform]);
  }

  start(): void {
    this.wasPresent = this.presence.get().present;
    this.unsubscribe = this.events.subscribe((e) => void this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private name(sessionId: string): string {
    const s = this.registry.get(sessionId);
    return s?.name ?? s?.project ?? "Claude";
  }

  private async onEvent(event: RelayEvent): Promise<void> {
    try {
      if (event.type === "presence.changed") {
        const present = event.presence.present;
        // One reminder for waiting prompts the phone hasn't heard about.
        if (this.wasPresent && !present) {
          const open = this.broker.listOpen();
          const fresh = open.filter((p) => !this.told.has(p.id));
          const news = fresh.length > 0;
          for (const p of fresh) this.told.add(p.id);
          // A reminder that reached no phone leaves the prompts untold, so the next step away sends it again.
          const untellIfLost = (reached: number) => {
            if (reached === 0) for (const p of fresh) this.told.delete(p.id);
          };
          if (news && open.length === 1 && open[0])
            untellIfLost(await this.pushAll(promptAlert(open[0], this.name(open[0].sessionId))));
          else if (news && open.length > 1)
            untellIfLost(
              await this.pushAll({
                title: `${open.length} things are waiting for you`,
                body: [...new Set(open.map((p) => this.name(p.sessionId)))].join(", "),
                category: Category.notice,
                threadId: "relay",
                // A newer reminder replaces the older one instead of stacking.
                collapseId: "relay-waiting",
                data: {},
              }),
            );
        }
        this.wasPresent = present;
        return;
      }
      if (event.type === "prompt.closed") {
        this.told.delete(event.promptId);
        return;
      }
      if (event.type === "session.background") {
        if (event.tasks.length > 0) return;
        const held = this.heldDone.get(event.sessionId);
        this.heldDone.delete(event.sessionId);
        if (held && !this.presence.get().present) await this.pushAll(held);
        return;
      }
      if (event.type === "session.upsert" && event.session.status === "ended")
        this.heldDone.delete(event.session.id);
      if (this.presence.get().present) return;
      const alert = alertFor(event, (id) => this.name(id));
      if (!alert) return;
      if (event.type === "turn.done" && runsInBackground(event.turn.sessionId)) {
        this.heldDone.set(event.turn.sessionId, alert);
        return;
      }
      if (event.type === "prompt.opened") this.told.add(event.prompt.id);
      const reached = await this.pushAll(alert);
      if (reached === 0 && event.type === "prompt.opened") this.told.delete(event.prompt.id);
    } catch (err) {
      log.warn("push failed", { err: errMessage(err) });
    }
  }

  async pushAll(alert: Alert): Promise<number> {
    const targets = this.db
      .query(
        `SELECT id, apns_token, COALESCE(apns_env, 'sandbox') AS apns_env,
                COALESCE(push_platform, 'apns') AS push_platform, push_key
           FROM devices WHERE revoked_at IS NULL AND apns_token IS NOT NULL`,
      )
      .all() as PushTarget[];
    let sent = 0;
    for (const t of targets) {
      let result: { status: number; reason?: string };
      let dead: boolean;
      // Phones paired before push keys existed can't open sealed text: they get only that something happened.
      const generic = contentFreeAlert();
      if (t.push_platform === "fcm") {
        if (!this.senders.fcm) continue;
        const message = t.push_key ? sealedFcmMessage(alert, t.push_key) : fcmMessage(generic);
        result = await this.senders.fcm.send(t.apns_token, message);
        dead = isDeadFcmToken(result);
      } else {
        if (!this.senders.apns) continue;
        const payload = t.push_key ? sealedApnsPayload(alert, t.push_key) : apnsPayload(generic);
        result = await this.senders.apns.send(t.apns_token, t.apns_env, payload, {
          collapseId: t.push_key ? alert.collapseId : generic.collapseId,
        });
        dead = isDeadToken(result);
      }
      // The relay refused the sealed push (too large, say): the generic alert still tells the phone something is up.
      if (result.status !== 200 && !dead && t.push_key && (result.status === 400 || result.status === 413)) {
        log.warn("push rejected, sending the generic alert", {
          device: t.id,
          platform: t.push_platform,
          status: result.status,
          reason: result.reason,
        });
        if (t.push_platform === "fcm") {
          result = (await this.senders.fcm?.send(t.apns_token, fcmMessage(generic))) ?? result;
          dead = isDeadFcmToken(result);
        } else {
          result =
            (await this.senders.apns?.send(t.apns_token, t.apns_env, apnsPayload(generic), {
              collapseId: generic.collapseId,
            })) ?? result;
          dead = isDeadToken(result);
        }
      }
      if (result.status === 200) sent++;
      else if (dead) {
        this.db.query("UPDATE devices SET apns_token = NULL WHERE id = ?").run(t.id);
        log.info("forgot dead push token", {
          device: t.id,
          platform: t.push_platform,
          reason: result.reason,
        });
      } else
        log.warn("push rejected", {
          device: t.id,
          platform: t.push_platform,
          status: result.status,
          reason: result.reason,
        });
    }
    return sent;
  }
}
