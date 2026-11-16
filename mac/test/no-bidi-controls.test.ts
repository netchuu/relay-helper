import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;
const SRC = join(import.meta.dir, "..", "src");

test("no source file holds a raw bidi control character", () => {
  const found: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (BIDI.test(line)) found.push(`${file}:${i + 1}`);
      });
  }
  expect(found).toEqual([]);
});
