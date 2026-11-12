/**
 * Text from the phone, made safe to type into a terminal or an editor. Every route Relay types through uses it
 * (`relay shell`, tmux, iTerm2, the desktop app, editors), so a reply is only ever text: Relay presses Enter itself,
 * once, after it.
 *
 * - CR and CRLF become a newline. A lone CR is Enter in a terminal and would submit part of the reply early; a
 *   newline goes in inside a bracketed paste, where it stays a line break.
 * - Tabs and newlines stay.
 * - Every other control character goes: ESC (which could end the bracketed paste with `ESC [201~` and turn the
 *   rest into keys, or send any other key sequence), the other C0 controls (Ctrl-C, Ctrl-D, Ctrl-Z, Ctrl-U…),
 *   DEL, and the C1 controls (U+0080 to U+009F, which some terminals read as ESC sequences, CSI among them).
 *
 * Imports nothing, so the platform modules can use it too.
 */
export function cleanTypedText(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09 || (code >= 0x20 && code < 0x7f) || code > 0x9f) out += ch;
  }
  return out;
}
