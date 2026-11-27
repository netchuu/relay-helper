import type { Broker } from "./broker.ts";
import type { Registry } from "./registry.ts";

/** Keeps a session's `waiting` status in step with its open prompts; a dialog question's close puts back what it was before (hooks fire mid-turn, so those go to working). */
export function promptStatusSync(
  registry: Pick<Registry, "get" | "setStatus">,
  broker: Pick<Broker, "hasOpen" | "openDialogOf">,
): (sessionId: string) => void {
  const before = new Map<string, "idle" | "working">();
  return (sessionId) => {
    const s = registry.get(sessionId);
    if (!s || s.status === "ended") {
      before.delete(sessionId);
      return;
    }
    if (broker.hasOpen(sessionId)) {
      if (s.status === "waiting") return;
      if ((s.status === "idle" || s.status === "working") && broker.openDialogOf(sessionId))
        before.set(sessionId, s.status);
      registry.setStatus(sessionId, "waiting");
    } else if (s.status === "waiting") {
      const back = before.get(sessionId) ?? "working";
      before.delete(sessionId);
      registry.setStatus(sessionId, back);
    }
  };
}
