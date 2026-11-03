// Zero-dependency self-signed TLS certificate generator for WebXR on LAN.
//
// Meta Quest Browser (and all Chromium WebXR browsers) require a Secure Context
// (`https://` or `localhost`) before exposing `navigator.xr` (`immersive-vr`)
// and microphone speech APIs over home Wi-Fi. This module builds a valid
// ECDSA-P256 X.509v3 certificate with SubjectAltName entries for localhost and
// every local IPv4 interface using only built-in `node:crypto`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function listLanAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = new Set(['127.0.0.1']);
  for (const entries of Object.values(interfaces)) {
    for (const info of entries ?? []) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        ips.add(info.address);
      }
    }
  }
  return Array.from(ips);
}

// --- Minimal ASN.1 DER encoder helpers -----------------------------------

function derLen(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf]);
}

const derSeq = (...items) => derTag(0x30, Buffer.concat(items));
const derSet = (...items) => derTag(0x31, Buffer.concat(items));
const derOctet = (buf) => derTag(0x04, buf);
const derBitString = (buf) => derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const derBool = (val) => derTag(0x01, Buffer.from([val ? 0xff : 0x00]));
const derUtf8 = (str) => derTag(0x0c, Buffer.from(str, 'utf8'));
const derUtcTime = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  const s = `${String(date.getUTCFullYear()).slice(-2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derTag(0x17, Buffer.from(s, 'ascii'));
};

function derInt(bytesInput) {
  let buf = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.from(bytesInput);
  while (buf.length > 1 && buf[0] === 0 && (buf[1] & 0x80) === 0) buf = buf.subarray(1);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return derTag(0x02, buf);
}

function derOid(oidString) {
  const parts = oidString.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i];
    if (v === 0) {
      out.push(0);
      continue;
    }
    const stack = [];
    while (v > 0) {
      stack.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    }
    for (let j = 0; j < stack.length - 1; j += 1) stack[j] |= 0x80;
    out.push(...stack);
  }
  return derTag(0x06, Buffer.from(out));
}

function toPem(label, derBuffer) {
  const b64 = derBuffer.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export function generateSelfSignedCert({ hosts = ['localhost'], ips = listLanAddresses(), days = 825 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // ecdsa-with-SHA256 = 1.2.840.10045.4.3.2
  const sigAlg = derSeq(derOid('1.2.840.10045.4.3.2'));
  const cn = derSet(derSeq(derOid('2.5.4.3'), derUtf8('ModelStudio Local WebXR')));
  const org = derSet(derSeq(derOid('2.5.4.10'), derUtf8('ModelStudio')));
  const dn = derSeq(org, cn);

  const now = new Date(Date.now() - 60_000);
  const exp = new Date(now.getTime() + days * 86_400_000);
  const validity = derSeq(derUtcTime(now), derUtcTime(exp));

  // SubjectAltName (2.5.29.17): dNSName [2] IA5String, iPAddress [7] OCTET STRING
  const sanEntries = [];
  const hostname = os.hostname();
  const dnsSet = new Set(['localhost', ...hosts]);
  if (hostname) {
    dnsSet.add(hostname);
    if (!hostname.endsWith('.local')) dnsSet.add(`${hostname}.local`);
  }
  for (const dns of dnsSet) {
    sanEntries.push(derTag(0x82, Buffer.from(dns, 'ascii')));
  }
  for (const ip of ips) {
    const octets = ip.split('.').map(Number);
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      sanEntries.push(derTag(0x87, Buffer.from(octets)));
    }
  }

  const extBasicConstraints = derSeq(derOid('2.5.29.19'), derBool(true), derOctet(derSeq(derBool(false))));
  const extKeyUsage = derSeq(derOid('2.5.29.15'), derBool(true), derOctet(derTag(0x03, Buffer.from([0x05, 0xa0]))));
  const extExtKeyUsage = derSeq(derOid('2.5.29.37'), derOctet(derSeq(derOid('1.3.6.1.5.5.7.3.1'))));
  const extSan = derSeq(derOid('2.5.29.17'), derOctet(derSeq(...sanEntries)));
  const extensions = derTag(0xa3, derSeq(extBasicConstraints, extKeyUsage, extExtKeyUsage, extSan));

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;

  const tbs = derSeq(
    derTag(0xa0, derInt(Buffer.from([0x02]))), // v3
    derInt(serial),
    sigAlg,
    dn,
    validity,
    dn,
    spkiDer,
    extensions,
  );

  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certDer = derSeq(tbs, sigAlg, derBitString(signature));
  const certPem = toPem('CERTIFICATE', certDer);

  return { key: keyPem, cert: certPem, ips, hosts: Array.from(dnsSet) };
}

export async function ensureWorkspaceTls(workspaceRoot) {
  const dir = path.join(workspaceRoot, '.tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const metaFile = path.join(dir, 'meta.json');
  const currentIps = listLanAddresses();

  try {
    if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(metaFile)) {
      const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      const covered = currentIps.every((ip) => meta.ips?.includes(ip));
      if (covered) {
        return {
          key: await fsp.readFile(keyFile, 'utf8'),
          cert: await fsp.readFile(certFile, 'utf8'),
          ips: meta.ips,
          certFile,
        };
      }
    }
  } catch {
    // regenerate below
  }

  await fsp.mkdir(dir, { recursive: true });
  const generated = generateSelfSignedCert({ ips: currentIps });
  await fsp.writeFile(keyFile, generated.key, { mode: 0o600 });
  await fsp.writeFile(certFile, generated.cert);
  await fsp.writeFile(metaFile, JSON.stringify({ ips: generated.ips, hosts: generated.hosts, createdAt: new Date().toISOString() }, null, 2));
  return { ...generated, certFile };
}
