import { existsSync, unlinkSync } from "node:fs";
import { ensureHome, isTestHelper, loadConfig, paths, resolveClaudeBin, VERSION } from "../config.ts";
import { RELAY_BIN } from "../install.ts";
import { askForAccessibility, axAllowed, setAccessibilityAskStore } from "../integrations/claudeDesktop.ts";
import { errMessage, log } from "../log.ts";
import { run } from "../platform/exec.ts";
import { watchAccessibility } from "./accessibilityWatch.ts";
import { startAppServer, startLocalServer } from "./api.ts";
import { AttachmentStore } from "./attachments.ts";
import { BackgroundTracker } from "./background.ts";
import { Broker } from "./broker.ts";
import { getSetting, openDb, setSetting } from "./db.ts";
import { loadOrCreateIdentity } from "./e2e.ts";
import { EventLog } from "./events.ts";
import { Fcm, loadFcmConfig } from "./fcm.ts";
import { HookHandler } from "./hooks.ts";
import { setKnownPids } from "./inject.ts";
import { MessageTracker } from "./messages.ts";
import { Notifier } from "./notifier.ts";
import { PresenceMonitor } from "./presence.ts";
import { Apns, loadApnsConfig } from "./push.ts";
import { Registry } from "./registry.ts";
import { RelayLink } from "./relayLink.ts";
import { RelayApns, RelayFcm } from "./relayPush.ts";
import { deliverQueued, ReplyQueue } from "./replyQueue.ts";
import { createRpc } from "./rpc.ts";
import { brewCandidates, SelfUpdater, underServiceManager } from "./selfUpdate.ts";
import { StepTracker } from "./steps.ts";
import { TurnStopper } from "./stop.ts";

