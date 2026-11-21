import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry, sessionAlive } from "../src/daemon/registry.ts";
import { hostLauncher } from "../src/daemon/terminalHost.ts";
import {
  processState,
  setProcessReader,
  signalSaved,
  startTimeOf,
  systemReader,
} from "../src/platform/processIdentity.ts";

const BOOT = 1_000_000_000_000;
const children: ReturnType<typeof Bun.spawn>[] = [];

/** A process table where every pid starts at the time the test says. */
function table(starts: Record<number, number | null>, reads: number[] = []) {
  setProcessReader({
    startTime: (pid) => {
      reads.push(pid);
      return starts[pid] ?? null;
    },
    bootTime: () => BOOT,
  });
}

function sleeper(): number {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child.pid;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  setProcessReader(null);
});

describe("processState", () => {
  test("a pid with the saved start time is the same process, another start time is dead", () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    expect(processState(pid, { start: BOOT + 5000 })).toBe("same");
    expect(processState(pid, { start: BOOT + 1000 })).toBe("dead");
  });

  test("a pid nothing runs under is dead whatever was saved", () => {
    table({});
    expect(processState(2_000_000_000, { start: BOOT })).toBe("dead");
    expect(processState(2_000_000_000)).toBe("dead");
  });

  test("a start time that can't be read proves nothing", () => {
    const pid = sleeper();
    table({ [pid]: null });
    expect(processState(pid, { start: BOOT + 5000 })).toBe("unknown");
    expect(processState(pid, { savedAt: BOOT + 9000 })).toBe("unknown");
  });

  test("a record without a start time: saved before the boot is dead, a later process is dead, an earlier one is the same", () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    expect(processState(pid, { savedAt: BOOT - 60_000 })).toBe("dead");
    expect(processState(pid, { savedAt: BOOT + 1000 })).toBe("dead");
    expect(processState(pid, { savedAt: BOOT + 9000 })).toBe("same");
    expect(processState(pid, {})).toBe("unknown");
  });

  const STAT = "4242 (my cmd) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 1500 1000 1 0";
  const BOOT_A = "aaaa1111-0000-4000-8000-000000000000";
  const BOOT_B = "bbbb2222-0000-4000-8000-000000000000";
  const linux = (stat: string, bootId: string) =>
    systemReader({
      platform: "linux",
      readProc: (path) => (path.endsWith("boot_id") ? `${bootId}\n` : stat),
      psStart: () => null,
    });

  test("a Linux start saved from /proc matches after the wall clock steps", () => {
    const pid = sleeper();
    setSystemTime(new Date(BOOT + 60_000));
    const saved = linux(STAT, BOOT_A).startTime(pid) as number;
    setSystemTime(new Date(BOOT + 3_600_000));
    setProcessReader(linux(STAT, BOOT_A));
    try {
      expect(processState(pid, { start: saved })).toBe("same");
    } finally {
      setSystemTime();
    }
  });

  test("a Linux start saved on an earlier boot is dead when another process has the pid at the same uptime", () => {
    const pid = sleeper();
    const saved = linux(STAT, BOOT_A).startTime(pid) as number;
    setProcessReader(linux(STAT, BOOT_B));
    expect(processState(pid, { start: saved })).toBe("dead");
  });

  test("on macOS a record without a start reads ps once, however often it is checked", () => {
    const pid = sleeper();
    let launches = 0;
    setProcessReader(
      systemReader({
        platform: "darwin",
        readProc: () => null,
        psStart: () => {
          launches++;
          return Date.now() - 60_000;
        },
      }),
    );
    for (let i = 0; i < 3; i++) expect(processState(pid, { savedAt: Date.now() })).toBe("same");
    expect(launches).toBe(1);
  });

  test("reading a start time twice launches nothing the second time", () => {
    const reads: number[] = [];
    table({ 42: BOOT }, reads);
    startTimeOf(42);
    startTimeOf(42);
    expect(reads).toEqual([42]);
  });

  test("the real reader finds this process's start, a little before now", () => {
    setProcessReader(null);
    const start = startTimeOf(process.pid);
    expect(start).not.toBeNull();
    if (process.platform === "linux") return;
    expect(Date.now() - (start as number)).toBeGreaterThanOrEqual(-2000);
    expect(Date.now() - (start as number)).toBeLessThan(30 * 24 * 3600_000);
  });
});

describe("signalSaved", () => {
  test("no signal goes to a pid whose start time differs or is unknown", () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    expect(signalSaved(pid, { start: BOOT + 1 }, "SIGTERM")).toBe(false);
    expect(signalSaved(pid, {}, "SIGTERM")).toBe(false);
    expect(alive(pid)).toBe(true);
  });

  test("the saved process gets the signal", async () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    expect(signalSaved(pid, { start: BOOT + 5000 }, "SIGTERM")).toBe(true);
    await children[0]?.exited;
    expect(alive(pid)).toBe(false);
  });
});

describe("sessions", () => {
  function registry() {
    const db = openDb(":memory:");
    return { db, registry: new Registry(db, new EventLog(db)) };
  }

  test("a session's pid is saved with its start time, and a reused pid no longer counts as it", () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    const { registry: r } = registry();
    r.touch("s1", { env: { claudePid: pid } as never });
    expect(r.get("s1")?.pidStart).toBe(BOOT + 5000);
    expect(sessionAlive(r.get("s1") as never)).toBe(true);
    table({ [pid]: BOOT + 99_000 });
    expect(sessionAlive(r.get("s1") as never)).toBe(false);
  });

  test("a session saved before this change with a pid from before the boot is dead", () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    const { db, registry: r } = registry();
    r.touch("old", { env: { claudePid: pid } as never });
    db.query("DELETE FROM session_pid_starts WHERE session_id = 'old'").run();
    db.query("UPDATE sessions SET updated_at = ? WHERE id = 'old'").run(BOOT - 1000);
    expect(sessionAlive(r.get("old") as never)).toBe(false);
    db.query("UPDATE sessions SET updated_at = ? WHERE id = 'old'").run(BOOT + 60_000);
    expect(sessionAlive(r.get("old") as never)).toBe(true);
  });
});

describe("closing a terminal host", () => {
  function savedHost(hostPid: number, hostStart: number | null, mtime?: number) {
    const dir = mkdtempSync(join(tmpdir(), "relay-host-"));
    const path = join(dir, "h-abcd1234.json");
    writeFileSync(
      path,
      JSON.stringify({
        socket: join(dir, "s"),
        token: "t",
        pid: 1,
        hostPid,
        ...(hostStart ? { hostStart } : {}),
      }),
    );
    if (mtime) utimesSync(path, mtime / 1000, mtime / 1000);
    return { dir, pane: { id: "abcd1234", socket: join(dir, "s"), token: "t", pid: 1 } };
  }

  test("a host pid that now belongs to another program isn't signalled", async () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    const { dir, pane } = savedHost(pid, BOOT + 1000);
    await hostLauncher({ dir }).close(pane);
    expect(alive(pid)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("the host that was saved is stopped", async () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    const { dir, pane } = savedHost(pid, BOOT + 5000);
    await hostLauncher({ dir }).close(pane);
    await children[0]?.exited;
    expect(alive(pid)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("a record without a start time: a process that began after it was written isn't signalled", async () => {
    const pid = sleeper();
    table({ [pid]: BOOT + 5000 });
    const { dir, pane } = savedHost(pid, null, BOOT + 1000);
    await hostLauncher({ dir }).close(pane);
    expect(alive(pid)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
