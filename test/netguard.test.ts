import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { request as namedRequest } from "node:http";
import {
  installNetGuard,
  uninstallNetGuard,
  maybeInstallNetGuard,
  isNetGuardInstalled,
  NetworkAccessError,
} from "../src/util/netguard.ts";

afterEach(() => uninstallNetGuard());

test("net.connect and createConnection throw", () => {
  installNetGuard();
  assert.throws(() => net.connect(9, "127.0.0.1"), NetworkAccessError);
  assert.throws(() => net.createConnection(9, "127.0.0.1"), NetworkAccessError);
  assert.throws(() => new net.Socket().connect(9, "127.0.0.1"), NetworkAccessError);
});

test("http and https request/get throw", () => {
  installNetGuard();
  assert.throws(() => http.request("http://example.invalid/"), NetworkAccessError);
  assert.throws(() => http.get("http://example.invalid/"), NetworkAccessError);
  assert.throws(() => https.request("https://example.invalid/"), NetworkAccessError);
  assert.throws(() => https.get("https://example.invalid/"), NetworkAccessError);
});

test("dns.lookup throws and dns.promises.lookup rejects", async () => {
  installNetGuard();
  assert.throws(() => dns.lookup("example.invalid", () => {}), NetworkAccessError);
  await assert.rejects(dns.promises.lookup("example.invalid"), NetworkAccessError);
});

test("fetch rejects", async () => {
  installNetGuard();
  await assert.rejects(fetch("https://example.invalid/"), NetworkAccessError);
});

test("install is idempotent and uninstall restores originals", () => {
  const original = net.connect;
  installNetGuard();
  const guarded = net.connect;
  installNetGuard();
  assert.equal(net.connect, guarded);
  assert.notEqual(guarded, original);
  uninstallNetGuard();
  assert.equal(net.connect, original);
  assert.equal(isNetGuardInstalled(), false);
});

test("maybeInstallNetGuard installs only when CACHEWHY_NETGUARD=1", () => {
  assert.equal(maybeInstallNetGuard({}), false);
  assert.equal(maybeInstallNetGuard({ CACHEWHY_NETGUARD: "0" }), false);
  assert.equal(maybeInstallNetGuard({ CACHEWHY_NETGUARD: "1" }), true);
  assert.throws(() => http.get("http://example.invalid/"), NetworkAccessError);
});

// --- UDP, Resolver, WebSocket, child_process, named imports ------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 1500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

interface Listener {
  port: number;
  count: () => number;
  close: () => Promise<void>;
}

/** A local UDP listener that counts datagrams. Null when loopback is unavailable (unshare -rn). */
async function listen(): Promise<Listener | null> {
  const sock = dgram.createSocket("udp4");
  let n = 0;
  sock.on("message", () => n++);
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, "127.0.0.1", () => resolve());
    });
  } catch {
    sock.close();
    return null;
  }
  return {
    port: sock.address().port,
    count: () => n,
    close: () => new Promise<void>((r) => sock.close(() => r())),
  };
}

test("dgram send and connect throw and no packet reaches a local listener", async () => {
  const l = await listen();
  try {
    // Control: unguarded, the packet arrives. Without loopback only the throws are checked.
    let live = false;
    if (l) {
      const c = dgram.createSocket("udp4");
      c.send(Buffer.from("x"), l.port, "127.0.0.1");
      live = await waitFor(() => l.count() === 1);
      c.close();
    }
    const before = l?.count() ?? 0;
    installNetGuard();
    const client = dgram.createSocket("udp4");
    assert.throws(() => client.send(Buffer.from("x"), l?.port ?? 9, "127.0.0.1"), NetworkAccessError);
    assert.throws(() => client.connect(l?.port ?? 9, "127.0.0.1"), NetworkAccessError);
    client.close();
    await sleep(150);
    if (l && live) assert.equal(l.count(), before);
  } finally {
    await l?.close();
  }
});

test("dns.Resolver, module resolve functions and promise Resolver are blocked", async () => {
  const l = await listen();
  try {
    let live = false;
    if (l) {
      const control = new dns.Resolver({ timeout: 100, tries: 1 });
      control.setServers([`127.0.0.1:${l.port}`]);
      control.resolve4("example.invalid", () => {});
      live = await waitFor(() => l.count() >= 1);
      control.cancel();
    }
    const before = l?.count() ?? 0;
    installNetGuard();
    const r = new dns.Resolver({ timeout: 100, tries: 1 });
    r.setServers([`127.0.0.1:${l?.port ?? 9}`]);
    assert.throws(() => r.resolve4("example.invalid", () => {}), NetworkAccessError);
    assert.throws(() => r.resolveAny("example.invalid", () => {}), NetworkAccessError);
    assert.throws(() => r.reverse("127.0.0.1", () => {}), NetworkAccessError);
    assert.throws(() => dns.resolve4("example.invalid", () => {}), NetworkAccessError);
    assert.throws(() => dns.lookupService("127.0.0.1", 80, () => {}), NetworkAccessError);
    const pr = new dns.promises.Resolver({ timeout: 100, tries: 1 });
    await assert.rejects(pr.resolve4("example.invalid"), NetworkAccessError);
    await assert.rejects(dns.promises.resolve6("example.invalid"), NetworkAccessError);
    await sleep(150);
    if (l && live) assert.equal(l.count(), before);
  } finally {
    await l?.close();
  }
});

test("WebSocket and child_process are blocked", () => {
  installNetGuard();
  const WS = (globalThis as unknown as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (WS) assert.throws(() => new WS("ws://example.invalid/"), NetworkAccessError);
  assert.throws(() => childProcess.spawn("curl", ["http://example.invalid/"]), NetworkAccessError);
  assert.throws(() => childProcess.spawnSync("curl", ["http://example.invalid/"]), NetworkAccessError);
  assert.throws(() => childProcess.execSync("curl http://example.invalid/"), NetworkAccessError);
  assert.throws(() => childProcess.execFile("curl", ["http://example.invalid/"], () => {}), NetworkAccessError);
});

test("named ESM imports are guarded too", () => {
  installNetGuard();
  assert.throws(() => namedRequest("http://example.invalid/"), NetworkAccessError);
  uninstallNetGuard();
  assert.equal(namedRequest, http.request);
});

test("uninstall restores dgram, Resolver, WebSocket and child_process", () => {
  const originals = [
    dgram.Socket.prototype.send,
    dns.Resolver.prototype.resolve4,
    dns.resolve4,
    childProcess.spawn,
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket,
  ];
  installNetGuard();
  uninstallNetGuard();
  assert.deepEqual(
    [
      dgram.Socket.prototype.send,
      dns.Resolver.prototype.resolve4,
      dns.resolve4,
      childProcess.spawn,
      (globalThis as unknown as { WebSocket?: unknown }).WebSocket,
    ],
    originals,
  );
});
