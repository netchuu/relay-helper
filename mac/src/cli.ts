#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import qrcode from "qrcode-terminal";
import type {
  AttachmentRef,
  AttachmentUpload,
  PairingPayload,
  Prompt,
  RelayEvent,
  Session,
} from "../../protocol/index.ts";
import { PROTOCOL_VERSION } from "../../protocol/index.ts";
import { loadConfig, paths, resolveClaudeBin, saveConfig, VERSION } from "./config.ts";
import { openDb } from "./daemon/db.ts";
import { b64url, loadOrCreateIdentity } from "./daemon/e2e.ts";
import { EventLog } from "./daemon/events.ts";
import { checkFcmConfig } from "./daemon/fcm.ts";
import { typingRouteFor } from "./daemon/inject.ts";
import { runDaemon } from "./daemon/main.ts";
import { liveTmuxSockets } from "./daemon/presence.ts";
import { loadApnsConfig } from "./daemon/push.ts";
import { pinnedFirst, Registry } from "./daemon/registry.ts";
import {
  BIN_DIR,
  countHooks,
  DEFAULT_SETTINGS,
  HOOK_BIN,
  mergeHooks,
  purgeData,
  RELAY_BIN,
  readSettings,
  relayHooks as relayHooksFor,
  removeHooks,
  serviceContext,
  writeSettings,
} from "./install.ts";
import { axAllowed, desktopInstalled, desktopSessions } from "./integrations/claudeDesktop.ts";
import { ideInstalled } from "./integrations/ideExtension.ts";
import {
  addRelayShell,
  flatpakNoEscape,
  removeRelayShell,
  shellState,
  writeZedSettings,
  zedChoice,
  zedLabel,
  zedSettingsPaths,
} from "./integrations/zed.ts";
import { run } from "./platform/exec.ts";
import { platform } from "./platform/index.ts";
import { runShell } from "./shell/ptyShell.ts";
import { describePrompt, formatEvent } from "./tailFormat.ts";

const DEFAULT_RELAY_URL = "wss://relay.relay-cloud.workers.dev";

const USAGE = `relay — iPhone remote for your Claude Code sessions

Usage:
  relay install [--settings <path>] [--no-service] [--dry-run]
  relay uninstall [--settings <path>] [--no-service] [--purge]
                                     --purge also deletes ~/.relay, so paired phones stop working
  relay restart                      restart the background helper
  relay doctor                       check hooks, daemon, presence, push
  relay pair                         show a QR code to pair the iPhone app
  relay devices [revoke <id|name>]   list or revoke paired phones
  relay sessions [--all]             list sessions Relay knows about
  relay prompts                      list open questions / plans / permissions
  relay answer <promptId> <answer…>  answer a prompt (see below)
  relay send <session> [--attach <file>]… [text]
                                     send free text (and files) into a session
  relay tail [--since <seq>]         stream live events
  relay presence [auto|here|away]    show or set presence mode
  relay push-test                    send a test notification to paired phones
  relay daemon                       run the daemon in the foreground (launchd or systemd does this)

Answers:
  permission:  allow | always | deny [reason]
  plan:        approve | approve-edits | revise <feedback> | reject [reason]
  question:    one value per question, in order (multi-select: "A, B")
`;

// ---------------------------------------------------------------------------------------------------

async function admin<T>(method: string, params: unknown = {}): Promise<T> {
  const res = await fetch("http://relay/admin/rpc", {
    method: "POST",
    unix: paths.hookSock,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  }).catch(() => {
    throw new Error("the relay daemon is not running (start it with `relay install` or `relay daemon`)");
  });
  const body = (await res.json()) as { result?: T; error?: { code: string; message: string } };
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result as T;
}

async function daemonAlive(): Promise<boolean> {
  return fetch("http://relay/health", { unix: paths.hookSock, signal: AbortSignal.timeout(1000) }).then(
    (r) => r.ok,
    () => false,
  );
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

/** Runs a command; a missing program comes back as exit code 127 instead of throwing. */
async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = await run(cmd, { timeoutMs: 120_000 });
  return { code: proc.code, out: proc.out || proc.err };
}

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

// ---------------------------------------------------------------------------------------------------

