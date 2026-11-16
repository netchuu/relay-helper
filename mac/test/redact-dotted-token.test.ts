import { expect, test } from "bun:test";
import { redact } from "../src/daemon/redact.ts";

// Made-up values. Shapes: a Discord bot token (three base64url parts), a SendGrid key without `-`, a dotted password.
const DISCORD = "MabcdefGHIJKLmnopqrSTUVwx.Abcdef.ZyxwvUTSRqponmLKJIhgfedCBA0";
// Joined at run time so a secret scanner doesn't flag the file.
const SENDGRID = ["SG", "abcdefGHIJKLmnopqrSTUV", "ZyxwvUTSRqponmLKJIhgfedCBA0123456789abcdefg"].join(".");
const leaks = [
  `DISCORD_TOKEN=${DISCORD}`,
  `SENDGRID_API_KEY=${SENDGRID}`,
  "DB_PASSWORD=Winter.Is.Coming",
  `export DISCORD_TOKEN=${DISCORD}`,
  "password: Winter.Is.Coming",
];

for (const s of leaks) {
  test(`redacts ${s.slice(0, 28)}…`, () => {
    expect(redact(s)).toContain("[redacted:");
  });
}

test("code references stay", () => {
  for (const s of [
    "password: req.body.password",
    "token = process.env.GITHUB_TOKEN",
    "secret: this.props.secret",
    "apiKey = config.api.apiKey",
    "password: form.data.password",
  ])
    expect(redact(s)).toBe(s);
});

test("the same value quoted, or with a digit-led segment, is redacted", () => {
  expect(redact(`DISCORD_TOKEN="${DISCORD}"`)).toContain("[redacted:");
  expect(redact(`DB_PASSWORD=${["Winter", "1s", "Coming"].join(".")}`)).toContain("[redacted:");
});
