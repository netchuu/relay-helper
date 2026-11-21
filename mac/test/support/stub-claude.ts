// A stand-in for Claude Code in the phone-terminal tests: draws a prompt, logs every key it is typed, exits on /exit.
import { appendFileSync } from "node:fs";

const log = process.env.STUB_LOG ?? "";
const args = process.argv.slice(2);
if (process.env.STUB_REFUSE) {
  console.log("\nWorkspace not trusted.");
  process.exit(1);
}
const rule = "─".repeat(100);
process.stdout.write(`\x1b[?2004h${rule}\r\n❯ \r\n${rule}\r\n`);
if (log)
  appendFileSync(
    log,
    `ARGS ${JSON.stringify(args)} TERM ${process.env.TERM} SIZE ${process.stdout.columns}x${process.stdout.rows}\n`,
  );
process.on("SIGWINCH", () => {
  if (log) appendFileSync(log, `SIZE ${process.stdout.columns}x${process.stdout.rows}\n`);
  process.stdout.write(`\x1b[2J\x1b[Hredrawn ${process.stdout.columns}x${process.stdout.rows}\r\n❯ \r\n`);
});
process.stdin.setRawMode(true);
let all = "";
process.stdin.on("data", (d) => {
  const text = d.toString("utf8");
  if (log) appendFileSync(log, `KEYS ${JSON.stringify(text)}\n`);
  all += text;
  if (all.includes("/exit") && all.endsWith("\r")) process.exit(0);
});
