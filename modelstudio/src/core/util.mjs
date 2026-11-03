// Shared primitives: errors, ids, binary encoding, small math helpers.
import crypto from 'node:crypto';

export class ModelStudioError extends Error {
  constructor(code, message, { details = undefined, status = 400, hint = undefined } = {}) {
    super(message);
    this.name = 'ModelStudioError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = hint;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const fail = (code, message, options) => {
  throw new ModelStudioError(code, message, options);
};

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export const nowIso = () => new Date().toISOString();

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function asNumber(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : fallback;
}

/** Encode a typed array (or Buffer) as base64. */
export function encodeArray(typedArray) {
  if (!typedArray || typedArray.length === 0) return '';
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).toString('base64');
}

const CTORS = {
  f32: Float32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  i32: Int32Array,
};

/** Decode base64 into a typed array; returns empty array of `type` when input is empty. */
export function decodeArray(b64, type = 'f32') {
  const Ctor = CTORS[type] ?? Float32Array;
  if (!b64) return new Ctor(0);
  const buf = Buffer.from(b64, 'base64');
  const count = Math.floor(buf.byteLength / Ctor.BYTES_PER_ELEMENT);
  // Always copy into memory owned by the typed array. `Buffer.from(base64)`
  // hands back views into Node's shared 8 KB pool, so aliasing it would let
  // later allocations silently overwrite a project's geometry.
  const out = new Ctor(count);
  new Uint8Array(out.buffer).set(buf.subarray(0, count * Ctor.BYTES_PER_ELEMENT));
  return out;
}

export function b64FromBytes(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export function bytesFromB64(b64) {
  return Buffer.from(b64 ?? '', 'base64');
}

export function vec3(value, fallback = [0, 0, 0], label = 'vector') {
  if (value == null) return fallback == null ? null : [...fallback];
  // Accept ["x","y","z"] from JSON and "x,y,z" / "x y z" from the CLI.
  const parts = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(parts) || parts.length !== 3 || parts.some((v) => v === '' || !Number.isFinite(Number(v)))) {
    fail('invalid_argument', `${label} must be a vector of 3 numbers (got ${JSON.stringify(value)})`, { details: { received: value } });
  }
  return parts.map(Number);
}

export function deepClone(value) {
  return structuredClone(value);
}

/** Deterministic PRNG (mulberry32) so procedural geometry is reproducible from a seed. */
export function makeRandom(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  return parseInt(crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8), 16);
}

export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
