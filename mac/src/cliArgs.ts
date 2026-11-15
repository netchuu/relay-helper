/** Command-line arguments for `relay <command>`: strict, so a typo stops the command instead of being ignored. */

export interface ArgSpec {
  flags?: string[];
  options?: string[];
}

export interface ParsedArgs {
  /** `--help` or `-h` was given: print the usage and do nothing else. */
  help: boolean;
  flags: Set<string>;
  options: Map<string, string>;
}

export const isHelp = (args: string[]): boolean => args.includes("--help") || args.includes("-h");

/**
 * Splits `args` into flags and options. Throws on an unknown flag, an option without a value (or with a
 * flag as its value) and on leftover arguments.
 */
export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  if (isHelp(args)) return { help: true, flags, options };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (spec.flags?.includes(arg)) flags.add(arg);
    else if (spec.options?.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      options.set(arg, value);
      i++;
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else throw new Error(`unexpected argument ${arg}`);
  }
  return { help: false, flags, options };
}
