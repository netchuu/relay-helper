/**
 * Seconds since the last key was pressed on this Mac's keyboard (mouse and trackpad don't count), from Core Graphics'
 * CGEventSourceSecondsSinceLastEventType on the hardware event state, so keys Relay itself posts don't count either.
 * Through bun:ffi, loaded on first use; null when it can't be read.
 */
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
