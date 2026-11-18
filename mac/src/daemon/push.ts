export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsResult {
  status: number;
  reason?: string;
}

/** Device tokens that will never work again and should be forgotten. */
export function isDeadToken(result: ApnsResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 &&
      (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))
  );
}
