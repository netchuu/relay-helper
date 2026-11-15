/** Text from the phone made safe to type: CR/CRLF become a newline, tabs stay, other control characters go. */
export function cleanTypedText(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09 || (code >= 0x20 && code < 0x7f) || code > 0x9f) out += ch;
  }
  return out;
}
