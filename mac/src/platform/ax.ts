/**
 * A small binding to the macOS Accessibility API (ApplicationServices) through bun:ffi, for typing a reply into
 * the Claude desktop app and IDE panels while they stay in the background.
 * In-process, so the Accessibility permission belongs to the `relay` binary itself; nothing else to ship.
 *
 * Only loaded on macOS, and only when a delivery needs it. Every Core Foundation object copied here is released.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const AS = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const UTF8 = 0x08000100;

/**
 * A Core Foundation reference, as an exact 64-bit integer. Never a JS number: on Apple Silicon short CFStrings
 * are tagged pointers with the top bits set, which a double can't hold, and a rounded pointer crashes.
 */
type Ref = bigint;
const U64 = FFIType.u64;

type Lib = ReturnType<typeof load>;
let lib: Lib | null = null;

function load() {
  const cf = dlopen(CF, {
    CFStringCreateWithCString: { args: [U64, FFIType.cstring, FFIType.u32], returns: U64 },
    CFStringGetLength: { args: [U64], returns: FFIType.i64 },
    CFStringGetCString: { args: [U64, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
    CFGetTypeID: { args: [U64], returns: U64 },
    CFStringGetTypeID: { args: [], returns: U64 },
    CFArrayGetTypeID: { args: [], returns: U64 },
    CFBooleanGetTypeID: { args: [], returns: U64 },
    CFArrayGetCount: { args: [U64], returns: FFIType.i64 },
    CFArrayGetValueAtIndex: { args: [U64, FFIType.i64], returns: U64 },
    CFBooleanGetValue: { args: [U64], returns: FFIType.bool },
    CFRelease: { args: [U64], returns: FFIType.void },
    CFEqual: { args: [U64, U64], returns: FFIType.bool },
    CFDictionaryCreate: { args: [U64, FFIType.ptr, FFIType.ptr, FFIType.i64, U64, U64], returns: U64 },
  });
  const ax = dlopen(AS, {
    AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    AXIsProcessTrustedWithOptions: { args: [U64], returns: FFIType.bool },
    AXUIElementCreateApplication: { args: [FFIType.i32], returns: U64 },
    AXUIElementCopyAttributeValue: { args: [U64, U64, FFIType.ptr], returns: FFIType.i32 },
    AXUIElementSetAttributeValue: { args: [U64, U64, U64], returns: FFIType.i32 },
    AXUIElementPerformAction: { args: [U64, U64], returns: FFIType.i32 },
  });
  const cg = dlopen(CG, {
    CGEventSourceCreate: { args: [FFIType.i32], returns: U64 },
    CGEventCreateKeyboardEvent: { args: [U64, FFIType.u16, FFIType.bool], returns: U64 },
    CGEventKeyboardSetUnicodeString: { args: [U64, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    CGEventSetFlags: { args: [U64, FFIType.u64], returns: FFIType.void },
    CGEventPostToPid: { args: [FFIType.i32, U64], returns: FFIType.void },
  });
  // kCFBooleanTrue/False are data symbols: look their addresses up and copy out the references stored there.
  const dl = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: [FFIType.cstring, FFIType.i32], returns: U64 },
    dlsym: { args: [U64, FFIType.cstring], returns: U64 },
    memcpy: { args: [FFIType.ptr, U64, U64], returns: U64 },
  });
  const RTLD_NOW = 2;
  const handle = dl.symbols.dlopen(Buffer.from(`${CF}\0`), RTLD_NOW);
  const axHandle = dl.symbols.dlopen(Buffer.from(`${AS}\0`), RTLD_NOW);
  if (!handle || !axHandle) throw new Error("dlopen failed");
  /** The address of a data symbol. */
  const symbol = (h: Ref, name: string): Ref => {
    const addr = dl.symbols.dlsym(h, Buffer.from(`${name}\0`));
    if (!addr) throw new Error(`${name} not found`);
    return addr;
  };
  /** The reference a data symbol holds (kCFBooleanTrue, kAXTrustedCheckOptionPrompt). */
  const symbolValue = (h: Ref, name: string): Ref => {
    const out = Buffer.alloc(8);
    dl.symbols.memcpy(ptr(out), symbol(h, name), 8n);
    return out.readBigUInt64LE(0);
  };
  const boolRef = (name: string): Ref => symbolValue(handle, name);
  return {
    // Keep the library objects themselves alive for the life of the process.
    libraries: [cf, ax, dl, cg],
    cf: cf.symbols,
    cg: cg.symbols,
    ax: ax.symbols,
    TRUE: boolRef("kCFBooleanTrue"),
    PROMPT_KEY: symbolValue(axHandle, "kAXTrustedCheckOptionPrompt"),
    KEY_CALLBACKS: symbol(handle, "kCFTypeDictionaryKeyCallBacks"),
    VALUE_CALLBACKS: symbol(handle, "kCFTypeDictionaryValueCallBacks"),
    FALSE: boolRef("kCFBooleanFalse"),
    types: {
      string: cf.symbols.CFStringGetTypeID(),
      array: cf.symbols.CFArrayGetTypeID(),
      boolean: cf.symbols.CFBooleanGetTypeID(),
    },
    names: new Map<string, Ref>(),
  };
}

function L(): Lib {
  lib ??= load();
  return lib;
}

/** A CFString for an attribute or action name; kept for the life of the process. */
function name(s: string): Ref {
  const l = L();
  let p = l.names.get(s);
  if (!p) {
    p = cfString(s);
    l.names.set(s, p);
  }
  return p;
}

function cfString(s: string): Ref {
  const p = L().cf.CFStringCreateWithCString(0n, Buffer.from(`${s}\0`, "utf8"), UTF8);
  if (!p) throw new Error("CFStringCreateWithCString failed");
  return p;
}

function toJs(ref: Ref): string {
  const l = L();
  const len = Number(l.cf.CFStringGetLength(ref));
  const buf = Buffer.alloc(len * 4 + 1);
  return l.cf.CFStringGetCString(ref, ptr(buf), buf.length, UTF8)
    ? buf.toString("utf8", 0, buf.indexOf(0))
    : "";
}

/** True when this process may use Accessibility (System Settings → Privacy & Security → Accessibility). */
export function trusted(): boolean {
  return L().ax.AXIsProcessTrusted();
}

/**
 * Asks macOS for Accessibility the system way: if this process isn't allowed yet, macOS shows its own dialog
 * ("relay" would like to control this computer…) with a button to System Settings, and lists relay there, so
 * the person only turns it on. Returns whether it's allowed now.
 */
export function requestTrust(): boolean {
  const l = L();
  const keys = Buffer.alloc(8);
  const values = Buffer.alloc(8);
  keys.writeBigUInt64LE(l.PROMPT_KEY);
  values.writeBigUInt64LE(l.TRUE);
  const options = l.cf.CFDictionaryCreate(0n, ptr(keys), ptr(values), 1, l.KEY_CALLBACKS, l.VALUE_CALLBACKS);
  try {
    return l.ax.AXIsProcessTrustedWithOptions(options);
  } finally {
    if (options) l.cf.CFRelease(options);
  }
}

const RETURN_KEY = 36;
const SHIFT_FLAG = 0x20000n;

/**
 * Types `text` into the app `pid` as keystrokes, followed by Return, without bringing it forward: the events go
 * to that process (CGEventPostToPid) and land in its focused element. Characters are sent as Unicode, so the
 * keyboard layout doesn't matter; a newline is Shift+Return, so it doesn't submit early.
 */
export async function typeToPid(
  pid: number,
  text: string,
  opts: { submit: boolean; delayMs?: number },
): Promise<void> {
  const l = L();
  const source = l.cg.CGEventSourceCreate(1); // kCGEventSourceStateHIDSystemState
  const post = (key: number, down: boolean, chars: string | null, shift = false) => {
    const event = l.cg.CGEventCreateKeyboardEvent(source, key, down);
    if (!event) return;
    if (chars !== null) {
      const units = Buffer.from(chars, "utf16le");
      l.cg.CGEventKeyboardSetUnicodeString(event, BigInt(units.length / 2), ptr(units));
    }
    // Always set the flags: a modifier the person holds in another app must not turn a character into a shortcut.
    l.cg.CGEventSetFlags(event, shift ? SHIFT_FLAG : 0n);
    l.cg.CGEventPostToPid(pid, event);
    l.cf.CFRelease(event);
  };
  try {
    const delay = opts.delayMs ?? 6;
    for (const ch of text.replace(/\r\n?/g, "\n")) {
      if (ch === "\n") {
        post(RETURN_KEY, true, null, true);
        post(RETURN_KEY, false, null, true);
      } else {
        post(0, true, ch);
        post(0, false, ch);
      }
      await Bun.sleep(delay);
    }
    if (opts.submit) {
      await Bun.sleep(200);
      post(RETURN_KEY, true, null);
      post(RETURN_KEY, false, null);
    }
  } finally {
    if (source) l.cf.CFRelease(source);
  }
}

/** One element of an app's Accessibility tree. Call `release()` on the root when done; children are released with it. */
export class AxElement {
  private owned: Ref[] = [];

  private constructor(
    readonly ref: Ref,
    private readonly root: AxElement | null,
  ) {}

  static app(pid: number): AxElement {
    const ref = L().ax.AXUIElementCreateApplication(pid);
    if (!ref) throw new Error("AXUIElementCreateApplication failed");
    const el = new AxElement(ref, null);
    el.owned.push(ref);
    return el;
  }

  private keep(p: Ref): void {
    (this.root ?? this).owned.push(p);
  }

  /** The raw attribute value (retained by this tree), or null. */
  private copy(attr: string): Ref | null {
    const out = Buffer.alloc(8);
    if (L().ax.AXUIElementCopyAttributeValue(this.ref, name(attr), ptr(out)) !== 0) return null;
    const p = out.readBigUInt64LE(0);
    if (p === 0n) return null;
    this.keep(p);
    return p;
  }

  string(attr: string): string {
    const v = this.copy(attr);
    return v && L().cf.CFGetTypeID(v) === L().types.string ? toJs(v) : "";
  }

  bool(attr: string): boolean {
    const v = this.copy(attr);
    return v !== null && L().cf.CFGetTypeID(v) === L().types.boolean && L().cf.CFBooleanGetValue(v);
  }

  elements(attr: string): AxElement[] {
    const v = this.copy(attr);
    if (!v || L().cf.CFGetTypeID(v) !== L().types.array) return [];
    const out: AxElement[] = [];
    const n = Number(L().cf.CFArrayGetCount(v));
    for (let i = 0; i < n; i++) {
      const child = L().cf.CFArrayGetValueAtIndex(v, i);
      if (child) out.push(new AxElement(child, this.root ?? this));
    }
    return out;
  }

  element(attr: string): AxElement | null {
    const v = this.copy(attr);
    return v ? new AxElement(v, this.root ?? this) : null;
  }

  get role(): string {
    return this.string("AXRole");
  }

  /** Title and description, as people read the control ("Send", "PROBE-DESK, rename session"). */
  get label(): string {
    return `${this.string("AXTitle")} ${this.string("AXDescription")}`.trim();
  }

  get children(): AxElement[] {
    return this.elements("AXChildren");
  }

  setBool(attr: string, value: boolean): boolean {
    return L().ax.AXUIElementSetAttributeValue(this.ref, name(attr), value ? L().TRUE : L().FALSE) === 0;
  }

  setString(attr: string, value: string): boolean {
    const s = cfString(value);
    try {
      return L().ax.AXUIElementSetAttributeValue(this.ref, name(attr), s) === 0;
    } finally {
      L().cf.CFRelease(s);
    }
  }

  /** The same element (each lookup returns a new reference to it). */
  equals(other: AxElement): boolean {
    return L().cf.CFEqual(this.ref, other.ref);
  }

  press(): boolean {
    return L().ax.AXUIElementPerformAction(this.ref, name("AXPress")) === 0;
  }

  /** Depth-first search of the subtree. */
  findAll(match: (e: AxElement) => boolean, maxDepth = 70): AxElement[] {
    const out: AxElement[] = [];
    const walk = (e: AxElement, depth: number) => {
      if (depth > maxDepth) return;
      if (match(e)) out.push(e);
      for (const c of e.children) walk(c, depth + 1);
    };
    walk(this, 0);
    return out;
  }

  /** Releases every Core Foundation object this tree copied. Only on the root. */
  release(): void {
    for (const p of this.owned.splice(0)) L().cf.CFRelease(p);
  }
}
