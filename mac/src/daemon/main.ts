import { existsSync, unlinkSync } from "node:fs";
import { ensureHome, isTestHelper, loadConfig, paths, resolveClaudeBin, VERSION } from "../config.ts";
import { RELAY_BIN } from "../install.ts";
import { askForAccessibility, axAllowed, setAccessibilityAskStore } from "../integrations/claudeDesktop.ts";
import { errMessage, log } from "../log.ts";
import { run } from "../platform/exec.ts";
import { setCanStartSessions } from "../platform/index.ts";
import { watchAccessibility } from "./accessibilityWatch.ts";
import { startAppServer, startLocalServer } from "./api.ts";
import { AttachmentStore } from "./attachments.ts";
import { BackgroundTracker } from "./background.ts";
import { Broker } from "./broker.ts";
import { getSetting, openDb, setSetting } from "./db.ts";
import { DialogWatcher } from "./dialogWatch.ts";
import { loadOrCreateIdentity } from "./e2e.ts";
import { EventLog } from "./events.ts";
import { Handover } from "./handover.ts";
import { HeadlessSessions, IDLE_CHECK_MS } from "./headless.ts";
import { HeldReplies } from "./held.ts";
import { HookHandler } from "./hooks.ts";
import { setKnownPids } from "./inject.ts";
import { MessageTracker } from "./messages.ts";
import { Notifier } from "./notifier.ts";
import { Phones } from "./phones.ts";
import { PresenceMonitor } from "./presence.ts";
import { promptStatusSync } from "./promptStatus.ts";
import { PushOutcomes } from "./pushOutcomes.ts";
import { Registry, setTypingPreferred } from "./registry.ts";
import { RelayLink } from "./relayLink.ts";
import { RelayApns, RelayFcm } from "./relayPush.ts";
import { deliverQueued, ReplyQueue } from "./replyQueue.ts";
import { createRpc } from "./rpc.ts";
import { anySessionWorking, brewCandidates, SelfUpdater, underServiceManager } from "./selfUpdate.ts";
import { StepTracker } from "./steps.ts";
import { TurnStopper } from "./stop.ts";
import { SuggestionWatcher } from "./suggestion.ts";
import { bindSuggestionSeen } from "./suggestionSeen.ts";
import { hostLauncher } from "./terminalHost.ts";

