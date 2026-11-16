/** Seconds since the last real input, via CGEventSource on the hardware state (null if unreadable). */
import { dlopen, FFIType } from "bun:ffi";

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const HID_SYSTEM_STATE = 1;
const KEY_DOWN = 10;
/** kCGAnyInputEventType: keyboard, mouse, trackpad and scrolling. */
const ANY_INPUT = 0xffffffff;

let read: ((state: number, type: number) => number) | null | undefined;

function secondsSince(type: number): number | null {
  if (read === undefined) {
    try {
      const cg = dlopen(CG, {
        CGEventSourceSecondsSinceLastEventType: {
          args: [FFIType.i32, FFIType.u32],
          returns: FFIType.f64,
        },
      });
      read = cg.symbols.CGEventSourceSecondsSinceLastEventType;
    } catch {
      read = null;
    }
  }
  if (!read) return null;
  const s = read(HID_SYSTEM_STATE, type);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** Seconds since the last key press. */
export function readKeyIdleSeconds(): number | null {
  return secondsSince(KEY_DOWN);
}

/** Seconds since the last keyboard, mouse or trackpad input. */
export function readInputIdleSeconds(): number | null {
  return secondsSince(ANY_INPUT);
}
