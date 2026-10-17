// One serverless function that handles every /api/* route.
import {
  HttpError, MAX_BODY, json, db, sha256, hashSecret, verifySecret, fakeVerify,
  newRecoveryCode, normRecovery, signSession, sessionCookie, clearCookie, requireUser,
  limitLeft, limitFail, limitClear, hit,
} from "../lib/common.mjs";
import { updateBoard, getSummary, rankOf } from "../lib/board.mjs";

export const config = { path: "/api/*" };

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const GENERIC_LOGIN_ERROR = "Incorrect username or password.";

const MIN = 60_000;
const HOUR = 60 * MIN;

function checkPassword(pw, username) {
  if (typeof pw !== "string" || pw.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
  if (pw.length > 128) throw new HttpError(400, "Password is too long (max 128 characters).");
  if (username && pw.toLowerCase() === username.toLowerCase()) throw new HttpError(400, "Password can't be the same as your username.");
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request too large.");
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "Invalid JSON."); }
}

/** Block cross-site requests: state-changing calls must come from our own origin. */
function checkOrigin(req) {
  if (req.method === "GET") return;
  const origin = req.headers.get("origin");
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === new URL(req.url).host; } catch { /* bad origin */ }
    if (!ok) throw new HttpError(403, "Cross-site request blocked.");
  }
}

const clientIp = (ctx) => ctx?.ip || "unknown";
const publicUser = (u) => ({ username: u.username });

