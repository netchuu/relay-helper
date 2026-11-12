import { describe, expect, test } from "bun:test";
import {
  DeliveryError,
  deliver,
  ESC_SETTLE_MS,
  type KeyOps,
  pressEscape,
  type TypeOps,
} from "../src/daemon/inject.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";
import type { TypingRoute } from "../src/platform/types.ts";

// A message sent right after the phone's Stop: Claude Code may still be handling the Esc and lose the Enter that
// follows the text, leaving it typed but not submitted. The helper lets Claude Code finish the Esc first, and presses
// Enter once more when no prompt hook comes.

const RULE = "─".repeat(100);
const screen = (...prompt: string[]) => ["⏺ …", RULE, ...prompt, RULE, "  ⏵⏵ bypass"].join("\n");

type Where = "pty" | "tmux" | "iterm" | "terminal";

/** A session reachable only through `where`. */
function sessionVia(where: Where, id: string): SessionRecord {
  const base = { id, pid: 4242, terminal: where === "terminal" ? "Apple_Terminal" : "iTerm.app" };
  const extra =
    where === "pty"
      ? { ptySocket: "/tmp/x.sock", ptyToken: "t" }
      : where === "tmux"
        ? { tmuxSocket: "/tmp/tmux.sock", tmuxPane: "%1" }
        : {};
  return { ...base, ...extra } as unknown as SessionRecord;
}

/**
 * Fake terminals. `eatsEnter` is how many Enters after typing get lost; the prompt then still shows the
 * text. A prompt hook arrives (`hook()`) when an Enter gets through.
 */
function terminals(where: Where, opts: { eatsEnter: number }) {
  const log: string[] = [];
  const sleeps: number[] = [];
  let lost = opts.eatsEnter;
  let promptText: string | null = null;
  let hook = false;
  const submit = () => {
    if (lost > 0) lost--;
    else {
      promptText = null;
      hook = true;
    }
  };
  const typedNow = (text: string) => {
    promptText = text;
    submit(); // the Enter that follows the text
  };
  const shown = () => screen(promptText ? `❯ ${promptText}` : "❯ ");
  const ops: TypeOps = {
    pty: async (_s, _t, _p, text) => {
      log.push(`type:${text}`);
      typedNow(text);
      return { ok: true };
    },
    tmuxScreen: async () => shown(),
    tmux: async (_s, _p, text) => {
      log.push(`type:${text}`);
      typedNow(text);
    },
    routes: () => (where === "iterm" ? ["iterm"] : where === "terminal" ? ["terminal"] : []),
    ttyOf: async () => "/dev/ttys004",
    peek: async () => ({ front: false, screen: shown() }),
    inFront: async () => true,
    type: async (_r, _t, text) => {
      log.push(`type:${text}`);
      typedNow(text);
      return true;
    },
    enterPty: async () => {
      log.push("enter");
      submit();
      return { ok: true };
    },
    tmuxEnter: async () => {
      log.push("enter");
      submit();
    },
    enter: async () => {
      log.push("enter");
      submit();
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { ops, log, sleeps, hook: () => hook, prompt: () => promptText };
}

function keys(log: string[]): KeyOps {
  return {
    pty: async () => {
      log.push("esc");
      return { ok: true };
    },
    tmux: async () => void log.push("esc"),
    routes: () => ["iterm"] as TypingRoute[],
    app: async () => {
      log.push("esc");
      return true;
    },
    ttyOf: async () => "/dev/ttys004",
  };
}

const base = { idleSeconds: null, userTypingNow: false, preferTyping: true } as const;

for (const where of ["pty", "tmux", "iterm", "terminal"] as const) {
  describe(`Stop, then a message (${where})`, () => {
    test("a send within a second of the Stop waits for Claude Code to settle, then is typed and submitted", async () => {
      const session = sessionVia(where, `stop-${where}-1`);
      const t = terminals(where, { eatsEnter: 0 });
      await pressEscape(session, keys(t.log));
      const res = await deliver(session, "Ok", { ...base, submitted: () => t.hook() }, t.ops);
      expect(res.via).toBe(where);
      expect(res.submitted).toBeUndefined();
      // It waited out most of ESC_SETTLE_MS before typing.
      expect(t.sleeps[0]).toBeGreaterThan(ESC_SETTLE_MS - 1000);
      expect(t.sleeps[0]).toBeLessThanOrEqual(ESC_SETTLE_MS);
      expect(t.log).toEqual(["esc", "type:Ok"]);
      expect(t.hook()).toBe(true);
    });

    test("an Enter lost after the Stop: no hook, the text is in the prompt, Enter is pressed once more", async () => {
      const session = sessionVia(where, `stop-${where}-2`);
      const t = terminals(where, { eatsEnter: 1 });
      await pressEscape(session, keys(t.log));
      const res = await deliver(
        session,
        "Ok",
        { ...base, submitted: () => t.hook(), submitWaitMs: 300 },
        t.ops,
      );
      expect(res.submitted).toBeUndefined();
      expect(t.log).toEqual(["esc", "type:Ok", "enter"]);
      expect(t.hook()).toBe(true);
      expect(t.prompt()).toBeNull();
    });

    test("an Enter that is lost twice is reported, never left silently unsent", async () => {
      const session = sessionVia(where, `stop-${where}-3`);
      const t = terminals(where, { eatsEnter: 2 });
      const res = await deliver(
        session,
        "Ok",
        { ...base, submitted: () => t.hook(), submitWaitMs: 300 },
        t.ops,
      );
      // `relay shell`'s prompt can't be read, so the second miss can't be confirmed there.
      if (where === "pty") expect(res.submitted).toBeUndefined();
      else expect(res.submitted).toBe(false);
      expect(t.log.filter((l) => l === "enter")).toHaveLength(1);
    });
  });
}

describe("checking a typed message", () => {
  test("submitted at once: no extra Enter and no waiting", async () => {
    const session = sessionVia("tmux", "stop-ok");
    const t = terminals("tmux", { eatsEnter: 0 });
    await deliver(session, "hello", { ...base, submitted: () => true }, t.ops);
    expect(t.log).toEqual(["type:hello"]);
  });

  test("no hook but the prompt is empty (the hook was late): no Enter", async () => {
    const session = sessionVia("tmux", "stop-late");
    const t = terminals("tmux", { eatsEnter: 0 });
    await deliver(session, "hello", { ...base, submitted: () => false, submitWaitMs: 200 }, t.ops);
    expect(t.log).toEqual(["type:hello"]);
  });

  test("an Enter that can't be pressed isn't an error for the send", async () => {
    const session = sessionVia("tmux", "stop-noenter");
    const t = terminals("tmux", { eatsEnter: 1 });
    t.ops.tmuxEnter = async () => {
      throw new DeliveryError("gone");
    };
    const res = await deliver(session, "x", { ...base, submitted: () => t.hook(), submitWaitMs: 200 }, t.ops);
    expect(res.via).toBe("tmux");
  });
});
