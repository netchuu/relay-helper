import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALL_SH = resolve(import.meta.dir, "../../release/install.sh");

// Stands in for the release binary: `install` copies itself to $RELAY_HOME/bin and exits with
// STUB_INSTALL_EXIT (1 = "daemon did not start"), `pair` just leaves a marker.
const STUB = `#!/bin/sh
case "$1" in
  install)
    mkdir -p "$RELAY_HOME/bin"
    cp "$0" "$RELAY_HOME/bin/relay"
    echo hooks > "$HOME/hooks-written"
    if [ "$STUB_INSTALL_EXIT" != 0 ]; then echo "• daemon did not start; see $RELAY_HOME/daemon.log"; fi
    exit "$STUB_INSTALL_EXIT" ;;
  pair)
    echo paired > "$HOME/pair-ran"
    exit "\${STUB_PAIR_EXIT:-0}" ;;
esac
`;

async function text(cmd: string[]) {
  return (await new Response(Bun.spawn(cmd).stdout).text()).trim();
}

async function runInstaller(installExit: number, pairExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "install-sh-"));
  try {
    const home = join(root, "home");
    const release = join(root, "release");
    mkdirSync(home);
    mkdirSync(release);
    const m = await text(["uname", "-m"]);
    const arch = m === "arm64" || m === "aarch64" ? "arm64" : "x64";
    const os = (await text(["uname", "-s"])) === "Darwin" ? "darwin" : "linux";
    const name = `relay-0.0.0-${os}-${arch}`;
    mkdirSync(join(release, name));
    writeFileSync(join(release, name, "relay"), STUB);
    chmodSync(join(release, name, "relay"), 0o755);
    const tar = Bun.spawn(
      ["sh", "-c", `tar -czf ${name}.tar.gz ${name} && shasum -a 256 ${name}.tar.gz > SHA256SUMS`],
      { cwd: release, stdout: "pipe", stderr: "pipe" },
    );
    expect(await tar.exited).toBe(0);

    const p = Bun.spawn(["sh", INSTALL_SH], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        RELAY_HOME: join(home, ".relay"),
        RELAY_VERSION: "0.0.0",
        RELAY_BASE_URL: `file://${release}`,
        STUB_INSTALL_EXIT: String(installExit),
        STUB_PAIR_EXIT: String(pairExit),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    const code = await p.exited;
    let linked = false;
    try {
      linked = lstatSync(join(home, ".local/bin/relay")).isSymbolicLink();
    } catch {}
    return {
      code,
      out,
      hooksWritten: existsSync(join(home, "hooks-written")),
      linked,
      pairRan: existsSync(join(home, "pair-ran")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("daemon started: installer links relay, pairs and exits 0", async () => {
  const r = await runInstaller(0);
  expect(r).toMatchObject({ code: 0, hooksWritten: true, linked: true, pairRan: true });
});

test("daemon slow to start but pair succeeds: installer links relay and exits 0", async () => {
  const r = await runInstaller(1, 0);
  expect(r.hooksWritten).toBe(true);
  expect(r.linked).toBe(true);
  expect(r.pairRan).toBe(true);
  expect(r.code).toBe(0);
});

test("daemon never started: install and pair fail, installer exits non-zero", async () => {
  const r = await runInstaller(1, 1);
  expect(r.hooksWritten).toBe(true);
  expect(r.linked).toBe(true);
  expect(r.pairRan).toBe(true);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("relay doctor");
});

// Which build the installer asks for on a Linux system, with uname, ldd and /etc/os-release stubbed.
async function pickedBuild(opts: { ldd?: string; osRelease?: string; muslLoader?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "install-sh-libc-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("uname", 'if [ "$1" = -m ]; then echo x86_64; else echo Linux; fi');
    stub("curl", "exit 22");
    if (opts.ldd !== undefined) stub("ldd", opts.ldd);
    const osRelease = join(root, "os-release");
    writeFileSync(osRelease, opts.osRelease ?? "ID=debian\n");
    // Bare PATH without ldd, so only the stub decides.
    if (opts.muslLoader) stub("ls", "exit 0");
    for (const tool of ["sh", "grep", "sed", "head", "mktemp", "rm", "cut", "awk", "ls", "dirname"]) {
      if (tool === "ls" && opts.muslLoader) continue;
      const found = await text(["sh", "-c", `command -v ${tool}`]);
      if (found) await Bun.spawn(["ln", "-s", found, join(bin, tool)]).exited;
    }
    const p = Bun.spawn(["sh", INSTALL_SH], {
      env: { PATH: bin, HOME: root, RELAY_VERSION: "0.0.0", RELAY_OS_RELEASE: osRelease },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return /\(linux-([a-z0-9-]+)\)/.exec(out)?.[1];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const GLIBC_LDD = 'echo "ldd (Debian GLIBC 2.36-9+deb12u7) 2.36"';
const MUSL_LDD = 'echo "musl libc (x86_64)" >&2; echo "Version 1.2.5" >&2; exit 1';

test("glibc with the musl package installed gets the glibc build", async () => {
  expect(await pickedBuild({ ldd: GLIBC_LDD, muslLoader: true })).toBe("x64");
});

test("glibc alone gets the glibc build", async () => {
  expect(await pickedBuild({ ldd: GLIBC_LDD })).toBe("x64");
});

test("Alpine (musl ldd) gets the musl build", async () => {
  expect(await pickedBuild({ ldd: MUSL_LDD, osRelease: "ID=alpine\n" })).toBe("x64-musl");
});

test("Alpine without ldd gets the musl build from os-release", async () => {
  expect(await pickedBuild({ osRelease: "ID=alpine\n" })).toBe("x64-musl");
});
