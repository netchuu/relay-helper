// A stand-in for Claude Code under `relay wrap`: logs what it is given, answers a few keys.
import { appendFileSync } from "node:fs";

const log = process.env.STUB_LOG ?? "";
const note = (line: string) => log && appendFileSync(log, `${line}\n`);
const args = process.argv.slice(2);
note(
  `START ${JSON.stringify(args)} PTY ${process.env.RELAY_PTY ?? ""} TOKEN ${process.env.RELAY_PTY_TOKEN ?? ""} TTY ${process.stdin.isTTY ? "yes" : "no"}`,
);
if (args[0] === "exit") process.exit(Number(args[1]));
if (args[0] === "crash") {
  process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[>1u");
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
  setInterval(() => {}, 1000);
} else {
  const rule = "─".repeat(100);
  process.stdout.write(`\x1b[?2004h${rule}\r\n❯ \r\n${rule}\r\n`);
  const size = () => `${process.stdout.columns}x${process.stdout.rows}`;
  note(`SIZE ${size()}`);
  process.on("SIGWINCH", () => note(`SIZE ${size()}`));
  process.on("SIGCONT", () => {
    note("CONT");
    process.stdout.write("continued\r\n");
  });
  process.stdin.setRawMode(true);
  note("READY");
  let all = "";
  process.stdin.on("data", (d) => {
    const text = d.toString("utf8");
    note(`KEYS ${JSON.stringify(text)}`);
    if (text.includes("\x1a")) process.kill(process.pid, "SIGSTOP");
    all += text;
    if (all.includes("/exit") && all.endsWith("\r")) process.exit(Number(process.env.STUB_CODE ?? 0));
  });
}