export async function runDaemon(): Promise<void> {
  ensureHome();
  const config = loadConfig();
  const claudeBin = resolveClaudeBin(config);
  const db = openDb(paths.db);
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  setKnownPids(() => registry.list().flatMap((s) => (s.pid ? [s.pid] : [])));
  const broker = new Broker(db, events, (sessionId) => {
    // Keep the session's "waiting" status in sync with its open prompts.
    const s = registry.get(sessionId);
    if (!s || s.status === "ended") return;
    if (broker.hasOpen(sessionId)) {
      if (s.status !== "waiting") registry.setStatus(sessionId, "waiting");
    } else if (s.status === "waiting") registry.setStatus(sessionId, "working");
  });
  const presence = new PresenceMonitor(db, events, config.idleAwaySeconds);
  const apnsConfig = loadApnsConfig();
  let apns: Pick<Apns, "send"> | null = null;
  if (config.relayUrl) {
    // The hosted relay holds the app's APNs key; this Mac only signs its requests.
    apns = new RelayApns(config.relayUrl, loadOrCreateIdentity(paths.identity));
  } else if (apnsConfig) {
    try {
      apns = new Apns(apnsConfig);
    } catch (err) {
      log.warn("iOS push disabled: could not load the APNs key", { err: errMessage(err) });
    }
  }
  const fcmConfig = loadFcmConfig();
  let fcm: Pick<Fcm, "send"> | null = null;
  if (config.relayUrl) {
    // The hosted relay holds the Firebase key too; Android pushes go there, sealed for each phone.
    fcm = new RelayFcm(config.relayUrl, loadOrCreateIdentity(paths.identity));
  } else if (fcmConfig.problem) {
    log.warn("Android push disabled", { problem: fcmConfig.problem });
  } else if (fcmConfig.config) {
    try {
      fcm = new Fcm(fcmConfig.config);
    } catch (err) {
      log.warn("Android push disabled: could not load the FCM key", { err: errMessage(err) });
    }
  }
  const notifier = apns || fcm ? new Notifier(db, events, presence, registry, broker, { apns, fcm }) : null;
  const baseDeps = { db, events, registry, broker, presence, config, notifier };
  const steps = new StepTracker(events);
  const messages = new MessageTracker(events);
  const background = new BackgroundTracker(events);
  // The lists the phones last saw survive a restart (background-work).
  background.restore((id) => {
    const s = registry.get(id);
    return Boolean(s && s.status !== "ended");
  });
  const stopper = new TurnStopper({ db, events, registry, broker, config, steps, messages });
  const replies = new ReplyQueue(db, events, registry);
  // Claude desktop app users: macOS asks for the Accessibility relay needs to type replies in as them, at
  // startup and again (at most daily) when a reply needs it.
  setAccessibilityAskStore({
    get: () => getSetting<number | null>(db, "accessibility.askedAt", null),
    set: (at) => setSetting(db, "accessibility.askedAt", at),
  });
  // Never from a test helper (its own RELAY_HOME): test runs that reset it often would start one a minute.
  if (!isTestHelper()) {
    setTimeout(() => {
      const result = askForAccessibility();
      if (result !== "skipped") log.info("accessibility", { result });
    }, 3_000);
  }
  // Accessibility allowed or taken away: sessions are announced again, so the phone's "allow Relay in Accessibility"
  // hint goes away (or comes back) within about 10 s, without waiting for the session to do something.
  if (process.platform === "darwin" && !isTestHelper()) {
    watchAccessibility({
      check: axAllowed,
      onChange: (allowed) => {
        log.info("accessibility changed", { allowed });
        for (const s of registry.list()) if (s.status !== "ended") registry.publish(s.id);
      },
    });
  }
  // Photos and files from the phone (attachments): unfinished uploads go after an hour, saved files after 7 days.
  const attachments = new AttachmentStore(db, paths.attachments);
  const sweepAttachments = () => {
    try {
      const swept = attachments.sweep();
      if (swept.uploads || swept.files) log.info("attachments cleaned up", swept);
    } catch (err) {
      log.warn("attachments cleanup", { err: errMessage(err) });
    }
  };
  sweepAttachments();
  const deps = { ...baseDeps, stopper, steps, messages, background, replies, attachments };
  const hooks = new HookHandler(deps);
  const rpc = createRpc(deps);

  // Prompts from before a restart have no waiting hook any more; their terminals still show the dialog.
  broker.closeOrphans();

  if (existsSync(paths.hookSock)) {
    const alive = await fetch("http://relay/health", { unix: paths.hookSock }).then(
      () => true,
      () => false,
    );
    if (alive) throw new Error(`another relay daemon is already running (${paths.hookSock})`);
    unlinkSync(paths.hookSock);
  }

  const local = startLocalServer({
    socketPath: paths.hookSock,
    hooks,
    rpc,
    events,
    db,
    publicUrl: () => config.publicUrl,
  });
  const app = startAppServer({ port: config.port, rpc, events, db });
  presence.start();
  notifier?.start();
  let relayLink: RelayLink | null = null;
  if (config.relayUrl) {
    relayLink = new RelayLink(config.relayUrl, loadOrCreateIdentity(paths.identity), { rpc, events, db });
    relayLink.start();
  }

  const timers = [
    setInterval(() => broker.expire(config.promptTimeoutSeconds * 1000), 60_000),
    // Replies waiting for the unlock go out as soon as the Mac is unlocked; those waiting for a pause in your
    // typing, as soon as the keyboard is still (or after TYPE_ANYWAY_MS anyway).
    setInterval(
      () =>
        void replies.drain(
          presence.get().locked === true,
          deliverQueued({ preferTyping: config.preferTyping, hasOpenPrompt: (id) => broker.hasOpen(id) }),
        ),
      1_000,
    ),
    setInterval(() => events.prune(7 * 86_400_000), 3_600_000),
    setInterval(sweepAttachments, 10 * 60_000),
  ];
  if (claudeBin) {
    const reconcile = () =>
      registry
        .reconcile(claudeBin)
        // Esc at the computer: the turns it stopped end as stopped once Claude Code reports the session idle.
        .then(() => stopper.sweep())
        .catch((err) => log.warn("reconcile", { err: errMessage(err) }));
    void reconcile();
    timers.push(setInterval(reconcile, 20_000));
  } else {
    log.warn("claude binary not found; session list relies on hooks only");
  }

  // Exit code 75: systemd units from 0.5.0 restart only on failure; launchd restarts on any exit.
  const updater = new SelfUpdater({
    current: VERSION,
    candidates: brewCandidates(),
    ownBin: RELAY_BIN,
    run: async (cmd) => {
      const r = await run(cmd, { timeoutMs: 120_000 });
      return { code: r.code, out: r.out || r.err };
    },
    restartsOnExit: underServiceManager(),
    busy: () => broker.listOpen().length > 0,
    exit: () => shutdown("self-update", 75),
  });
  // A release build only: from source, `relay install` builds the checkout instead.
  if (VERSION !== "0.1.0") updater.start();

  log.info("relay daemon started", {
    version: VERSION,
    hookSock: paths.hookSock,
    app: `http://127.0.0.1:${config.port}`,
    claudeBin,
    push: apns ? apnsConfig?.bundleId : "off",
    fcm: !fcm ? "off" : config.relayUrl ? "relay" : fcmConfig.config?.project_id,
    relay: config.relayUrl ?? "off",
  });

  const shutdown = (signal: string, code = 0) => {
    log.info("shutting down", { signal });
    updater.stop();
    for (const t of timers) clearInterval(t);
    presence.stop();
    relayLink?.stop();
    local.stop(true);
    app.stop(true);
    try {
      unlinkSync(paths.hookSock);
    } catch {
      // already gone
    }
    db.close();
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