async function install(args: string[]): Promise<void> {
  const settingsPath = option(args, "--settings") ?? DEFAULT_SETTINGS;
  // --no-launchd is the old name, kept so existing scripts keep working.
  const noService = flag(args, "--no-service") || flag(args, "--no-launchd");
  const dryRun = flag(args, "--dry-run");
  // Run by the daemon after a `brew upgrade` (daemon/selfUpdate.ts): keep the person's earlier choices.
  const fromUpdate = flag(args, "--from-update");

  // 1. Binaries: build from this checkout when running from source, then copy to ~/.relay/bin.
  const repoRoot = resolve(import.meta.dir, "../..");
  if (!dryRun && existsSync(resolve(repoRoot, "mac/src/hook/client.ts"))) {
    console.log("• building binaries…");
    const build = await sh(["bun", "run", "--cwd", repoRoot, "build"]);
    if (build.code !== 0) throw new Error(`build failed:\n${build.out}`);
    mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
    for (const [from, to] of [
      [resolve(repoRoot, "mac/bin/relay-hook"), HOOK_BIN],
      [resolve(repoRoot, "mac/bin/relay"), RELAY_BIN],
    ] as const) {
      copyFileSync(from, to);
      chmodSync(to, 0o755);
    }
    await platform.afterCopy(HOOK_BIN);
    await platform.afterCopy(RELAY_BIN);
    console.log(`  ${HOOK_BIN}\n  ${RELAY_BIN}`);
  } else if (!dryRun && basename(process.execPath) !== "bun") {
    // Installed from a release (Homebrew or install.sh): copy this signed binary and its relay-hook
    // into ~/.relay/bin. Copy, then rename, so a running daemon's binary is replaced, not modified.
    const self = realpathSync(process.execPath);
    const hook = join(dirname(self), "relay-hook");
    if (!existsSync(hook)) throw new Error(`relay-hook not found next to ${self}`);
    mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
    for (const [from, to] of [
      [hook, HOOK_BIN],
      [self, RELAY_BIN],
    ] as const) {
      if (resolve(from) === resolve(to)) continue;
      copyFileSync(from, `${to}.new`);
      chmodSync(`${to}.new`, 0o755);
      renameSync(`${to}.new`, to);
    }
    console.log(`• installed ${VERSION}\n  ${HOOK_BIN}\n  ${RELAY_BIN}`);
  }

  // 2. Config: remember the real claude binary (launchd and systemd can't see shell aliases).
  const config = loadConfig();
  const claudeBin = resolveClaudeBin(config);
  if (!dryRun && claudeBin) saveConfig({ claudeBin });
  // New installs use the hosted relay, so the phone reaches the Mac from any network.
  if (!dryRun && !config.relayUrl) saveConfig({ relayUrl: DEFAULT_RELAY_URL });

  // 3. Hooks.
  const before = readSettings(settingsPath);
  const settings = mergeHooks(before, HOOK_BIN);
  if (dryRun) {
    console.log(JSON.stringify(settings.hooks, null, 2));
    console.log(`(dry run) would write ${settingsPath}`);
    return;
  }
  const backup = writeSettings(settingsPath, settings);
  console.log(`• hooks installed in ${settingsPath}${backup ? ` (backup: ${backup})` : ""}`);

  // 4. Zed's terminal has no outside way to type into it: start it through `relay shell` instead, so
  //    replies from the phone arrive as typed input there. New Zed terminal tabs pick it up.
  const useZed = zedChoice(config.zed, { noZed: flag(args, "--no-zed"), fromUpdate });
  if (!fromUpdate && config.zed !== useZed) saveConfig({ zed: useZed });
  for (const zedPath of useZed ? zedSettingsPaths() : []) {
    const name = zedLabel(zedPath);
    try {
      const { state, backup: zedBackup } = writeZedSettings(zedPath, (t) => addRelayShell(t, RELAY_BIN));
      if (state === "ours")
        console.log(
          `• ${name}: new terminal tabs take replies from the phone as typed input${zedBackup ? ` (backup: ${zedBackup})` : ""}`,
        );
      else
        console.log(
          `• ${name}: your terminal uses a custom shell, so it's left as is (replies arrive as a message from another session)`,
        );
    } catch (err) {
      console.log(`⚠️  ${name}: couldn't update ${zedPath} (${(err as Error).message}); left as is`);
    }
  }

  // The service asks macOS for Accessibility once when the Claude desktop app is installed (see below); say so.
  const claudeApp = process.platform === "darwin" && (desktopInstalled() || ideInstalled());

  // 5. Start now and at every login (launchd on the Mac, systemd or a background process on Linux).
  if (!noService) {
    const service = await platform.service.install(serviceContext());
    for (let i = 0; i < 20 && !(await daemonAlive()); i++) await Bun.sleep(250);
    console.log(
      (await daemonAlive())
        ? `• daemon running (${service.mode})`
        : `• daemon did not start; see ${paths.log}`,
    );
    for (const note of service.notes) console.log(`${note.level === "ok" ? "•" : "⚠️ "} ${note.text}`);
    if (claudeApp) {
      // Ask now, even if asked before: the person is right here.
      const perms = await fetch("http://relay/admin/permissions/ask", {
        method: "POST",
        unix: paths.hookSock,
      }).then(
        (r) => (r.ok ? (r.json() as Promise<{ accessibility?: boolean }>) : null),
        () => null,
      );
      console.log(
        perms?.accessibility
          ? "• Claude app and editors: replies from the phone are typed in as you"
          : "• Claude app and editors: macOS asks to let relay use Accessibility, so replies from the phone go into the Claude app and Claude Code in your editor as you. Click Open System Settings and turn relay on",
      );
    }
  }
  if (!flag(args, "--from-pair") && !fromUpdate)
    console.log("\nNext: `relay pair`, and scan the code with the Relay app.");
}