export async function runDaemon(): Promise<void> {
  ensureHome();
  const config = loadConfig();
  const claudeBin = resolveClaudeBin(config);
  const db = openDb(paths.db);
  bindSuggestionSeen(db);
  const events = new EventLog(db);
  setTypingPreferred(config.preferTyping);
  const registry = new Registry(db, events);
  setKnownPids(() => registry.list().flatMap((s) => (s.pid ? [s.pid] : [])));
  let syncStatus = (_sessionId: string): void => {};
  const broker = new Broker(db, events, (sessionId) => syncStatus(sessionId));
  syncStatus = promptStatusSync(registry, broker);
  const phones = new Phones();
  const presence = new PresenceMonitor(db, events, config.idleAwaySeconds, () =>
    replies.list().some((r) => r.waitsFor === "unlock"),
  );
  // The hosted relay holds the push keys; this Mac only signs its requests.
  let apns: Pick<RelayApns, "send"> | null = null;
  let fcm: Pick<RelayFcm, "send"> | null = null;
  if (config.relayUrl) {
    const identity = loadOrCreateIdentity(paths.identity);
    apns = new RelayApns(config.relayUrl, identity);
    fcm = new RelayFcm(config.relayUrl, identity);
  }
  const notifier =
    apns || fcm
      ? new Notifier(
          db,
          events,
          presence,
          registry,
          broker,
          { apns, fcm },
          new PushOutcomes(paths.pushOutcomes),
        )
      : null;
  const terminal = hostLauncher();
  const baseDeps = { db, events, registry, broker, presence, config, notifier, claudeBin, terminal };
  setCanStartSessions(Boolean(claudeBin));
  const steps = new StepTracker(events);
  const messages = new MessageTracker(events);
  const background = new BackgroundTracker(events);
  // The lists the phones last saw survive a restart (background-work).
  background.restore((id) => {
    const s = registry.get(id);
    return Boolean(s && s.status !== "ended");
  });
  const held = new HeldReplies({ events, registry });
  const stopper = new TurnStopper({ db, events, registry, broker, config, steps, messages, held });
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
  // Sessions continued without a terminal (`session.resume`): Claude Code processes this daemon owns.
  const headless = new HeadlessSessions({
    registry,
    claudeBin,
    idleMs: config.idleStopSeconds * 1000,
    checkMs: Math.min(IDLE_CHECK_MS, (config.idleStopSeconds * 1000) / 4),
    openPrompt: (input, signal) => hooks.openPrompt(input, signal),
    notice: (sessionId, text) => events.emit({ type: "session.notice", sessionId, level: "error", text }),
    turns: {
      openId: (id) =>
        db
          .query<{ id: string }, [string]>(
            "SELECT id FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
          )
          .get(id)?.id ?? null,
      fail: (turnId, text) => void stopper.endFailed(turnId, text),
    },
  });
  registry.ownedByHelper = (id) => headless.has(id);
  stopper.headless = headless;
  const suggestions = new SuggestionWatcher({ registry, phoneConnected: () => phones.connected });
  phones.onFirst(() => suggestions.lookNow());
  const dialogs = new DialogWatcher({
    registry,
    events,
    broker,
    phoneConnected: () => phones.connected,
    hasOpen: (id) => broker.listOpen(id).some((p) => !p.dialog),
  });
  dialogs.start();
  const handover = new Handover({
    registry,
    terminal,
    stop: (id) => stopper.interrupt(id, "handover"),
    headless,
    openTurn: (id) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(id)?.id ?? null,
  });
  const deps = {
    ...baseDeps,
    handover,
    held,
    stopper,
    steps,
    messages,
    background,
    replies,
    attachments,
    headless,
    suggestions,
    dialogs,
  };
  const hooks = new HookHandler(deps);
  hooks.resumeOpenTurns();
  const rpc = createRpc(deps);
  headless.busy = (id) => rpc.sendingNow(id) || broker.hasOpen(id) || replies.list(id).length > 0;

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
  const app = startAppServer({ port: config.port, rpc, events, db, phones });
  presence.start();
  notifier?.start();
  let relayLink: RelayLink | null = null;
  if (config.relayUrl) {
    relayLink = new RelayLink(config.relayUrl, loadOrCreateIdentity(paths.identity), {
      rpc,
      events,
      db,
      phones,
    });
    relayLink.start();
  }

  const timers = [
    setInterval(() => broker.expire(config.promptTimeoutSeconds * 1000), 60_000),
    // A slash command typed on the phone writes no hook: its echo is looked for while the send is fresh.
    setInterval(() => {
      for (const id of hooks.pendingSlashSessions()) hooks.scanCommands(id);
    }, 500),
    // Replies an older helper left waiting go out now.
    setInterval(
      () =>
        void rpc
          .applyPicks()
          .catch((err) => log.warn("queued picks", { err: errMessage(err) }))
          .then(() =>
            replies.drain(
              deliverQueued({
                preferTyping: config.preferTyping,
                hasOpenPrompt: (id) => broker.hasOpen(id),
                headless,
                held,
              }),
            ),
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
    working: () => anySessionWorking(registry.list()),
    exit: () => shutdown("self-update", 75),
  });
  // A release build only: from source, `relay install` builds the checkout instead.
  if (VERSION !== "0.1.0") updater.start();

  log.info("relay daemon started", {
    version: VERSION,
    hookSock: paths.hookSock,
    app: `http://127.0.0.1:${config.port}`,
    claudeBin,
    push: apns ? "relay" : "off",
    relay: config.relayUrl ?? "off",
  });

  const shutdown = (signal: string, code = 0) => {
    log.info("shutting down", { signal });
    updater.stop();
    for (const t of timers) clearInterval(t);
    presence.stop();
    dialogs.stop();
    relayLink?.stop();
    // The Claude Code processes this daemon started for resumed sessions go with it.
    headless.stopAll();
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
