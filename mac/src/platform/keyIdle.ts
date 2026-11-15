/** Seconds since the last real key press, via CGEventSource on the hardware state (null if unreadable). */
import { dlopen, FFIType } from "bun:ffi";

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const HID_SYSTEM_STATE = 1;
const KEY_DOWN = 10;

let read: ((state: number, type: number) => number) | null | undefined;

export function readKeyIdleSeconds(): number | null {
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
  const s = read(HID_SYSTEM_STATE, KEY_DOWN);
  return Number.isFinite(s) && s >= 0 ? s : null;
}
