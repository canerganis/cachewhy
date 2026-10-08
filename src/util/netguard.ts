// Network guard: cachewhy is an offline tool. When CACHEWHY_NETGUARD=1
// (set by tests and CI), every outbound network entry point throws.
//
// Covered: net/tls/http/https/http2 connections, UDP (dgram send and connect), DNS (lookup,
// lookupService and every Resolver query method, callback and promise forms), fetch,
// WebSocket, and child_process (a spawned curl would bypass everything else).
//
// cli.ts must call maybeInstallNetGuard() (or installNetGuard()) before any
// other import side effects or work, so nothing can open a socket first.

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import dns from "node:dns";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

export class NetworkAccessError extends Error {
  readonly api: string;
  constructor(api: string) {
    super(`Network access is blocked (CACHEWHY_NETGUARD=1): ${api}`);
    this.name = "NetworkAccessError";
    this.api = api;
  }
}

type Anyish = Record<string, unknown>;
type Restore = () => void;
/** sync: throws. async: returns a rejected promise. ctor: a constructor that throws. */
type Mode = "sync" | "async" | "ctor";

let restoreFns: Restore[] | null = null;

function patch(target: Anyish, key: string, api: string, restore: Restore[], mode: Mode = "sync"): void {
  const original = target[key];
  if (original === undefined) return;
  let guarded: unknown;
  if (mode === "async") {
    guarded = (): Promise<never> => Promise.reject(new NetworkAccessError(api));
  } else if (mode === "ctor") {
    guarded = function guardedCtor(): never {
      throw new NetworkAccessError(api);
    };
  } else {
    guarded = (): never => {
      throw new NetworkAccessError(api);
    };
  }
  target[key] = guarded;
  restore.push(() => {
    target[key] = original;
  });
}

/** Own method names of a prototype (the Resolver query methods), without the constructor. */
function methodNames(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter(
    (k) => k !== "constructor" && typeof (proto as Anyish)[k] === "function",
  );
}

/** Install the guard. Idempotent. */
export function installNetGuard(): void {
  if (restoreFns) return;
  const restore: Restore[] = [];

  const n = net as unknown as Anyish;
  patch(n, "connect", "net.connect", restore);
  patch(n, "createConnection", "net.createConnection", restore);
  patch(net.Socket.prototype as unknown as Anyish, "connect", "net.Socket.connect", restore);
  patch(tls as unknown as Anyish, "connect", "tls.connect", restore);

  patch(http as unknown as Anyish, "request", "http.request", restore);
  patch(http as unknown as Anyish, "get", "http.get", restore);
  patch(https as unknown as Anyish, "request", "https.request", restore);
  patch(https as unknown as Anyish, "get", "https.get", restore);
  patch(http2 as unknown as Anyish, "connect", "http2.connect", restore);

  // UDP: an outbound datagram needs send() or connect().
  const udp = dgram.Socket.prototype as unknown as Anyish;
  patch(udp, "send", "dgram.Socket.send", restore);
  patch(udp, "connect", "dgram.Socket.connect", restore);

  // DNS: dns.lookup uses getaddrinfo, but every Resolver method sends its own UDP/TCP queries.
  const d = dns as unknown as Anyish;
  patch(d, "lookup", "dns.lookup", restore);
  patch(d, "lookupService", "dns.lookupService", restore);
  for (const name of methodNames(dns.Resolver.prototype)) {
    patch(dns.Resolver.prototype as unknown as Anyish, name, `dns.Resolver.${name}`, restore);
    // The module level resolve* functions are bound to a default Resolver at load time,
    // so patching the prototype alone does not reach them.
    patch(d, name, `dns.${name}`, restore);
  }
  const dp = dns.promises as unknown as Anyish;
  patch(dp, "lookup", "dns.promises.lookup", restore, "async");
  patch(dp, "lookupService", "dns.promises.lookupService", restore, "async");
  for (const name of methodNames(dns.promises.Resolver.prototype)) {
    patch(dns.promises.Resolver.prototype as unknown as Anyish, name, `dns.promises.Resolver.${name}`, restore, "async");
    patch(dp, name, `dns.promises.${name}`, restore, "async");
  }

  patch(globalThis as unknown as Anyish, "fetch", "fetch", restore, "async");
  patch(globalThis as unknown as Anyish, "WebSocket", "WebSocket", restore, "ctor");

  // cachewhy never spawns processes; a child curl or nc would bypass every guard above.
  const cp = childProcess as unknown as Anyish;
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    patch(cp, name, `child_process.${name}`, restore);
  }

  restoreFns = restore;
  // Named ESM imports (import { request } from "node:http") are snapshots until synced.
  syncBuiltinESMExports();
}

/** Remove the guard and restore the original functions (used by tests). */
export function uninstallNetGuard(): void {
  if (!restoreFns) return;
  for (const fn of restoreFns.reverse()) fn();
  restoreFns = null;
  syncBuiltinESMExports();
}

export function isNetGuardInstalled(): boolean {
  return restoreFns !== null;
}

/** Install the guard only when CACHEWHY_NETGUARD=1. Returns whether it is active. */
export function maybeInstallNetGuard(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CACHEWHY_NETGUARD === "1") installNetGuard();
  return isNetGuardInstalled();
}
