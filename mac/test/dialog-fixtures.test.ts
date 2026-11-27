import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const load = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../protocol/fixtures", name), "utf8"));

describe("the dialog and ending fixtures", () => {
  test("a blocked message carries a hook's reason, never a dialog", () => {
    const [blocked, lost] = load("sends.json").outcomeEvents;
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.text).toStartWith("A hook on your computer blocked this message");
    expect(lost.text).toBe("Claude Code ended before it read this message.");
  });

  test("an older phone is refused with the title and what to do", () => {
    expect(load("sends.json").dialogRefused.error.message).toMatch(
      /^Claude Code is asking something on your computer: .+\. Answer it, then send again\.$/,
    );
  });

  test("a trust dialog at start is a question, and the session has no Close It", () => {
    const start = load("start.json");
    expect(start.sessionDialog.atMac).toBeUndefined();
    expect(start.sessionDialog.status).toBe("waiting");
    expect(start.sessionDialogQuestion.dialog.kind).toBe("trust");
    expect(start.errors.map((e: { error: { message: string } }) => e.error.message)).toContain(
      "You didn't trust this folder, so the chat didn't start.",
    );
    expect(start.errorTrustDeclined).toBeUndefined();
  });

  test("/exit and /clear say what happened, then the session ends", () => {
    const turns = load("command-turns.json");
    expect(turns.exit.summary).toBe("Claude Code was quit.");
    expect(turns.clear.summary).toBe("Cleared. The conversation continues in a new chat.");
    const [done, ended] = turns.clearThenEnded;
    expect(done.turn.command.name).toBe("clear");
    expect(ended.session.endReason).toBe("clear");
    expect(ended.session.replacedBy).toBeString();
  });
});
