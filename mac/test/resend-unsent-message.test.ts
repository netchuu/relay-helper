import { describe, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { type DeliverOptions, deliver, type TypeOps } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { promptDraft } from "../src/daemon/promptLine.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";

const RULE = "─".repeat(100);
const MSG = "deploy to staging";

/** A terminal running Claude Code whose Enter is lost until `enterWorks` is set. */
function terminal() {
  const state = {
    prompt: "",
    enterWorks: false,
    submitted: [] as string[],
    typed: [] as string[],
    enters: 0,
  };
  const screen = () => ["⏺ Done.", RULE, `❯ ${state.prompt}`, RULE, "  ⏵⏵ bypass permissions on"].join("\n");
  const submit = () => {
    state.enters++;
    if (state.enterWorks && state.prompt) {
      state.submitted.push(state.prompt);
      state.prompt = "";
    }
  };
  const type = (text: string) => {
    state.typed.push(text);
    state.prompt += text;
  };
  const ops: TypeOps = {
    pty: async () => ({ ok: true }),
    tmuxScreen: async () => screen(),
    tmux: async (_s, _p, text) => type(text),
    tmuxEnter: async () => submit(),
    routes: (t) => (t === "iTerm.app" ? ["iterm"] : []),
    ttyOf: async () => "/dev/ttys004",
    peek: async () => ({ front: false, screen: screen() }),
    type: async (_r, _t, text) => {
      type(text);
      return true;
    },
    enter: async () => {
      submit();
      return true;
    },
    inFront: async () => true,
    sleep: async () => {},
  };
  return { ops, state, draft: () => promptDraft(screen()) };
}

function rig(env: HookEnv) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  const handler = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
  });
  const submitPrompt = (prompt: string) =>
    handler.handle(
      { payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/x", prompt }, env: {} },
      new AbortController().signal,
    );
  return { session: registry.get("s1") as SessionRecord, submitPrompt };
}

function session(env: HookEnv): SessionRecord {
  return rig(env).session;
}

const opts = (more: Partial<DeliverOptions> = {}): DeliverOptions => ({
  userTypingNow: false,
  preferTyping: true,
  submitted: () => false,
  submitWaitMs: 10,
  ...more,
});

const TMUX: HookEnv = { tmux: "/tmp/resend-tmux.sock,1,0", tmuxPane: "%1", claudePid: 4242 };
const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };

for (const [name, env, route] of [
  ["tmux", TMUX, "tmux"],
  ["iTerm2", ITERM, "iterm"],
] as const) {
  describe(`sending an unsent message again (${name})`, () => {
    test("presses Enter for the copy in the prompt instead of typing it twice", async () => {
      const t = terminal();
      const s = session(env);
      expect(await deliver(s, MSG, opts(), t.ops)).toEqual({ via: route, submitted: false });
      expect(t.draft()).toBe(MSG);

      t.state.enterWorks = true;
      const again = await deliver(s, MSG, opts({ submitted: () => t.state.submitted.length > 0 }), t.ops);
      expect(again).toEqual({ via: route });
      expect(t.state.typed).toEqual([MSG]);
      expect(t.state.submitted).toEqual([MSG]);
    });

    test("a different draft is stashed, and the message typed after it", async () => {
      const t = terminal();
      t.state.prompt = "fix the login bug";
      t.ops.stash = async () => {
        t.state.prompt = "";
        return true;
      };
      t.ops.tmuxStash = async () => {
        t.state.prompt = "";
      };
      expect(await deliver(session(env), MSG, opts(), t.ops)).toMatchObject({ via: route });
      expect(t.state.typed).toEqual([MSG]);
    });

    test("a draft that only starts like the message is a different draft: stashed, not sent with Enter", async () => {
      const t = terminal();
      t.state.prompt = `${MSG} and then roll back`;
      t.ops.stash = async () => {
        t.state.prompt = "";
        return true;
      };
      t.ops.tmuxStash = async () => {
        t.state.prompt = "";
      };
      await deliver(session(env), MSG, opts({ submitted: () => true }), t.ops);
      expect(t.state.enters).toBe(0);
      expect(t.state.typed).toEqual([MSG]);
    });
  });
}

describe("sending an unsent message again, more cases", () => {
  test("iTerm2 with no key pressed since the prompt still presses Enter once", async () => {
    const t = terminal();
    t.ops.noKeySincePrompt = () => true;
    const s = session(ITERM);
    await deliver(s, MSG, opts(), t.ops);
    t.state.enterWorks = true;
    const again = await deliver(s, MSG, opts({ submitted: () => t.state.submitted.length > 0 }), t.ops);
    expect(again).toEqual({ via: "iterm" });
    expect(t.state.typed).toEqual([MSG]);
    expect(t.state.submitted).toEqual([MSG]);
  });
});

describe("Claude's own suggestion on iTerm2", () => {
  test("a suggestion equal to the message is typed over, not sent with Enter", async () => {
    const t = terminal();
    t.ops.noKeySincePrompt = () => true;
    t.state.prompt = MSG;
    t.ops.type = async (_r, _t, text) => {
      t.state.typed.push(text);
      t.state.prompt = text;
      return true;
    };
    const enters: number[] = [];
    t.ops.enter = async () => {
      enters.push(1);
      t.state.submitted.push(t.state.prompt);
      return true;
    };
    const done = await deliver(
      session(ITERM),
      MSG,
      opts({ submitted: () => t.state.submitted.length > 0 }),
      t.ops,
    );
    expect(done).toEqual({ via: "iterm" });
    expect(t.state.typed).toEqual([MSG]);
    expect(enters).toHaveLength(1);
  });
});

describe("an unsent message submitted at the Mac", () => {
  test("the same words suggested later are typed and sent, not pressed Enter for", async () => {
    const t = terminal();
    t.ops.noKeySincePrompt = () => true;
    const { session: s, submitPrompt } = rig(ITERM);
    expect(await deliver(s, MSG, opts(), t.ops)).toEqual({ via: "iterm", submitted: false });

    t.state.prompt = "";
    await submitPrompt(MSG);
    t.state.prompt = MSG;
    t.state.typed = [];
    t.state.enters = 0;
    t.ops.type = async (_r, _t, text) => {
      t.state.typed.push(text);
      t.state.prompt = text;
      return true;
    };
    t.ops.enter = async () => {
      t.state.enters++;
      t.state.submitted.push(t.state.prompt);
      return true;
    };
    const done = await deliver(s, MSG, opts({ submitted: () => t.state.submitted.length > 0 }), t.ops);
    expect(done).toEqual({ via: "iterm" });
    expect(t.state.typed).toEqual([MSG]);
    expect(t.state.enters).toBe(1);
  });

  test("a task notification leaves the unsent message remembered", async () => {
    const t = terminal();
    t.ops.noKeySincePrompt = () => true;
    const { session: s, submitPrompt } = rig(ITERM);
    expect(await deliver(s, MSG, opts(), t.ops)).toEqual({ via: "iterm", submitted: false });

    await submitPrompt("<task-notification>done</task-notification>");
    t.state.typed = [];
    const done = await deliver(s, MSG, opts(), t.ops);
    expect(done).toEqual({ via: "iterm", submitted: false });
    expect(t.state.typed).toEqual([]);
  });
});
