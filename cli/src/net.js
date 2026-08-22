import os from "node:os";

const PRIVATE = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/** Every non-internal IPv4 this machine has, RFC1918 addresses first. */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      out.push({ name, address: a.address, private: PRIVATE.some((r) => r.test(a.address)) });
    }
  }
  // Private first; within that, keep interface order (en0 before utun/bridge).
  return out.sort((a, b) => Number(b.private) - Number(a.private));
}

export function primaryLanAddress() {
  return lanAddresses()[0]?.address ?? null;
}

/** true when binding this host only makes the server reachable from this machine. */
export function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** The host you would put in a URL for a server bound to `host`. */
export function urlHost(host, lan) {
  if (host === "0.0.0.0" || host === "::" || host === "") return lan ?? "localhost";
  if (host.includes(":")) return `[${host}]`;
  return host;
}
