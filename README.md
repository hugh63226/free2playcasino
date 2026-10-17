# Casino Simulator — with accounts & cloud saves (Netlify)

Your game, unchanged, plus:

- **Create account / log in / log out**
- **Cloud saves** — progress follows the account to any device (auto-saved a moment after every action)
- **Change password**, **delete account**, **download a backup**
- **Forgot password** via a one-time **recovery code** (shown when you register — no email service needed)
- **Global leaderboard** — most money ever, most money gambled, richest right now (with your own rank)
- Protection against brute-force guessing, cross-site requests, and tampered sessions

```
casino-site/
├── public/index.html            ← your game + login screens
├── netlify/functions/api.mjs    ← the backend (register, login, saves, ...)
├── netlify/lib/common.mjs       ← password hashing, sessions, rate limiting
├── netlify/lib/board.mjs        ← leaderboard rules + ranking
├── netlify.toml                 ← Netlify settings + security headers
└── package.json                 ← one dependency: @netlify/blobs (the database)
```

---

## Deploy (recommended: GitHub → Netlify)

> ⚠️ Don't use Netlify's "drag and drop" deploy. It doesn't install the backend's dependency, so login won't work.

**1. Put the project on GitHub**

```bash
cd casino-site
git init
git add .
git commit -m "Casino Simulator"
# create an empty repo on github.com, then:
git remote add origin https://github.com/YOUR-NAME/casino-simulator.git
git branch -M main
git push -u origin main
```

**2. Create the Netlify site**

Netlify dashboard → **Add new site → Import an existing project** → pick the repo.
The settings are read from `netlify.toml` (publish folder `public`, no build command). Click **Deploy**.

**3. Set the secret (required)**

Generate a long random string:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Netlify → **Site configuration → Environment variables → Add a variable**
- Key: `AUTH_SECRET`
- Value: the string you generated (keep it private; never commit it)

Then **Deploys → Trigger deploy → Deploy site** so the backend picks it up.

**4. Open your site** and create an account. Done.

Until `AUTH_SECRET` is set, the login screen will show: *"Server is not configured: set a long AUTH_SECRET…"*.

### Alternative: Netlify CLI

```bash
npm install -g netlify-cli
cd casino-site
npm install
netlify login
netlify init                      # create & link a new site
netlify env:set AUTH_SECRET "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
netlify deploy --prod
```

### Try it locally first (optional)

```bash
npm install
echo "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" > .env
netlify dev        # opens http://localhost:8888
```

---

## How it works

| Piece | Details |
|---|---|
| Passwords | Hashed with scrypt + a random salt per user. Plain passwords are never stored. |
| Sessions | Signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie, valid 30 days. Changing your password logs out every other device. |
| Brute force | 5 wrong passwords → 15-minute lockout (per username + network). Reset attempts and sign-ups are limited too. |
| Recovery code | 16 characters, stored hashed, **single-use** (a fresh one is issued after each reset). |
| Database | Netlify Blobs (built in, free tier, nothing to sign up for): `users`, `saves`, `limits`. |
| Two devices | Each save carries a revision number. If another device saved first, you're asked: load the cloud save or keep yours. |
| Offline / crash | A local copy is kept; if it's newer than the cloud save next time you log in, you're offered it back. |
| Old progress | When a brand-new account is created on a device that has old (pre-login) progress, you're offered to import it. |

API (all under `/api/`): `register`, `login`, `logout`, `me`, `save` (GET/PUT), `password`, `reset`, `delete`, `leaderboard`.

## Leaderboard

Open it from the lobby (**🏆 Leaderboard**). Three boards, top 50 each, plus your own rank even if you're outside the top 50:

| Board | Uses |
|---|---|
| 💰 Most money ever | your best balance ever (all-time record; never goes down) |
| 🎲 Most gambled | total money staked on every game, ever (never goes down) |
| 👛 Richest now | your current balance |

Your own numbers are always up to date; the top lists refresh about every 30 seconds.

### Keeping it fair

The game runs in the browser, so the server can't *prove* anyone played honestly. Instead, every stat update is checked against what is actually possible in the game:

1. **Sanity** — real, finite, non-negative numbers.
2. **Speed** — games can't be played faster than about one per second, and the total staked can't exceed games played × the largest bet the game allows.
3. **Wealth cap** — your all-time peak can't exceed £100 + 5× everything you've ever wagered + £20,000.

An update that fails is **not shown on the board** and the account is marked *on hold* (the player sees a notice). The save itself is never blocked, and the account returns to the board automatically once its play history catches up. Accounts created before the leaderboard existed get a one-time pass for their existing progress.

**What this stops:** editing numbers in the browser's developer tools, or uploading a doctored save.
**What it can't stop:** a determined cheater who forges a believable play history slowly, or runs a bot. Closing that completely means moving the game logic onto the server. If someone cheats anyway, delete their entry in Netlify → **Blobs → `board`** (or delete the account's key in `users`).

Optional setting: `LEADERBOARD_CACHE_SECONDS` (default `30`) controls how often the top lists are rebuilt.

## Things worth knowing

- **Saves can be edited by their owner.** The game runs in the browser, so a determined player can change their own save with developer tools. That's fine for a personal game. If you ever add a public leaderboard, the server would need to validate results.
- **Lost both password and recovery code?** There's no email reset, so the account can't be recovered. As the site owner you can delete a user in Netlify → **Blobs** and let them re-register.
- **Changing `AUTH_SECRET`** logs everybody out (their saves are kept).
- Themes are remembered per browser, not per account.
