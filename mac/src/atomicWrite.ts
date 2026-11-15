import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** Follows symlinks (also a dangling one) so a write lands in the file the link points to. */
export function resolveLink(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) return resolve(dirname(path), readlinkSync(path));
    } catch {
      // Not there at all: the path itself.
    }
    return path;
  }
}

/** Throws a clear error, touching nothing, when `path` (after links) is a file we can't write. */
export function assertWritable(path: string): void {
  const target = resolveLink(path);
  try {
    accessSync(target, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const where = target === path ? path : `${path} (a link to ${target})`;
    throw new Error(`Can't write ${where}: ${(error as Error).message}. Nothing was changed.`);
  }
}

/** Writes tmp + rename next to the real file, so a symlinked `path` stays a link and the target changes. */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
  const target = resolveLink(path);
  const tmp = `${target}.relay-tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, target);
}
