/**
 * Per-address request limits for the /v1/ routes, checked before any Durable Object is touched. The numbers and
 * the reasoning behind them are in wrangler.jsonc (`ratelimits`).
 */

/** Cloudflare's rate limiting binding (RateLimit in the Workers types), spelled out so the tests can import this. */
interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface LimitEnv {
  /** Mac and phone connects, counted per class. */
  CONNECT_LIMIT?: Limiter;
  /** Pushes. */
  PUSH_LIMIT?: Limiter;
}

/** What a request is counted as: each class has its own count per address, so pushes don't use up connects. */
export type RouteClass = "mac" | "phone" | "push";

/** The class of a /v1/ request, or null for a route that is not limited. */
export function routeClass(url: URL): RouteClass | null {
  if (url.pathname === "/v1/push") return "push";
  if (url.pathname === "/v1/connect") return url.searchParams.get("role") === "mac" ? "mac" : "phone";
  return null;
}

let limiterFailed = false;

/**
 * Whether the request's address is still under its limit for this class. Lets the request through when the
 * limiter is missing (a plan or a local setup without it) or fails: an outage of the limiter must not take the
 * relay down with it. Logs a fixed line once, never the key or the error (the key holds an address).
 */
export async function withinLimit(env: LimitEnv, cls: RouteClass, request: Request): Promise<boolean> {
  const limiter = cls === "push" ? env.PUSH_LIMIT : env.CONNECT_LIMIT;
  if (!limiter) return true;
  try {
    const outcome = await limiter.limit({
      key: `${cls}:${addressKey(request.headers.get("cf-connecting-ip") ?? "")}`,
    });
    return outcome?.success !== false;
  } catch {
    if (!limiterFailed) console.warn("the request limiter failed; requests go through unlimited");
    limiterFailed = true;
    return true;
  }
}

/**
 * The address a limit counts by: an IPv4 address as it is, an IPv6 address by its /64, the block one home or
 * phone usually gets (counting single IPv6 addresses would let one client take a new address for every request).
 */
export function addressKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.toLowerCase().split("::", 2);
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
