import type { Server, ServerWebSocket } from "bun";
import { PROTOCOL_VERSION, type RelayEvent, RpcRequest } from "../../../protocol/index.ts";
import { askForAccessibility, axAllowed } from "../integrations/claudeDesktop.ts";
import { errMessage, log } from "../log.ts";
import { hostInfo } from "../platform/index.ts";
import {
  authenticate,
  createPairingCode,
  type Device,
  isDeviceActive,
  listDevices,
  onDeviceRevoked,
  pairingAttemptAllowed,
  redeemPairingCode,
  revokeDevice,
} from "./auth.ts";
import type { DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import type { HookEnvelope, HookHandler } from "./hooks.ts";
import type { RpcOutcome } from "./rpc.ts";

type Rpc = (method: string, params: unknown, actor: string) => Promise<RpcOutcome>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Local-only server on a Unix socket inside ~/.relay (mode 0700): hook traffic and admin commands from
 * the `relay` CLI. Filesystem permissions are the authentication.
 */
export function startLocalServer(opts: {
  socketPath: string;
  hooks: HookHandler;
  rpc: Rpc;
  events: EventLog;
  db: DB;
  publicUrl: () => string | null;
}): Server<undefined> {
  const options = {
    unix: opts.socketPath,
    // PermissionRequest hooks wait for an answer for as long as the prompt is open. Bun's default 10 s
    // idle timeout also applies to Unix sockets (verified on 1.3.10) even though its types omit the
    // option there, hence the cast below.
    idleTimeout: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      try {
        if (req.method === "POST" && url.pathname === "/hook") {
          const envelope = (await req.json()) as HookEnvelope;
          return json(await opts.hooks.handle(envelope, req.signal));
        }
        if (req.method === "GET" && url.pathname === "/health")
          return json({ ok: true, protocol: PROTOCOL_VERSION });
        if (req.method === "POST" && url.pathname === "/admin/rpc") {
          const body = RpcRequest.parse(await req.json());
          return json(await opts.rpc(body.method, body.params, "cli"));
        }
        if (req.method === "GET" && url.pathname === "/admin/stream") {
          return streamEvents(opts.events, Number(url.searchParams.get("since") ?? "0"), req.signal);
        }
        if (req.method === "POST" && url.pathname === "/admin/pair") {
          return json({ ...createPairingCode(opts.db), url: opts.publicUrl() });
        }
        if (req.method === "GET" && url.pathname === "/admin/devices") return json(listDevices(opts.db));
        // Permissions as the service itself has them (macOS grants them per process, so a terminal running
        // `relay doctor` may have Accessibility while the service doesn't).
        if (req.method === "GET" && url.pathname === "/admin/permissions")
          return json({ accessibility: axAllowed() });
        // relay install / relay pair: the person is at the terminal, so ask now even if asked recently.
        if (req.method === "POST" && url.pathname === "/admin/permissions/ask")
          return json({ accessibility: askForAccessibility({ force: true }) === "allowed" });
        if (req.method === "POST" && url.pathname === "/admin/devices/revoke") {
          const { id } = (await req.json()) as { id: string };
          return json({ revoked: revokeDevice(opts.db, id) });
        }
        return json({ error: "not found" }, 404);
      } catch (err) {
        log.error("local api error", { path: url.pathname, err: errMessage(err) });
        return json({ error: errMessage(err) }, 400);
      }
    },
  };
  return Bun.serve(options as unknown as Parameters<typeof Bun.serve<undefined>>[0]);
}

/** NDJSON stream of events for `relay tail`. */
function streamEvents(events: EventLog, since: number, signal: AbortSignal): Response {
  let unsubscribe = () => {};
  const stream = new ReadableStream<string>({
    start(controller) {
      for (const e of events.since(since)) controller.enqueue(`${JSON.stringify(e)}\n`);
      unsubscribe = events.subscribe((e) => controller.enqueue(`${JSON.stringify(e)}\n`));
      signal.addEventListener("abort", () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

interface WsData {
  device: Device;
  unsubscribe: () => void;
  stopRevokeWatch?: () => void;
}

/** 4401: app-defined "unauthorized"; the client reconnects, gets a 401 and shows pairing again. */
function closeRevoked(ws: ServerWebSocket<WsData>): void {
  ws.data.unsubscribe();
  ws.data.stopRevokeWatch?.();
  ws.close(4401, "device revoked");
}

/**
 * App API on 127.0.0.1 only. The phone reaches it through `tailscale serve` (HTTPS inside your
 * tailnet); nothing listens on a public interface.
 */
export function startAppServer(opts: { port: number; rpc: Rpc; events: EventLog; db: DB }): Server<WsData> {
  return Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health")
        return json({ ok: true, protocol: PROTOCOL_VERSION });

      if (req.method === "POST" && url.pathname === "/pair") {
        if (!pairingAttemptAllowed()) return json({ error: "too many attempts, wait a minute" }, 429);
        const body = (await req.json().catch(() => ({}))) as { code?: string; deviceName?: string };
        const res = body.code ? redeemPairingCode(opts.db, body.code, body.deviceName ?? "iPhone") : null;
        if (!res) return json({ error: "invalid or expired pairing code" }, 401);
        log.info("device paired", { device: res.device.name });
        return json({
          deviceId: res.device.id,
          token: res.token,
          pushKey: res.pushKey,
          protocol: PROTOCOL_VERSION,
          host: await hostInfo(),
        });
      }

      const device = authenticate(opts.db, req.headers.get("authorization"));
      if (!device) return json({ error: "unauthorized" }, 401);

      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { device, unsubscribe: () => {} } })) return undefined;
        return json({ error: "expected a WebSocket upgrade" }, 426);
      }
      if (req.method === "POST" && url.pathname === "/rpc") {
        const parsed = RpcRequest.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return json({ error: { code: "bad_request", message: "invalid request" } }, 400);
        return json(await opts.rpc(parsed.data.method, parsed.data.params, `device:${device.id}`));
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      open(ws: ServerWebSocket<WsData>) {
        ws.data.unsubscribe = opts.events.subscribe((event: RelayEvent) => {
          // Revoked while connected: stop at once; the reconnect gets a 401 and the phone asks to re-pair.
          if (!isDeviceActive(opts.db, ws.data.device.id)) return closeRevoked(ws);
          // 0 = dropped: close so the client reconnects and resyncs from its last seq.
          if (ws.send(JSON.stringify({ type: "event", event })) === 0) ws.close(1013, "backpressure");
        });
        // Revoked (relay devices revoke / Unpair) while connected and idle: drop the socket right away.
        ws.data.stopRevokeWatch = onDeviceRevoked((id) => {
          if (id === ws.data.device.id) closeRevoked(ws);
        });
      },
      async message(ws, raw) {
        if (!isDeviceActive(opts.db, ws.data.device.id)) return closeRevoked(ws);
        let req: RpcRequest;
        try {
          req = RpcRequest.parse(JSON.parse(String(raw)));
        } catch {
          ws.send(
            JSON.stringify({
              type: "rpc",
              id: null,
              error: { code: "bad_request", message: "invalid JSON-RPC message" },
            }),
          );
          return;
        }
        const outcome = await opts.rpc(req.method, req.params, `device:${ws.data.device.id}`);
        ws.send(JSON.stringify({ type: "rpc", id: req.id ?? null, ...outcome }));
      },
      close(ws) {
        ws.data.unsubscribe();
        ws.data.stopRevokeWatch?.();
      },
    },
  });
}
