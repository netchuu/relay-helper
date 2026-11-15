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
