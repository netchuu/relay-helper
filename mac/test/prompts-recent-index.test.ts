import { expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";

// The Inbox history reads the newest closed prompts on every phone connect, so it must not scan and sort them all.
const QUERY = "SELECT * FROM prompts WHERE status = 'closed' ORDER BY resolved_at DESC LIMIT ?";

function plan(db: ReturnType<typeof openDb>): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${QUERY}`).all(50) as { detail: string }[];
  return rows.map((r) => r.detail).join("\n");
}

function insert(db: ReturnType<typeof openDb>, n: number) {
  const stmt = db.query(
    `INSERT INTO prompts (id, session_id, kind, tool_name, tool_input, payload_json, status, created_at, resolved_at)
     VALUES (?, 's', 'permission', 'Bash', '{}', '{}', 'closed', ?, ?)`,
  );
  for (let i = 0; i < n; i++) stmt.run(`p${i}`, i, i);
}

test("the history query uses an index and no temporary sort", () => {
  const db = openDb(":memory:");
  const p = plan(db);
  expect(p).toContain("USING INDEX");
  expect(p).not.toContain("TEMP B-TREE");
});

test("migrating an existing file adds the index", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "relay-idx-"));
  try {
    const path = join(dir, "relay.db");
    const db = openDb(path);
    db.exec("DROP INDEX prompts_recent; PRAGMA user_version = 14;");
    insert(db, 200);
    const before = db.query(QUERY).all(50);
    db.close();
    const again = openDb(path);
    expect((again.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    expect(plan(again)).not.toContain("TEMP B-TREE");
    expect(again.query(QUERY).all(50)).toEqual(before);
    expect((again.query(QUERY).all(50) as { id: string }[])[0]?.id).toBe("p199");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
