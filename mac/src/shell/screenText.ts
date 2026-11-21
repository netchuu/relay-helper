// Reads the screen text a full-screen program draws, in the form `promptTextRead` reads.

interface Cell {
  ch: string;
  style: string;
}

const MAX_LINES = 500;

export class ScreenText {
  private lines: Cell[][] = [[]];
  private row = 0;
  private col = 0;
  private style = "";
  private pending = "";
  private decoder = new TextDecoder();

  constructor(public rows = 40) {}

  feed(chunk: Uint8Array | string): void {
    const text =
      this.pending + (typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }));
    this.pending = "";
    for (let i = 0; i < text.length; ) {
      const ch = text[i] as string;
      if (ch === "\x1b") {
        const end = this.escapeEnd(text, i);
        if (end === -1) {
          this.pending = text.slice(i);
          return;
        }
        this.escape(text.slice(i, end));
        i = end;
        continue;
      }
      i += ch.length;
      this.put(ch);
    }
  }

  /** The visible lines, as `capture-pane -e` would give them. */
  text(): string {
    const shown = this.lines.slice(-this.rows);
    return shown.map((cells) => renderLine(cells)).join("\n");
  }

  private escapeEnd(s: string, at: number): number {
    const next = s[at + 1];
    if (next === undefined) return -1;
    if (next === "[") {
      for (let j = at + 2; j < s.length; j++) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) return j + 1;
      }
      return -1;
    }
    if (next === "]") {
      for (let j = at + 2; j < s.length; j++) {
        if (s[j] === "\x07") return j + 1;
        if (s[j] === "\x1b" && s[j + 1] === "\\") return j + 2;
      }
      return -1;
    }
    if ("()*+".includes(next)) return at + 3 > s.length ? -1 : at + 3;
    return at + 2;
  }

  private escape(seq: string): void {
    if (!seq.startsWith("\x1b[")) return;
    const final = seq[seq.length - 1] as string;
    const params = seq.slice(2, -1);
    if (params.startsWith("?") || params.startsWith(">")) return;
    const nums = params.split(";").map((p) => (p === "" ? Number.NaN : Number(p)));
    const n = (i: number, dflt: number) => (Number.isFinite(nums[i]) ? (nums[i] as number) : dflt);
    switch (final) {
      case "m":
        if (params === "" || params === "0") this.style = "";
        else if (params === "22") this.style = this.style.replaceAll("\x1b[2m", "");
        else this.style += seq;
        break;
      case "A":
        this.row = Math.max(0, this.row - n(0, 1));
        break;
      case "B":
        this.moveDown(n(0, 1));
        break;
      case "C":
        this.col += n(0, 1);
        break;
      case "D":
        this.col = Math.max(0, this.col - n(0, 1));
        break;
      case "G":
        this.col = Math.max(0, n(0, 1) - 1);
        break;
      case "H":
      case "f":
        this.row = Math.max(0, this.lines.length - this.rows) + Math.max(0, n(0, 1) - 1);
        this.col = Math.max(0, n(1, 1) - 1);
        while (this.lines.length <= this.row) this.lines.push([]);
        break;
      case "J":
        if (n(0, 0) === 2 || n(0, 0) === 3) this.clearScreen();
        else if (n(0, 0) === 0) {
          this.lines.length = this.row + 1;
          this.eraseLine(0);
        }
        break;
      case "K":
        this.eraseLine(n(0, 0));
        break;
    }
  }

  private clearScreen(): void {
    this.lines = [[]];
    this.row = 0;
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.row] as Cell[];
    if (mode === 0) line.length = Math.min(line.length, this.col);
    else if (mode === 2) line.length = 0;
    else for (let i = 0; i < Math.min(this.col + 1, line.length); i++) line[i] = { ch: " ", style: "" };
  }

  private moveDown(by: number): void {
    this.row += by;
    while (this.lines.length <= this.row) this.lines.push([]);
    this.trim();
  }

  private trim(): void {
    if (this.lines.length <= MAX_LINES) return;
    const drop = this.lines.length - MAX_LINES;
    this.lines.splice(0, drop);
    this.row = Math.max(0, this.row - drop);
  }

  private put(ch: string): void {
    if (ch === "\r") this.col = 0;
    else if (ch === "\n") this.moveDown(1);
    else if (ch === "\b") this.col = Math.max(0, this.col - 1);
    else if (ch >= " ") {
      const line = this.lines[this.row] as Cell[];
      while (line.length < this.col) line.push({ ch: " ", style: "" });
      line[this.col++] = { ch, style: this.style };
    }
  }
}

function renderLine(cells: Cell[]): string {
  let out = "";
  let current = "";
  for (const cell of cells) {
    if (cell.style !== current) {
      out += `\x1b[0m${cell.style}`;
      current = cell.style;
    }
    out += cell.ch;
  }
  return current ? `${out}\x1b[0m` : out;
}
