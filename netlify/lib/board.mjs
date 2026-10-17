// Leaderboard: plausibility checks on saved stats + ranking.
//
// The game runs in the browser, so the server can't *prove* a player's numbers are honest.
// Instead every stat update is checked against what is physically possible in the game:
//   1. sanity     - real, finite, non-negative numbers
//   2. speed      - games can't be played faster than ~1 per second since the last accepted update,
//                   and the total staked can't exceed (games played x the biggest possible stake)
//   3. wealth cap - your all-time peak balance can't exceed 100 + 5x everything you've ever wagered + 20,000
// An update that fails is simply not shown on the board (the save itself is always kept) and the account is
// marked "on hold" until its play history catches up. This stops casual cheating (editing numbers in dev tools).

const MAX_NUM = 1e12;
const THROTTLE_MS = 8_000;      // board record is rewritten at most this often per player
const SUMMARY_TTL_MS = Number(process.env.LEADERBOARD_CACHE_SECONDS ?? 30) * 1000;  // ranking is rebuilt at most this often
export const TOP_N = 50;

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** Pull the leaderboard stats out of a game save, or null if they're not valid numbers. */
export function readStats(save) {
  if (!save || typeof save !== "object") return null;
  const money = save.money;
  const wagered = save.total_wagered ?? 0;
  const games = save.games_played ?? 0;
  const life = save.lifetime_earned ?? 0;
  const hi = save.highest_money ?? 0;
  const rp = save.records && typeof save.records === "object" ? (save.records.peak ?? 0) : 0;
  for (const v of [money, wagered, games, life, hi, rp]) if (!isNum(v) || v < 0 || v > MAX_NUM) return null;
  if (!Number.isInteger(games)) return null;
  return { money, wagered, games, life, peak: Math.max(hi, rp, money) };
}

/** Decide whether a new set of stats is believable, given the last accepted record. */
export function evaluate(user, rec, stats, nowMs) {
  let base = null;
  if (rec) base = { games: rec.bg, wagered: rec.bw, t: rec.t };
  else if (user.lbv) base = { games: 0, wagered: 0, t: user.created };   // account created with leaderboards: must start from scratch
  // (older accounts with no record are grandfathered: their first update only has to pass the wealth cap)

  if (stats.peak > 100 + 5 * stats.wagered + 20_000) return "wealth";
  if (base) {
    if (stats.games < base.games) base = { ...base, games: 0, wagered: 0 };       // player reset their game
    const elapsed = Math.max(1, (nowMs - base.t) / 1000);
    const dG = stats.games - base.games;
    const dW = stats.wagered - base.wagered;
    if (dG > 1.25 * elapsed + 8) return "speed";
    if (dW < 0) return "stake";
    if (dW > dG * 10.5 * (175 + 0.15 * stats.life)) return "stake";
  }
  return null;
}

/**
 * Re-check a player's stats and update their board record. Never throws into the caller's flow.
 * Returns the (possibly unchanged) record, or null if the player has none.
 */
export async function updateBoard(s, user, save, { force = false } = {}) {
  const now = Date.now();
  const rec = await s.board.get(user.key, { type: "json" });
  const stats = readStats(save);
  if (!stats) return rec;
  if (!force && rec && !rec.hold && now - rec.t < THROTTLE_MS) return rec;

  const problem = evaluate(user, rec, stats, now);
  if (problem) {
    if (rec && rec.hold === problem) return rec;                         // already on hold, nothing new to write
    const held = rec
      ? { ...rec, hold: problem }
      : { username: user.username, peak: 0, wagered: 0, money: 0, bg: 0, bw: 0, t: user.lbv ? user.created : now, hold: problem };
    await s.board.setJSON(user.key, held);
    return held;
  }
  const next = {
    username: user.username,
    peak: Math.max(rec?.peak ?? 0, stats.peak),          // all-time bests only ever go up
    wagered: Math.max(rec?.wagered ?? 0, stats.wagered),
    money: stats.money,                                  // current money can go up and down
    bg: stats.games, bw: stats.wagered, t: now, hold: false,
  };
  await s.board.setJSON(user.key, next);
  return next;
}

/** Cached top-N lists + full sorted value lists (used to work out anyone's rank). */
export async function getSummary(s) {
  const now = Date.now();
  const cached = await s.boardcache.get("summary", { type: "json" });
  if (cached && now - cached.t < SUMMARY_TTL_MS) return cached;

  const { blobs } = await s.board.list();
  const recs = [];
  for (let i = 0; i < blobs.length; i += 20) {
    const part = await Promise.all(blobs.slice(i, i + 20).map((b) => s.board.get(b.key, { type: "json" })));
    for (const r of part) if (r) recs.push(r);
  }
  const make = (field) => {
    const sorted = recs.filter((r) => r[field] > 0).sort((a, b) => b[field] - a[field] || a.username.localeCompare(b.username));
    return {
      top: sorted.slice(0, TOP_N).map((r) => ({ name: r.username, value: r[field] })),
      all: sorted.map((r) => r[field]),
    };
  };
  const p = make("peak"), w = make("wagered"), m = make("money");
  const summary = {
    t: now, players: recs.length,
    top: { peak: p.top, wagered: w.top, money: m.top },
    all: { peak: p.all, wagered: w.all, money: m.all },
  };
  await s.boardcache.setJSON("summary", summary);
  return summary;
}

export const rankOf = (sortedDesc, value) => (value > 0 ? 1 + sortedDesc.filter((v) => v > value).length : null);
