import { expect, test } from "bun:test";
import { redact } from "../src/daemon/redact.ts";

const cases = [
  "PGPASSWORD=Sup3rS3cretPw psql -h db -U app",
  'dbPassword: "Sup3rS3cretPw!"',
  'const smtpPassword = "Sup3rS3cretPw!";',
  "adminPassword=Sup3rS3cretPw!",
  "mypassword=hunter2hunter2",
  "export DBPASSWORD=Sup3rS3cretPw",
];
for (const s of cases) {
  test(`redacts: ${s}`, () => {
    expect(redact(s)).toContain("[redacted:secret-assignment]");
  });
}

test("bare pass inside a word is spared, separated names are caught", () => {
  expect(redact("compass=north-by-northwest")).toBe("compass=north-by-northwest");
  expect(redact("bypass=north-by-northwest")).toBe("bypass=north-by-northwest");
  expect(redact("DB_PASSWORD=Sup3rS3cretPw")).toContain("[redacted:secret-assignment]");
  expect(redact("password: Sup3rS3cretPw")).toContain("[redacted:secret-assignment]");
});

const nowRedacted = [
  'secretKey: "EXAMPLEKEYEXAMPLEKEYEXAMPLE1"',
  "jwtSecretKey=1111222233334444",
  'tokenValue = "abc123abc123"',
  'apiKeyProd: "abab1212abab1212"',
  'accessTokenValue: "abab1212abab1212"',
  "passwords: hunter2hunter2",
  "password: correcthorsebattery",
  "token: abcdefghijklmnopqrs",
  "password = letmeinplease",
];
for (const s of nowRedacted) {
  test(`redacts: ${s}`, () => {
    expect(redact(s)).toContain("[redacted:secret-assignment]");
  });
}

for (const s of [
  "tokenizer: sentencepiece_model",
  "tokens = tokenize(input_text)",
  "secretName: my-app-secrets",
  "The secret: consistency beats intensity.",
]) {
  test(`spared: ${s}`, () => {
    expect(redact(s)).toBe(s);
  });
}
