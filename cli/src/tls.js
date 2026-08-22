import crypto from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { lanAddresses } from "./net.js";

const require_ = createRequire(import.meta.url);

/**
 * HTTPS is the ADVANCED path and it exists for exactly one case: a phone with
 * no internet, on the LAN, that needs its CAMERA. `getUserMedia` needs a secure
 * context and `http://<lan-ip>` is not one, so the phone has to load the app
 * over TLS from this machine — which means trusting a certificate this machine
 * made.
 *
 * Everything here is USER-LEVEL and self-contained: a local CA plus a leaf it
 * signs, generated in pure JS (node-forge over node's own RSA keygen), written
 * under the user's config dir with 0600/0700. No sudo, no system trust store,
 * no openssl shell-out, no mkcert requirement, no network.
 *
 * `http://localhost` is already a secure context, so the desktop sender path
 * never comes anywhere near this file.
 */

const CA_YEARS = 5;
const LEAF_DAYS = 397; // longer than this and Apple platforms reject the leaf outright

export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(os.homedir(), ".config");
  return join(base, "lightpipe");
}

const paths = () => {
  const dir = configDir();
  return {
    dir,
    caCert: join(dir, "ca.crt"),
    caKey: join(dir, "ca.key"),
    cert: join(dir, "cert.pem"),
    key: join(dir, "key.pem"),
    meta: join(dir, "cert.json"),
  };
};

/** Every name the leaf must cover. Extra names are harmless; missing ones are fatal. */
export function requiredNames(host) {
  const names = ["localhost", "127.0.0.1", "::1", ...lanAddresses().map((i) => i.address)];
  if (host && host !== "0.0.0.0" && host !== "::") names.push(host);
  return [...new Set(names)].sort();
}

const isIp = (n) => /^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(":");

function keypair() {
  const forge = require_("node-forge");
  // node's keygen, not forge's: forge's pure-JS RSA generation takes seconds.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return {
    pub: forge.pki.publicKeyFromPem(publicKey),
    priv: forge.pki.privateKeyFromPem(privateKey),
    privPem: privateKey,
  };
}

const serial = () => crypto.randomBytes(16).toString("hex").replace(/^[89abcdef]/, "0");

function makeCa() {
  const forge = require_("node-forge");
  const kp = keypair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: "commonName", value: `lightpipe local CA (${os.hostname()})` },
    { name: "organizationName", value: "lightpipe" },
    { shortName: "OU", value: "local development CA" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(kp.priv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: kp.privPem, cert, key: kp.priv };
}

function makeLeaf(ca, names) {
  const forge = require_("node-forge");
  const kp = keypair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 3600 * 1000);
  cert.setSubject([{ name: "commonName", value: names.find((n) => !isIp(n)) ?? names[0] }, { name: "organizationName", value: "lightpipe" }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: names.map((n) => (isIp(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: kp.privPem };
}

const writeSecret = (p, data) => {
  writeFileSync(p, data, { mode: 0o600 });
  chmodSync(p, 0o600);
};

/**
 * Returns { key, cert, caPem, caPath, certPath, keyPath, names, reused, regenerated, reason }.
 * `cert` is leaf + CA, so a client that already trusts the CA gets the full chain.
 */
export function ensureCert(names, { force = false } = {}) {
  const forge = require_("node-forge");
  const p = paths();
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(p.dir, 0o700);
  } catch {
    /* a shared XDG dir we do not own: leave it alone */
  }
  const want = [...new Set(names)].sort();

  // --- the CA: long-lived, and the thing the phone actually trusts ---------
  let ca;
  let caFresh = false;
  if (!force && existsSync(p.caCert) && existsSync(p.caKey)) {
    try {
      const cert = forge.pki.certificateFromPem(readFileSync(p.caCert, "utf8"));
      if (cert.validity.notAfter.getTime() > Date.now() + 30 * 24 * 3600 * 1000) {
        ca = { certPem: readFileSync(p.caCert, "utf8"), keyPem: readFileSync(p.caKey, "utf8"), cert, key: forge.pki.privateKeyFromPem(readFileSync(p.caKey, "utf8")) };
      }
    } catch {
      /* unreadable: make a new one */
    }
  }
  if (!ca) {
    ca = makeCa();
    writeFileSync(p.caCert, ca.certPem, { mode: 0o644 });
    writeSecret(p.caKey, ca.keyPem);
    caFresh = true;
  }

  // --- the leaf: short-lived, regenerated whenever the SANs stop covering --
  let reason = null;
  if (force) reason = "--regenerate-cert";
  else if (!existsSync(p.cert) || !existsSync(p.key) || !existsSync(p.meta)) reason = "no certificate stored yet";
  else if (caFresh) reason = "the local CA was replaced";
  else {
    try {
      const meta = JSON.parse(readFileSync(p.meta, "utf8"));
      const missing = want.filter((n) => !meta.names.includes(n));
      if (missing.length) reason = `this machine's addresses changed (${missing.join(", ")} not in the certificate)`;
      else if (new Date(meta.notAfter).getTime() < Date.now() + 24 * 3600 * 1000) reason = "the certificate expired";
    } catch {
      reason = "the stored certificate metadata is unreadable";
    }
  }

  if (!reason) {
    return {
      key: readFileSync(p.key, "utf8"),
      cert: readFileSync(p.cert, "utf8"),
      caPem: ca.certPem,
      caPath: p.caCert,
      caKeyPath: p.caKey,
      certPath: p.cert,
      keyPath: p.key,
      names: JSON.parse(readFileSync(p.meta, "utf8")).names,
      reused: true,
      regenerated: false,
      caFresh: false,
      reason: null,
    };
  }

  const leaf = makeLeaf(ca, want);
  const chain = leaf.certPem.trimEnd() + "\n" + ca.certPem.trimEnd() + "\n";
  writeFileSync(p.cert, chain, { mode: 0o644 });
  writeSecret(p.key, leaf.keyPem);
  writeFileSync(p.meta, JSON.stringify({ names: want, notAfter: new Date(Date.now() + LEAF_DAYS * 24 * 3600 * 1000).toISOString(), createdBy: `lightpipe on ${os.hostname()}` }, null, 2), { mode: 0o600 });

  return {
    key: leaf.keyPem,
    cert: chain,
    caPem: ca.certPem,
    caPath: p.caCert,
    caKeyPath: p.caKey,
    certPath: p.cert,
    keyPath: p.key,
    names: want,
    reused: false,
    regenerated: true,
    caFresh,
    reason,
  };
}