/* ======================= route handlers ======================= */
const routes = {
  /* ---- create account ---- */
  async "POST register"(req, ctx, s) {
    const { username, password } = await readBody(req);
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      throw new HttpError(400, "Username must be 3-20 characters: letters, numbers, _ or -.");
    }
    checkPassword(password, username);
    await hit(s, `reg:${sha256(clientIp(ctx))}`, 5, HOUR, "Too many accounts created from this network. Try again later.");

    const key = username.toLowerCase();
    if (await s.users.get(key, { type: "json" })) throw new HttpError(409, "That username is taken.");

    const recoveryCode = newRecoveryCode();
    const user = {
      key, username,
      pass: await hashSecret(password),
      rec: await hashSecret(normRecovery(recoveryCode)),
      tv: 1, // token version: bumping it logs out every session
      lbv: 1, // created after leaderboards existed: stats are verified from zero
      created: Date.now(),
    };
    await s.users.setJSON(key, user);
    return json({ ...publicUser(user), recoveryCode }, 201, { "Set-Cookie": sessionCookie(signSession(user)) });
  },

  /* ---- log in ---- */
  async "POST login"(req, ctx, s) {
    const { username, password } = await readBody(req);
    if (typeof username !== "string" || typeof password !== "string" || password.length > 128) {
      throw new HttpError(400, GENERIC_LOGIN_ERROR);
    }
    const key = username.toLowerCase();
    const lim = `login:${sha256(key + "|" + clientIp(ctx))}`;
    const wait = await limitLeft(s, lim);
    if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);

    const user = USERNAME_RE.test(username) ? await s.users.get(key, { type: "json" }) : null;
    const ok = user ? await verifySecret(password, user.pass) : (await fakeVerify(password), false);
    if (!ok) {
      await limitFail(s, lim, 5, 15 * MIN, 15 * MIN);
      throw new HttpError(401, GENERIC_LOGIN_ERROR);
    }
    await limitClear(s, lim);
    return json(publicUser(user), 200, { "Set-Cookie": sessionCookie(signSession(user)) });
  },

  async "POST logout"() {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  },

  /* ---- who am I ---- */
  async "GET me"(req, ctx, s) {
    return json(publicUser(await requireUser(req, s)));
  },

  /* ---- cloud save ---- */
  async "GET save"(req, ctx, s) {
    const user = await requireUser(req, s);
    const rec = await s.saves.get(user.key, { type: "json" });
    return json(rec ? { save: rec.save, rev: rec.rev, updated: rec.updated } : { save: null, rev: 0 });
  },

  async "PUT save"(req, ctx, s) {
    const user = await requireUser(req, s);
    const body = await readBody(req);
    const { save, rev } = body;
    if (!save || typeof save !== "object" || Array.isArray(save)) throw new HttpError(400, "Invalid save data.");
    if (typeof save.money !== "number" || !Number.isFinite(save.money)) throw new HttpError(400, "Invalid save data.");
    if (!Number.isInteger(rev) || rev < 0) throw new HttpError(400, "Invalid revision.");

    const cur = await s.saves.getWithMetadata(user.key, { type: "json" });
    const curRev = cur?.data?.rev ?? 0;
    if (curRev !== rev) {
      // Another device/tab saved since this client last synced - let the client choose.
      return json({ error: "Conflict", save: cur?.data?.save ?? null, rev: curRev }, 409);
    }
    const next = { rev: rev + 1, save, updated: Date.now() };
    const opts = cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const res = await s.saves.setJSON(user.key, next, opts);
    if (res && res.modified === false) {
      const latest = await s.saves.get(user.key, { type: "json" });
      return json({ error: "Conflict", save: latest?.save ?? null, rev: latest?.rev ?? 0 }, 409);
    }
    try { await updateBoard(s, user, save); } catch (e) { console.error("leaderboard update failed:", e); } // never block saving
    return json({ rev: next.rev });
  },

  /* ---- global leaderboard ---- */
  async "GET leaderboard"(req, ctx, s) {
    const user = await requireUser(req, s);
    const saved = await s.saves.get(user.key, { type: "json" });
    let mine = null;
    try { mine = await updateBoard(s, user, saved?.save, { force: true }); } catch (e) { console.error("leaderboard update failed:", e); }
    const sum = await getSummary(s);
    const you = {
      peak: { value: mine?.peak ?? 0, rank: rankOf(sum.all.peak, mine?.peak ?? 0) },
      wagered: { value: mine?.wagered ?? 0, rank: rankOf(sum.all.wagered, mine?.wagered ?? 0) },
      money: { value: mine?.money ?? 0, rank: rankOf(sum.all.money, mine?.money ?? 0) },
    };
    return json({ boards: sum.top, you, name: user.username, hold: !!mine?.hold, players: sum.players, updated: sum.t });
  },

  /* ---- change password (needs the current one) ---- */
  async "POST password"(req, ctx, s) {
    const user = await requireUser(req, s);
    const { current, next } = await readBody(req);
    const lim = `pw:${user.key}`;
    const wait = await limitLeft(s, lim);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    if (typeof current !== "string" || !(await verifySecret(current, user.pass))) {
      await limitFail(s, lim, 5, 15 * MIN, 15 * MIN);
      throw new HttpError(401, "Current password is incorrect.");
    }
    checkPassword(next, user.username);
    await limitClear(s, lim);
    user.pass = await hashSecret(next);
    user.tv += 1; // logs out all other devices
    await s.users.setJSON(user.key, user);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(signSession(user)) });
  },

  /* ---- forgot password: username + recovery code ---- */
  async "POST reset"(req, ctx, s) {
    const { username, recovery, password } = await readBody(req);
    if (typeof username !== "string" || typeof recovery !== "string") throw new HttpError(400, "Enter your username and recovery code.");
    const key = username.toLowerCase();
    const lim = `reset:${sha256(key + "|" + clientIp(ctx))}`;
    const wait = await limitLeft(s, lim);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);

    const user = USERNAME_RE.test(username) ? await s.users.get(key, { type: "json" }) : null;
    const code = normRecovery(recovery);
    const ok = user && code.length === 16 ? await verifySecret(code, user.rec) : (await fakeVerify(code), false);
    if (!ok) {
      await limitFail(s, lim, 5, 15 * MIN, 30 * MIN);
      throw new HttpError(401, "Username or recovery code is incorrect.");
    }
    checkPassword(password, user.username);
    await limitClear(s, lim);

    const recoveryCode = newRecoveryCode(); // codes are single-use: issue a fresh one
    user.pass = await hashSecret(password);
    user.rec = await hashSecret(normRecovery(recoveryCode));
    user.tv += 1;
    await s.users.setJSON(user.key, user);
    return json({ ...publicUser(user), recoveryCode }, 200, { "Set-Cookie": sessionCookie(signSession(user)) });
  },

  /* ---- delete account + save permanently ---- */
  async "POST delete"(req, ctx, s) {
    const user = await requireUser(req, s);
    const { password } = await readBody(req);
    const lim = `del:${user.key}`;
    const wait = await limitLeft(s, lim);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    if (typeof password !== "string" || !(await verifySecret(password, user.pass))) {
      await limitFail(s, lim, 5, 15 * MIN, 15 * MIN);
      throw new HttpError(401, "Password is incorrect.");
    }
    await s.saves.delete(user.key);
    await s.board.delete(user.key);
    await s.users.delete(user.key);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  },
};

/* ======================= entry point ======================= */
export default async (req, context) => {
  try {
    checkOrigin(req);
    const route = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/+$/, "");
    const handler = routes[`${req.method} ${route}`];
    if (!handler) throw new HttpError(404, "Not found.");
    return await handler(req, context, db());
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error("API error:", e);
    return json({ error: "Something went wrong on the server. Please try again." }, 500);
  }
};