async function uninstall(args: string[]): Promise<void> {
  const settingsPath = option(args, "--settings") ?? DEFAULT_SETTINGS;
  const noService = flag(args, "--no-service") || flag(args, "--no-launchd");
  const purge = flag(args, "--purge");
  // A daemon left running would keep using the data and write it again.
  if (purge && noService) throw new Error("--purge stops the helper too, so it can't go with --no-service");
  const backup = writeSettings(settingsPath, removeHooks(readSettings(settingsPath)));
  console.log(`• hooks removed from ${settingsPath}${backup ? ` (backup: ${backup})` : ""}`);
  for (const zedPath of zedSettingsPaths()) {
    try {
      const zed = writeZedSettings(zedPath, removeRelayShell);
      if (zed.backup)
        console.log(`• ${zedLabel(zedPath)}: terminal back to your normal shell (backup: ${zed.backup})`);
    } catch {
      // Missing or unreadable Zed settings: leave them alone.
    }
  }
  if (!noService) {
    await platform.service.uninstall(serviceContext());
    console.log(
      purge
        ? "• daemon stopped, login item removed"
        : `• daemon stopped, login item removed (data kept in ${paths.home})`,
    );
  }
  if (purge) {
    console.log(
      purgeData(paths.home)
        ? `• deleted ${paths.home}: paired phones can't connect any more`
        : `• nothing to delete in ${paths.home}`,
    );
  } else if (!noService) {
    console.log("  To also delete the data and unpair every phone: `relay uninstall --purge`");
  }
}

/** Sessions that run now and have no terminal Relay can type into: their phone messages arrive as notes. */
async function doctorTyping(ok: (m: string) => void, warn: (m: string) => void): Promise<void> {
  if (!existsSync(paths.db)) return;
  try {
    const registry = new Registry(openDb(paths.db), new EventLog(openDb(":memory:")));
    const without: string[] = [];
    for (const s of registry.list()) {
      if (s.kind === "background" || !s.pid || (await typingRouteFor(s)) !== null) continue;
      without.push(`${s.name ?? s.project} (${s.id.slice(0, 8)})`);
    }
    without.length
      ? warn(
          `typing: no terminal found for ${without.join(", ")}; messages from the phone reach these as notes`,
        )
      : ok("typing: every running session has a terminal to type into");
  } catch {
    // no database yet
  }
}

