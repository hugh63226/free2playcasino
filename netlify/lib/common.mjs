// Shared helpers for the API: storage, password hashing, signed session cookies, rate limits.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const COOKIE = "casino_session";
export const SESSION_DAYS = 30;
export const MAX_BODY = 400_000; // bytes - a save file is only a few KB

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

export const db = () => ({
  users: getStore({ name: "users", consistency: "strong" }),
  saves: getStore({ name: "saves", consistency: "strong" }),
  limits: getStore({ name: "limits", consistency: "strong" }),
  board: getStore({ name: "board", consistency: "strong" }),
  boardcache: getStore({ name: "boardcache", consistency: "strong" }),
});

/* ---------- secrets ---------- */
function authSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new HttpError(500, "Server is not configured: set a long AUTH_SECRET environment variable in Netlify (see README).");
  }
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ---------- password / recovery-code hashing (scrypt) ---------- */
const scrypt = (secret, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(secret, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(secret, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifySecret(secret, stored) {
  const [saltHex, keyHex] = String(stored).split(":");
  const key = await scrypt(secret, Buffer.from(saltHex, "hex"));
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

let dummyHash;
/** Burn the same CPU time when the user doesn't exist, so response time doesn't reveal valid usernames. */
export async function fakeVerify(secret) {
  dummyHash ||= await hashSecret("not-a-real-password");
  await verifySecret(secret, dummyHash);
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function newRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  let raw = "";
  for (let i = 0; i < 16; i++) raw += ALPHABET[bytes[i] % 32];
  return raw.match(/.{4}/g).join("-");
}
export const normRecovery = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ---------- signed session cookie ---------- */
export function signSession(user) {
  const payload = { u: user.key, v: user.tv, exp: Date.now() + SESSION_DAYS * 864e5 };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac("sha256", authSecret()).update(body).digest());
  return `${body}.${sig}`;
}

function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const want = crypto.createHmac("sha256", authSecret()).update(body).digest();
  let got;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

export const sessionCookie = (token) =>
  `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

function cookieValue(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Returns the logged-in user record, or throws 401. */
export async function requireUser(req, stores) {
  const p = readSession(cookieValue(req, COOKIE));
  if (!p) throw new HttpError(401, "Not logged in.");
  const user = await stores.users.get(p.u, { type: "json" });
  if (!user || user.tv !== p.v) throw new HttpError(401, "Session expired. Please log in again.");
  return user;
}

/* ---------- rate limiting ---------- */
export async function limitLeft(stores, key) {
  const r = await stores.limits.get(key, { type: "json" });
  return r && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 1000) : 0;
}
export async function limitFail(stores, key, max, windowMs, lockMs) {
  const now = Date.now();
  let r = await stores.limits.get(key, { type: "json" });
  if (!r || now - r.first > windowMs) r = { count: 0, first: now, until: 0 };
  r.count += 1;
  if (r.count >= max) r.until = now + lockMs;
  await stores.limits.setJSON(key, r);
}
export const limitClear = (stores, key) => stores.limits.delete(key);

/** Count an event; throws 429 once `max` events happen inside `windowMs`. */
export async function hit(stores, key, max, windowMs, message) {
  const now = Date.now();
  let r = await stores.limits.get(key, { type: "json" });
  if (!r || now - r.first > windowMs) r = { count: 0, first: now, until: 0 };
  if (r.count >= max) throw new HttpError(429, message);
  r.count += 1;
  await stores.limits.setJSON(key, r);
}
