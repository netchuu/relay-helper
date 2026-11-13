/**
 * Everything that differs between macOS and Linux sits behind this interface. The rest of the helper
 * calls `platform` (from ./index.ts) and never checks `process.platform` itself.
 *
 * The platform modules import nothing from the rest of the helper, so there are no import cycles:
 * whatever they need (paths, PATH) is passed in.
 */

/** What the background service needs to know to start the daemon. */
export interface ServiceContext {
  /** The installed `relay` binary, started as `relay daemon`. */
  relayBin: string;
  /** Relay's data directory (~/.relay unless RELAY_HOME is set). */
  home: string;
  /** Where the daemon's output goes. */
  logPath: string;
  /** PATH for the daemon. */
  path: string;
}

/** One line of `relay doctor` or `relay install` output. */
export interface Check {
  level: "ok" | "warn" | "bad";
  text: string;
}

export interface ServiceStatus {
  state: "running" | "stopped" | "missing";
  /** How the daemon is kept running: "launchd", "systemd" or "background process". */
  mode: string;
  notes: Check[];
}

export interface PresenceReading {
  /** Seconds since the person last used this computer; null when there's no way to tell. */
  idleSeconds: number | null;
  /** Screen locked; null when there's no way to tell. */
  locked: boolean | null;
  /** Where the reading came from, for `relay doctor`. */
  source: string;
}

export interface PresenceContext {
  /** tmux server sockets that live sessions run in, for reading tmux client activity. */
  tmuxSockets?: string[];
}

export interface HostInfo {
  os: "macos" | "linux";
  name: string;
}

/** Terminal apps Relay can type into besides tmux. */
export type TypingRoute = "iterm" | "terminal";

/** What Relay can see of a terminal tab before typing into it. */
export interface TabView {
  /** The tab is the one in front of you: its app is frontmost and it's the selected tab of the front window. */
  front: boolean;
  /** The tab's visible text, to spot a draft in the prompt line; null when it can't be read. */
  screen: string | null;
}

export interface Platform {
  name: "darwin" | "linux";
  service: {
    /** Starts the daemon now and at every login. Returns notes worth showing the person. */
    install(ctx: ServiceContext): Promise<ServiceStatus>;
    uninstall(ctx: ServiceContext): Promise<void>;
    restart(ctx: ServiceContext): Promise<void>;
    status(ctx: ServiceContext): Promise<ServiceStatus>;
  };
  presence: {
    read(ctx?: PresenceContext): Promise<PresenceReading>;
  };
  typing: {
    /** Apps to try, in order, for a session whose hook reported this TERM_PROGRAM. */
    routes(termProgram: string | null): TypingRoute[];
    /** Looks at the tab whose tty is `tty`. Null when the app isn't running or has no such tab. */
    peek(route: TypingRoute, tty: string): Promise<TabView | null>;
    /**
     * Types `text`, then Enter, into the tab whose tty is `tty`, whoever is in front: the caller decides when
     * (inject.ts waits for a pause). Returns false when it couldn't.
     */
    type(route: TypingRoute, tty: string, text: string): Promise<boolean>;
    /**
     * Presses a key in the tab whose tty is `tty` (Esc, to stop Claude's turn: session.interrupt; Enter, to
     * submit a message that sat typed in the prompt). Nothing else follows. Returns false when it couldn't.
     */
    key(route: TypingRoute, tty: string, key: "escape" | "enter"): Promise<boolean>;
    /**
     * Seconds since a key was last pressed on this computer's keyboard (not the mouse); null when unknown. With
     * the time the prompt was last submitted, it tells Claude Code's grey suggestion from typing in a terminal
     * that shows no text attributes.
     */
    keyIdleSeconds?(): number | null;
  };
  /** The name people know this computer by, e.g. "Ana's MacBook Pro" or "build-server". */
  computerName(): Promise<string>;
  /** Runs after a binary is copied into ~/.relay/bin (the Mac re-signs it). */
  afterCopy(path: string): Promise<void>;
  /** Directories added in front of the standard ones in PATH for child processes and the claude search. */
  extraPath: string[];
}