async function doctor(): Promise<void> {
  const ok = (m: string) => console.log(`✅ ${m}`);
  const warn = (m: string) => console.log(`⚠️  ${m}`);
  const bad = (m: string) => console.log(`❌ ${m}`);
  const config = loadConfig();

  (await daemonAlive())
    ? ok(`daemon: running (${paths.hookSock})`)
    : bad("daemon: not running — `relay install`");
  const service = await platform.service.status(serviceContext());
  if (service.state === "missing")
    bad("service: not installed, so it won't start at login — `relay install`");
  else if (service.state === "stopped") bad(`service: ${service.mode}, stopped — \`relay restart\``);
  else ok(`service: ${service.mode}`);
  for (const note of service.notes) ({ ok, warn, bad })[note.level](`service: ${note.text}`);
  const settings = readSettings(DEFAULT_SETTINGS);
  const relayHooks = countHooks(settings);
  const expected = Object.keys(relayHooksFor(HOOK_BIN)).length;
  relayHooks >= expected
    ? ok(`hooks: ${relayHooks} Relay hooks in ${DEFAULT_SETTINGS}`)
    : bad(`hooks: ${relayHooks}/${expected} installed — \`relay install\``);
  if (settings.crossSessionInbound === "refuse")
    bad('crossSessionInbound is "refuse": free text can\'t reach sessions');

  const claudeBin = resolveClaudeBin(config);
  claudeBin ? ok(`claude: ${claudeBin}`) : bad("claude: binary not found on PATH");
  existsSync(HOOK_BIN) ? ok(`hook binary: ${HOOK_BIN}`) : bad("hook binary missing — `relay install`");

  const app = await fetch(`http://127.0.0.1:${config.port}/health`).then(
    (r) => r.ok,
    () => false,
  );
  app ? ok(`app API: http://127.0.0.1:${config.port}`) : bad(`app API: nothing on 127.0.0.1:${config.port}`);

  if (config.relayUrl) {
    // The phone reaches this computer through the relay; Tailscale isn't involved.
    ok(`relay: ${config.relayUrl}`);
  } else {
    const ts = await sh(["tailscale", "serve", "status", "--json"]);
    if (ts.code === 127)
      warn("tailscale: not installed — needed for the phone to reach this computer (see README)");
    else if (ts.out.includes(`127.0.0.1:${config.port}`)) ok("tailscale serve: forwarding to the app API");
    else
      warn(
        `tailscale serve: not forwarding yet — run \`tailscale serve --bg --https=443 http://127.0.0.1:${config.port}\``,
      );
    config.publicUrl
      ? ok(`public URL: ${config.publicUrl}`)
      : warn("public URL not set — `relay pair` detects it once Tailscale is running");
  }

  const reading = await platform.presence.read({ tmuxSockets: daemonTmuxSockets() });
  const lock = reading.locked === null ? "" : `, screen ${reading.locked ? "locked" : "unlocked"}`;
  reading.idleSeconds === null
    ? warn(
        "presence: can't tell whether you're at this computer, so you count as away and every prompt goes to the phone. `relay presence here|away` overrides it",
      )
    : ok(`presence: idle ${Math.round(reading.idleSeconds)}s${lock} (from ${reading.source})`);
  for (const zedPath of zedSettingsPaths()) {
    const name = zedLabel(zedPath);
    const state = existsSync(zedPath) ? shellState(await Bun.file(zedPath).text()) : "none";
    if (flatpakNoEscape(zedPath))
      warn(
        `${name}: ZED_FLATPAK_NO_ESCAPE keeps Zed in its sandbox, so its terminal can't start \`relay shell\`; replies there arrive as a message from another session`,
      );
    else if (state === "ours")
      ok(`${name}: terminal starts through \`relay shell\`, so replies are typed in`);
    else if (state === "custom")
      warn(
        `${name}: your terminal uses a custom shell; replies there arrive as a message from another session`,
      );
    else warn(`${name}: terminal not set up yet — \`relay install\``);
  }
  // Sessions in the Claude desktop app take replies as typed input only with Accessibility allowed.
  if (process.platform === "darwin" && (desktopSessions().length > 0 || ideInstalled())) {
    // Ask the running service: the permission is per process, and this terminal may have it when relay doesn't.
    const alive = await daemonAlive();
    const service = alive
      ? await fetch("http://relay/admin/permissions", { unix: paths.hookSock }).then(
          (r) => (r.ok ? (r.json() as Promise<{ accessibility?: boolean }>) : null),
          () => null,
        )
      : null;
    // Without a running service, this process is the best guess; an older service can't say.
    const allowedForService = service ? service.accessibility === true : alive ? null : axAllowed();
    if (allowedForService === null)
      warn("Accessibility: the running helper can't report it; run `relay install` to update it");
    else if (allowedForService)
      ok("Accessibility: allowed, so replies are typed into the Claude app and editors");
    else
      warn(
        "Accessibility: not allowed. Replies to sessions in the Claude app and editors arrive marked as from another session. To fix: System Settings → Privacy & Security → Accessibility → turn on relay",
      );
  }
  await doctorTyping(ok, warn);
  const tmux = await sh(["tmux", "-V"]);
  if (tmux.code === 0) ok(`tmux: ${tmux.out}`);
  else if (platform.typing.routes(null).length) warn("tmux: not installed (optional)");
  else
    warn(
      "tmux: not installed. On Linux, replies from the phone are typed only into tmux; elsewhere they arrive as a message from another session",
    );

  // iOS push needs an APNs key on this computer until pushes go through the relay server.
  const apns = loadApnsConfig();
  apns
    ? ok(`iOS push: on (${apns.bundleId})`)
    : warn(
        `iOS push: off — there's no APNs key in ${join(paths.home, "apns")}. Prompts still reach the app while it's open, but the phone won't get notifications from this computer yet`,
      );

  // Never print key material: only the project and the service account's address.
  const fcm = checkFcmConfig();
  switch (fcm.state) {
    case "ok":
      ok(`FCM (Android push): project ${fcm.config.project_id} as ${fcm.config.client_email}`);
      break;
    case "missing":
      config.relayUrl
        ? ok("Android push: through the relay (no Firebase key needed on this computer)")
        : warn(`FCM (Android push): off — no ${fcm.path} (optional)`);
      break;
    case "bad_mode":
      bad(`FCM (Android push): ${fcm.path} is mode ${fcm.mode.toString(8)} — \`chmod 600 ${fcm.path}\``);
      break;
    case "bad_json":
      bad(`FCM (Android push): ${fcm.path} is not valid JSON`);
      break;
    case "invalid":
      bad(`FCM (Android push): ${fcm.path}: ${fcm.problem}`);
      break;
  }

  if (await daemonAlive()) {
    const devices = (await fetch("http://relay/admin/devices", { unix: paths.hookSock }).then((r) =>
      r.json(),
    )) as { revoked: boolean }[];
    const active = devices.filter((d) => !d.revoked).length;
    active ? ok(`paired devices: ${active}`) : warn("no paired devices — `relay pair`");
  }
}

