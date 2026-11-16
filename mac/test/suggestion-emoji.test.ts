import { expect, test } from "bun:test";
import { cleanSuggestion } from "../src/daemon/suggestion.ts";
import { wellFormedJSON } from "../src/daemon/text.ts";

test("a long suggestion is never cut in the middle of an emoji", () => {
  for (const pad of [296, 297, 298, 299]) {
    const s = cleanSuggestion(`${"a".repeat(pad)}😀 and more text here`)!;
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s.isWellFormed()).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  }
});

test("a short suggestion is kept whole, emoji included", () => {
  expect(cleanSuggestion("run it 😀")).toBe("run it 😀");
});

test("a frame with a lone surrogate is written repaired, not as an escape", () => {
  const text = wellFormedJSON({ type: "rpc", result: [{ suggestion: "a\ud83d…" }] });
  expect(text).not.toContain("\\ud83d");
  expect(JSON.parse(text).result[0].suggestion).toBe("a�…");
  expect(wellFormedJSON({ n: 1, s: "ok 😀" })).toBe('{"n":1,"s":"ok 😀"}');
});

test("rpc answers and event frames on the socket carry no lone-surrogate escape", async () => {
  const { startAppServer } = await import("../src/daemon/api.ts");
  const { createPairingCode, redeemPairingCode } = await import("../src/daemon/auth.ts");
  const { openDb } = await import("../src/daemon/db.ts");
  const { EventLog } = await import("../src/daemon/events.ts");
  const { waitFor } = await import("./support/wait.ts");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const port = 20000 + (process.pid % 20000) + 7;
  const server = startAppServer({
    port,
    db,
    events,
    rpc: async () => ({ result: { suggestion: "cut here\ud83d" } }),
  });
  try {
    const { code } = createPairingCode(db);
    const paired = redeemPairingCode(db, code, "Test iPhone");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${paired?.token}` },
    } as never);
    const frames: string[] = [];
    ws.onmessage = (m) => frames.push(String(m.data));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ id: 1, method: "sessions.list", params: {} }));
    events.emit({ type: "session.notice", sessionId: "s1", level: "info", text: "cut here\ud83d" });
    await waitFor(
      () => frames.some((f) => f.includes('"rpc"')) && frames.some((f) => f.includes('"event"')),
      30_000,
      "rpc and event frames",
      () => frames.join("\n"),
    );
    for (const f of frames) {
      expect(f).not.toContain("\\ud83d");
      expect(() => JSON.parse(f)).not.toThrow();
    }
    const rpcFrame = JSON.parse(frames.find((f) => f.includes('"rpc"'))!);
    expect(rpcFrame.result.suggestion).toBe("cut here�");
    const evFrame = JSON.parse(frames.find((f) => f.includes('"event"'))!);
    expect(evFrame.event.text).toBe("cut here�");
    ws.close();
  } finally {
    server.stop(true);
  }
});
