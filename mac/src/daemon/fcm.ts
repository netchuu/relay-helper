export interface FcmResult {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** FCM's errorCode (UNREGISTERED, INVALID_ARGUMENT, …) or, failing that, the Google API status. */
  reason?: string;
}

export interface FcmMessage {
  data: Record<string, string>;
  android: { priority: "high" | "normal"; collapse_key?: string; ttl: string };
}

/** FCM registration tokens that will never work again and should be forgotten. */
export function isDeadFcmToken(result: FcmResult): boolean {
  return (
    result.reason === "UNREGISTERED" ||
    result.status === 404 ||
    (result.status === 400 && result.reason === "INVALID_ARGUMENT")
  );
}