/** tmux servers of live sessions, read straight from the database (the daemon may not be running). */
function daemonTmuxSockets(): string[] {
  try {
    if (!existsSync(paths.db)) return [];
    const db = new Database(paths.db, { readonly: true });
    try {
      return liveTmuxSockets(db);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function pair(): Promise<void> {
  // Claude desktop app users without the permission: macOS asks now (the person is right here).
  if (process.platform === "darwin" && desktopInstalled() && (await daemonAlive())) {
    await fetch("http://relay/admin/permissions/ask", { method: "POST", unix: paths.hookSock }).catch(
      () => null,
    );
  }
  // One command for new users: set everything up first if it isn't yet (hooks, helper at login).
  if (countHooks(readSettings(DEFAULT_SETTINGS)) === 0 || !(await daemonAlive())) {
    console.log("Setting up Relay first.\n");
    await install(["--from-pair"]);
    for (let i = 0; i < 20 && !(await daemonAlive()); i++) await Bun.sleep(250);
    console.log("");
  }
  let config = loadConfig();
  if (!config.publicUrl) {
    const ts = await sh(["tailscale", "status", "--json"]);
    const dns =
      ts.code === 0
        ? (JSON.parse(ts.out) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "")
        : null;
    if (dns) config = saveConfig({ publicUrl: `https://${dns}` });
  }
  const res = await fetch("http://relay/admin/pair", { method: "POST", unix: paths.hookSock }).catch(() => {
    throw new Error("the relay daemon is not running");
  });
  const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: number };
  const minutes = Math.round((expiresAt - Date.now()) / 60000);
  if (config.relayUrl) {
    // Through the Cloudflare relay: the QR carries the Mac's public key, which anchors the encryption.
    const id = loadOrCreateIdentity(paths.identity);
    const payload: PairingPayload = {
      v: 2,
      relay: config.relayUrl,
      mac: id.macId,
      key: b64url(id.boxPublic),
      code,
    };
    qrcode.generate(JSON.stringify(payload), { small: true });
    console.log(`Code: ${code.slice(0, 4)}-${code.slice(4)}   (expires in ${minutes} min)`);
    console.log(`Relay: ${config.relayUrl} (end-to-end encrypted)`);
    // For phones that can't scan the screen: the app's paste field takes this line as is.
    console.log(`\nNo camera? Paste this into the app:\n${JSON.stringify(payload)}`);
    return;
  }
  const url = config.publicUrl ?? `http://127.0.0.1:${config.port}`;
  const payload: PairingPayload = { v: 1, url, code };
  qrcode.generate(JSON.stringify(payload), { small: true });
  console.log(`Code: ${code.slice(0, 4)}-${code.slice(4)}   (expires in ${minutes} min)`);
  console.log(
    `URL:  ${url}${config.publicUrl ? "" : "   ⚠️  Tailscale not set up: only works from this Mac"}`,
  );
  console.log(`\nNo camera? Paste this into the app:\n${JSON.stringify(payload)}`);
}

async function devices(args: string[]): Promise<void> {
  if (args[0] === "revoke" && args[1]) {
    const res = await fetch("http://relay/admin/devices/revoke", {
      method: "POST",
      unix: paths.hookSock,
      body: JSON.stringify({ id: args[1] }),
    });
    console.log(((await res.json()) as { revoked: boolean }).revoked ? "revoked" : "no such active device");
    return;
  }
  const list = (await fetch("http://relay/admin/devices", { unix: paths.hookSock }).then((r) =>
    r.json(),
  )) as {
    id: string;
    name: string;
    lastSeenAt: number | null;
    revoked: boolean;
  }[];
  if (!list.length) console.log("no paired devices");
  for (const d of list)
    console.log(
      `${d.id}  ${d.name}  ${d.revoked ? "revoked" : d.lastSeenAt ? `seen ${ago(d.lastSeenAt)} ago` : "never seen"}`,
    );
}

async function sessions(args: string[]): Promise<void> {
  const list = pinnedFirst(await admin<Session[]>("sessions.list", { includeEnded: flag(args, "--all") }));
  const icon: Record<string, string> = { working: "⚙️ ", idle: "💤", waiting: "❓", ended: "⏹️ " };
  for (const s of list) {
    console.log(
      `${icon[s.status] ?? "  "} ${s.id.slice(0, 8)}  ${(s.name ?? s.project).padEnd(32).slice(0, 32)} ${s.branch ?? ""}  ${ago(s.updatedAt)} ago${s.canReceive ? "" : "  (no inbox)"}${s.pinnedAt != null ? "  (pinned)" : ""}`,
    );
  }
  if (!list.length) console.log("no sessions");
}

async function prompts(): Promise<void> {
  const list = await admin<Prompt[]>("prompts.open");
  if (!list.length) console.log("no open prompts");
  for (const p of list) console.log(describePrompt(p));
}

async function answer(args: string[]): Promise<void> {
  const [promptId, ...rest] = args;
  if (!promptId || !rest.length) throw new Error("usage: relay answer <promptId> <answer…>");
  const open = await admin<Prompt[]>("prompts.open");
  const p = open.find((x) => x.id === promptId || x.id.startsWith(promptId));
  if (!p) throw new Error("no open prompt with that id");
  const [verb = "", ...more] = rest;
  let ans: unknown;
  if (p.payload.kind === "question") {
    const answers: Record<string, string> = {};
    p.payload.questions.forEach((q, i) => {
      const v = rest[i];
      if (v !== undefined) answers[q.question] = v;
    });
    ans = { kind: "question", answers };
  } else if (p.payload.kind === "plan") {
    const action = {
      approve: "approve",
      "approve-edits": "approve_accept_edits",
      revise: "revise",
      reject: "reject",
    }[verb];
    if (!action)
      throw new Error("plan answers: approve | approve-edits | revise <feedback> | reject [reason]");
    ans = { kind: "plan", action, feedback: more.join(" ") || undefined };
  } else {
    const action = { allow: "allow", always: "allow_always", deny: "deny" }[verb];
    if (!action) throw new Error("permission answers: allow | always | deny [reason]");
    ans = { kind: "permission", action, reason: more.join(" ") || undefined };
  }
  await admin("prompt.answer", { promptId: p.id, answer: ans });
  console.log("answered");
}

async function send(args: string[]): Promise<void> {
  // --attach <file> (repeatable, anywhere after the session): uploaded like the phone does, then sent with the text.
  const files: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--attach") {
      const file = args[++i];
      if (!file) throw new Error("--attach needs a file");
      files.push(file);
    } else rest.push(arg);
  }
  const [target, ...words] = rest;
  if (!target || (!words.length && !files.length))
    throw new Error("usage: relay send <session id or name> [--attach <file>]… [text]");
  const list = await admin<Session[]>("sessions.list");
  const matches = list.filter(
    (s) => s.id.startsWith(target) || s.name === target || s.name?.startsWith(target),
  );
  if (matches.length !== 1)
    throw new Error(matches.length ? "ambiguous session; use more of the id" : "no such live session");
  const sessionId = matches[0]?.id as string;
  const attachments: string[] = [];
  for (const file of files) attachments.push((await uploadAttachment(sessionId, file)).id);
  const res = await admin<{ via: string }>("session.send", {
    sessionId,
    text: words.join(" "),
    ...(attachments.length ? { attachments } : {}),
  });
  console.log(`delivered via ${res.via}`);
}

