import { afterEach, expect, test } from "bun:test";
import { BackgroundTracker, backgroundOf, resetBackground } from "../src/daemon/background.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { stepFor } from "../src/daemon/steps.ts";
import { actionFields } from "../src/daemon/timeline.ts";

// Invisible text-direction controls can reverse what follows on the phone ("build ‮gnp.exe" shows as
// "exe.png"). The helper drops them from every label, title and detail it sends.

const CONTROLS = ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "‎", "‏", "؜"];
const hasControl = (s: string | undefined) => CONTROLS.some((c) => s?.includes(c));

afterEach(() => resetBackground());

test("background titles and commands have no direction controls", () => {
  const db = openDb(":memory:");
  const tracker = new BackgroundTracker(new EventLog(db), { throttleMs: 0 });
  tracker.stopped(
    "s1",
    CONTROLS.map((c, i) => ({
      id: `t${i}`,
      type: "shell",
      status: "running",
      description: `build ${c}gnp.exe`,
      command: `echo ${c}gnp.exe`,
    })),
  );
  for (const t of backgroundOf("s1")) {
    expect(hasControl(t.title)).toBe(false);
    expect(hasControl(t.detail)).toBe(false);
    expect(t.title).toBe("build gnp.exe");
  }
});

test("step labels, action titles and details have none either; right-to-left letters stay", () => {
  for (const c of CONTROLS) {
    expect(hasControl(stepFor("Bash", { command: `ls ${c}gnp.exe` }, "/x", "done").label)).toBe(false);
    const f = actionFields("Bash", { command: `ls ${c}gnp.exe`, description: `copy ${c}gnp.exe` }, "/x");
    expect(hasControl(f.title)).toBe(false);
    expect(hasControl(f.detail)).toBe(false);
  }
  expect(actionFields("Bash", { command: "ls", description: "مراجعة السلة" }, "/x").title).toBe(
    "مراجعة السلة",
  );
});
