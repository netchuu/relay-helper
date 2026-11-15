import { expect, test } from "bun:test";
import type { Prompt } from "../../protocol/index.ts";
import { promptAlert } from "../src/daemon/notifier.ts";
import { redact } from "../src/daemon/redact.ts";

const ordinary = [
  'git commit --author "Jane Doe <jane@example.com>" -m x',
  "llm --max-tokens=4096 --tokenizer bert-base-uncased",
  "python train.py --max-tokens 100000",
  "aws secretsmanager get-secret-value --secret-id prod/db/creds",
  "sshpass -e ssh -p 2222 user@host",
];

for (const cmd of ordinary) {
  test(`left alone: ${cmd}`, () => {
    expect(redact(cmd)).toBe(cmd);
  });
}

const secrets = [
  "gh --token ghp_abcdefghijklmnop1234",
  "tool --password=hunter2hunter2",
  "tool --api-key sk-abcdef123456",
  "tool --auth-token abcdef123456",
  "ngrok http 80 --authtoken abcd1234efgh",
  "tool --accesstoken abcdef123456",
  "tool --apitoken abcdef123456",
  "tool --secretkey abcdef123456",
  "sshpass -p secret1234 ssh host",
  "docker login -u me -p secret1234",
];

for (const cmd of secrets) {
  test(`still redacted: ${cmd}`, () => {
    expect(redact(cmd)).toContain("[redacted:");
    expect(redact(cmd)).not.toMatch(/ghp_abc|hunter2|sk-abc|abcdef123456|secret1234/);
  });
}

test("git commit --author keeps its Allow button", () => {
  const prompt = {
    id: "p1",
    sessionId: "s1",
    kind: "permission",
    payload: { kind: "permission", toolName: "Bash", summary: ordinary[0], canAlwaysAllow: false },
  } as unknown as Prompt;
  expect(promptAlert(prompt, "relay").category).toBe("PERMISSION");
});
