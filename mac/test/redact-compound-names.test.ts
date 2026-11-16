import { expect, test } from "bun:test";
import { redact } from "../src/daemon/redact.ts";

// Made-up values throughout.
const assignments = [
  "secretPassword=hunter-hunter!",
  "mysecretpassword=hunter-hunter",
  "privateKeyPassword=letmeinplease",
  "jwtTokenSecret=mysupersecretvalue",
  "tokenSecret=my-super-secret!",
  "apiKeySecret=abcdefghijkl",
  "authTokenSecret=AbCdEfGhIjKl",
  "export TOKENSECRET=abcdefgh-ijkl",
  "secretPassword=hunter-hunter1",
  "password: data.Xk39fJ2mQz",
];
for (const s of assignments) {
  test(`redacts ${s}`, () => {
    expect(redact(s)).toContain("[redacted:secret-assignment]");
  });
}

const flags = ["x --dbpassword Sup3rS3cret1", "x --idtoken abc123def456", "x --usertoken abc123def456"];
for (const s of flags) {
  test(`redacts flag with a glued prefix: ${s}`, () => {
    expect(redact(s)).toContain("[redacted:cli-secret]");
  });
}

const logins = ["docker login -u sftp -p Passw0rd!", "docker login ssh.example.com -u me -p Passw0rd!"];
for (const s of logins) {
  test(`redacts docker login password: ${s}`, () => {
    expect(redact(s)).toContain("[redacted:cli-password]");
  });
}

const controls = [
  "tokenizer: sentencepiece_model",
  "secretName: my-app-secrets",
  "python train.py --max-tokens 100000",
  'git commit --author "Jane Doe <jane@example.com>" -m x',
  "sshpass -e ssh -p 2222 user@host",
  "password: req.body.password",
  "token = process.env.GITHUB_TOKEN",
  "secret: process.env.S3_SECRET",
  "password: config.db.password",
];
for (const s of controls) {
  test(`keeps ${s}`, () => {
    expect(redact(s)).toBe(s);
  });
}