/** Uploads a local file in chunks, as a phone does (attachment.begin → attachment.chunk… → attachment.end). */
async function uploadAttachment(sessionId: string, file: string): Promise<AttachmentRef> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no such file: ${file}`);
  const blob = Bun.file(path);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const upload = await admin<AttachmentUpload>("attachment.begin", {
    sessionId,
    name: basename(path),
    mime: blob.type,
    size: bytes.length,
    sha256,
  });
  for (let index = 0; index < upload.chunks; index++) {
    const data = Buffer.from(
      bytes.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize),
    ).toString("base64");
    await admin("attachment.chunk", { id: upload.id, index, data });
  }
  const ref = await admin<AttachmentRef>("attachment.end", { id: upload.id });
  console.log(`attached ${ref.path}`);
  return ref;
}

async function tail(args: string[]): Promise<void> {
  const since =
    Number(option(args, "--since") ?? "0") ||
    (await admin<{ latestSeq: number }>("sync", { sinceSeq: 0 })).latestSeq;
  const res = await fetch(`http://relay/admin/stream?since=${since}`, { unix: paths.hookSock });
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) console.log(formatEvent(JSON.parse(line) as RelayEvent));
      nl = buf.indexOf("\n");
    }
  }
}

// ---------------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "daemon":
      return runDaemon();
    case "shell":
      // Started by Zed's terminal (see integrations/zed.ts); exits with the shell's code.
      return process.exit(await runShell(args));
    case "install":
      return install(args);
    case "uninstall":
      return uninstall(args);
    case "restart":
      await platform.service.restart(serviceContext());
      for (let i = 0; i < 20 && !(await daemonAlive()); i++) await Bun.sleep(250);
      console.log((await daemonAlive()) ? "daemon running" : `daemon did not start; see ${paths.log}`);
      return;
    case "doctor":
      return doctor();
    case "pair":
      return pair();
    case "devices":
      return devices(args);
    case "sessions":
      return sessions(args);
    case "prompts":
      return prompts();
    case "answer":
      return answer(args);
    case "send":
      return send(args);
    case "tail":
      return tail(args);
    case "presence": {
      const p = args[0]
        ? await admin<{ mode: string; present: boolean }>("presence.set", { mode: args[0] })
        : await admin<{ mode: string; present: boolean }>("presence.get");
      console.log(`mode ${p.mode}, ${p.present ? "here" : "away"}`);
      return;
    }
    case "push-test": {
      const res = await admin<{ sent: number }>("push.test");
      console.log(
        res.sent
          ? `sent to ${res.sent} phone(s)`
          : "no phone has registered for notifications yet (open the app and allow them)",
      );
      return;
    }
    case "version":
    case "--version":
      console.log(`relay ${VERSION} (protocol ${PROTOCOL_VERSION})`);
      return;
    default:
      console.log(USAGE);
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`relay: ${err.message}`);
  process.exit(1);
});
