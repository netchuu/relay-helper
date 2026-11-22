import { Database } from "bun:sqlite";

/** Ordered migrations: never edit a shipped one, append (`PRAGMA user_version` counts those applied). */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    cwd           TEXT NOT NULL,
    project       TEXT NOT NULL,
    branch        TEXT,
    kind          TEXT NOT NULL DEFAULT 'unknown',
    status        TEXT NOT NULL DEFAULT 'idle',
    title         TEXT,
    pid           INTEGER,
    terminal      TEXT,
    tmux_pane     TEXT,
    tmux_socket   TEXT,
    socket_path   TEXT,
    socket_token  TEXT,
    transcript    TEXT,
    started_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    last_summary  TEXT
  );
  CREATE INDEX sessions_status ON sessions(status);

  CREATE TABLE turns (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    prompt      TEXT,
    full_text   TEXT,
    summary     TEXT,
    truncated   INTEGER NOT NULL DEFAULT 0,
    stats_json  TEXT,
    failed      INTEGER NOT NULL DEFAULT 0,
    started_at  INTEGER,
    ended_at    INTEGER
  );
  CREATE INDEX turns_session ON turns(session_id, started_at);

  CREATE TABLE prompts (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    kind           TEXT NOT NULL,
    tool_name      TEXT NOT NULL,
    tool_input     TEXT NOT NULL,
    suggestions    TEXT,
    payload_json   TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open',
    resolved_by    TEXT,
    answer_json    TEXT,
    created_at     INTEGER NOT NULL,
    resolved_at    INTEGER
  );
  CREATE INDEX prompts_open ON prompts(status, session_id);

  CREATE TABLE events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    type       TEXT NOT NULL,
    data_json  TEXT NOT NULL
  );

  CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    revoked_at    INTEGER,
    apns_token    TEXT
  );

  CREATE TABLE pairing_codes (
    code_hash   TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
  );

  CREATE TABLE audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    detail  TEXT
  );

  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  // 2: which APNs environment a device's token belongs to (debug builds use the sandbox).
  `ALTER TABLE devices ADD COLUMN apns_env TEXT;`,
  // 3: which push service apns_token belongs to: 'apns' (iOS, also when NULL) or 'fcm' (Android).
  `ALTER TABLE devices ADD COLUMN push_platform TEXT;`,
  // 4: per-phone key (base64, 32 bytes) that encrypts notification text so only that phone can read it.
  `ALTER TABLE devices ADD COLUMN push_key TEXT;`,
  // 5: the `relay shell` pseudo-terminal a session runs in (Zed's terminal), for typed replies.
  `ALTER TABLE sessions ADD COLUMN pty_socket TEXT; ALTER TABLE sessions ADD COLUMN pty_token TEXT;`,
  // 6: a name given from a phone (session.rename). Kept apart from `name`, which Claude Code keeps updating.
  `ALTER TABLE sessions ADD COLUMN custom_name TEXT;`,
  // 7: when the session was pinned to the top of the Sessions list from a phone (session.pin); NULL = not pinned.
  `ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;`,
  // 8: a turn the user stopped (session.interrupt, or Esc at the computer).
  `ALTER TABLE turns ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0;`,
  // 9: a finished turn's steps (turn-steps): {steps, stepsMore?} as JSON; NULL for turns from before.
  `ALTER TABLE turns ADD COLUMN steps_json TEXT;`,
  // replies waiting for the Mac to be unlocked (desktop-ide-delivery).
  `CREATE TABLE IF NOT EXISTS queued_replies (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     text       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // 11: what Claude wrote between tool calls (live-messages): {messages, messagesMore?} as JSON; NULL when none.
  `ALTER TABLE turns ADD COLUMN messages_json TEXT;`,
  // 12: photos and files sent from a phone (attachments). finished_at is NULL while uploading; path is the saved
  // file once finished; removed_at is set when the file was cleaned up (the row stays, so old prompts still show it).
  `CREATE TABLE IF NOT EXISTS attachments (
     id          TEXT PRIMARY KEY,
     session_id  TEXT NOT NULL,
     name        TEXT NOT NULL,
     mime        TEXT NOT NULL,
     size        INTEGER NOT NULL,
     sha256      TEXT NOT NULL,
     path        TEXT,
     created_at  INTEGER NOT NULL,
     finished_at INTEGER,
     removed_at  INTEGER
   );
   CREATE INDEX IF NOT EXISTS attachments_session ON attachments(session_id);`,
  // 13: what a queued reply waits for: NULL = unlock, "pause" = a pause in typing at the Mac. Rebuilt, so it
  // also runs on a database that already has the column.
  `CREATE TABLE queued_replies_13 (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     text       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     waits_for  TEXT
   );
   INSERT INTO queued_replies_13 (id, session_id, text, created_at)
     SELECT id, session_id, text, created_at FROM queued_replies;
   DROP TABLE queued_replies;
   ALTER TABLE queued_replies_13 RENAME TO queued_replies;`,
  // 14: the phone's ids of messages that were delivered (sentMessages.ts), so Try Again after a helper restart
  // doesn't type one twice.
  `CREATE TABLE IF NOT EXISTS sent_messages (
     session_id TEXT NOT NULL,
     send_id    TEXT NOT NULL,
     via        TEXT NOT NULL,
     at         INTEGER NOT NULL,
     PRIMARY KEY (session_id, send_id)
   );`,
  // 15: the Inbox history (newest closed prompts) reads this index instead of sorting every closed prompt.
  `CREATE INDEX IF NOT EXISTS prompts_recent ON prompts(status, resolved_at);`,
  // 16: the WezTerm pane and the kitty window a session runs in (paneTerminals.ts), to type replies there. A table of
  // its own, so it also runs on a database that was moved back to an older version.
  `CREATE TABLE IF NOT EXISTS session_panes (
     session_id      TEXT PRIMARY KEY,
     wezterm_pane    TEXT,
     wezterm_socket  TEXT,
     kitty_listen_on TEXT,
     kitty_window_id TEXT
   );`,
  // 17: attachments typed with a turn's prompt, in order ("[Image #N]" alone doesn't say which files).
  // Its own table, so it also runs on a database moved back to an older version.
  `CREATE TABLE IF NOT EXISTS turn_attachments (
     turn_id       TEXT NOT NULL,
     attachment_id TEXT NOT NULL,
     position      INTEGER NOT NULL,
     PRIMARY KEY (turn_id, position)
   );`,
  // 18: the phone's id of a queued reply, so a held one is reported under it when it is typed in later.
  // Rebuilt, so it also runs on a database that already has the column.
  `CREATE TABLE queued_replies_18 (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     text       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     waits_for  TEXT,
     send_id    TEXT
   );
   INSERT INTO queued_replies_18 (id, session_id, text, created_at, waits_for)
     SELECT id, session_id, text, created_at, waits_for FROM queued_replies;
   DROP TABLE queued_replies;
   ALTER TABLE queued_replies_18 RENAME TO queued_replies;`,
  // 19: when a chat from the phone's own terminal was continued in the person's terminal.
  `CREATE TABLE IF NOT EXISTS moved_sessions (session_id TEXT PRIMARY KEY, moved_at INTEGER NOT NULL);`,
  // 20: when the process behind a session's `pid` started, so a pid the system gave to something else later isn't taken
  // for the session. A table of its own, so it also runs on a database that was moved back to an older version.
  `CREATE TABLE IF NOT EXISTS session_pid_starts (session_id TEXT PRIMARY KEY, pid_start INTEGER NOT NULL);`,
  // 21: an id for this event log, made with the database, so a phone notices when the log started again.
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('eventLogId', json_quote(lower(hex(randomblob(8)))));`,
];

/** The schema version a fully migrated database has. Tests compare with this, not a number. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export type DB = Database;

export function openDb(path: string): DB {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) break;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export function audit(db: DB, actor: string, action: string, detail?: unknown): void {
  db.query("INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)").run(
    Date.now(),
    actor,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
