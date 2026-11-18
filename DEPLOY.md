# Putting OrganicWar.io live

The game is one Node process (rooms live in its memory) plus a SQLite file.
Production needs: **one** always-on server with WebSockets, a **persistent
disk** for the database, HTTPS, and ideally your own domain. Two ways to get
that are ready in this repo:

| | **A. Render (recommended)** | **B. Your own VPS** |
|---|---|---|
| What you manage | Nothing: deploys from GitHub, HTTPS, restarts | A Linux server (updates, firewall) |
| Cost | ~US$7.25/month (Starter + 1 GB disk) | ~€4–5/month (e.g. Hetzner CX22) |
| Capacity | ~4 rooms at once (~80 players) on Starter; ~8 on Standard (US$25) | ~16 rooms (~320 players) on 2 vCPU / 4 GB |
| Deploy | Automatic on every merge to `main` | `git pull && docker compose up -d --build` |

Prices are from the providers' public pricing; check render.com/pricing or
hetzner.com/cloud before buying. Capacity adapts to the plan automatically
(`GET /healthz` → `capacity.maxRooms`), so upgrading is just changing the plan.

## What you need to buy

1. **Hosting — required.** Render *Starter* web service + 1 GB persistent disk
   (≈ US$7.25/month), or a VPS for option B. Render's *free* plan won't work:
   it has no persistent disk (the database would be wiped on every deploy) and
   it sleeps after 15 minutes idle, which disconnects everyone.
2. **A domain — recommended.** Without one the game is at
   `https://organicwar-io.onrender.com`, which works fine to start. A `.io`
   (organicwar.io, if available) is about US$40–60/year; `.com` / `.gg` are
   cheaper or similar. Cloudflare Registrar, Porkbun and Namecheap all work.
3. **Nothing else is required.** Email (password reset), Google/Discord login
   and Google ads are optional and free to set up — see below. Google ads need
   your own domain (point 2).

## A. Render — step by step

1. **Create the account** at render.com with *Sign in with GitHub*, and add a
   payment method (Billing).
2. **Create the service from the Blueprint:** Dashboard → **New → Blueprint**
   → choose the `jpballestrino/OrganicWar` repository, branch `main`. Render
   reads [`render.yaml`](render.yaml) and proposes one web service
   (`organicwar-io`, Docker, Starter, 1 GB disk at `/data`). It generates
   `JWT_SECRET` itself — never change it later or every player is logged out.
3. **Fill in the values it asks for:** set `APP_URL` to
   `https://organicwar-io.onrender.com` (change it when you add a domain).
   Leave the email / Google / Discord values empty for now. Click **Apply**.
4. **Wait for the first build** (~6–10 minutes: it compiles the Rust
   simulation). The deploy is live when the log shows
   `Server listening on port 3000` and the health check turns green.
5. **Check it:** open the URL, play a Quick Battle, register an account.
   `https://<your-url>/healthz` should show `"status":"ok"` and your capacity.

### Add your domain
Service → **Settings → Custom Domains → Add**: add `yourdomain.com` and
`www.yourdomain.com`. Render shows the DNS records to create at your
registrar (a CNAME for `www`, and an A/ALIAS record for the bare domain). The
HTTPS certificate is issued automatically once DNS resolves (minutes to an
hour). Then change `APP_URL` to `https://yourdomain.com` (Environment tab).

## B. Your own VPS (Docker + Caddy)

1. Create an Ubuntu 24.04 server with **2 vCPU / 4 GB** (e.g. Hetzner CX22),
   and point your domain's **A record** at its IP.
2. On the server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/jpballestrino/OrganicWar.git && cd OrganicWar
   cp .env.example .env
   # edit .env: DOMAIN=yourdomain.com, APP_URL=https://yourdomain.com,
   #            JWT_SECRET=$(openssl rand -hex 64)
   docker compose up -d --build
   ```
3. Open ports 80 and 443 only (e.g. `ufw allow 80,443/tcp && ufw allow OpenSSH && ufw enable`).
   Caddy gets the HTTPS certificate on first request. Update later with
   `git pull && docker compose up -d --build`.

## Optional: email and social login

- **Email** (password reset, address verification): set `EMAIL_USER` /
  `EMAIL_PASS` — for Gmail, enable 2-step verification and create an *App
  Password* at myaccount.google.com/apppasswords. Other providers: also set
  `SMTP_HOST`, `SMTP_PORT` (587, or 465 for SSL) and `SMTP_FROM`. Set
  `APP_URL` correctly: the links in the emails point there.
  ⚠️ Once email is configured, **new accounts must verify their address**
  before they can log in. **Without email, "Forgot password?" tells players it
  isn't available** — so set it up before launch if you can. After setting it,
  register a test account and check the email arrives (and isn't in spam).
- **Google login:** console.cloud.google.com → APIs & Services → Credentials
  → OAuth client ID (Web). Authorised redirect URI:
  `https://yourdomain.com/api/auth/google/callback`. Set
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- **Discord login:** discord.com/developers/applications → New application →
  OAuth2 → redirect `https://yourdomain.com/api/auth/discord/callback`. Set
  `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.

## Optional: Google ads (AdSense)

Ads are **off until you set `ADSENSE_CLIENT`** — with it unset no Google code
loads at all. Once on, ads appear only around matches, never during one:

| Placement | Setting | Notes |
|---|---|---|
| Banner beside the home menu | `ADSENSE_SLOT_HOME` | wide screens only (≥ 1150 px), never covers the menu |
| Banner beside the end-of-match recap | `ADSENSE_SLOT_RECAP` | same |
| Full-screen ad between matches (Play Again / Main Menu) | `ADSENSE_GAME_BREAKS=1` | Google's Ad Placement API ("H5 Games Ads"); at most one every 2 minutes, sound muted during it |

If a player's ad blocker blocks Google's script, the game simply carries on.

**What you need:**
1. **Your own domain** (AdSense doesn't accept `*.onrender.com` addresses) —
   so this needs the domain from "What you need to buy".
2. **An AdSense account** (free): adsense.google.com → add your site → paste
   nothing (the game already includes Google's code) → Google reviews the site,
   which can take from a few days to a few weeks. `/ads.txt` and the privacy
   policy at `/privacy` (linked in the home footer) are served automatically.
3. Once approved: **Ads → By ad unit → Display ads** — create two responsive
   units ("home", "recap") and copy each one's `data-ad-slot` number.
4. In Render → Environment set `ADSENSE_CLIENT` (your `ca-pub-…` publisher id,
   from Account → Settings), `ADSENSE_SLOT_HOME`, `ADSENSE_SLOT_RECAP`, and
   `CONTACT_EMAIL` (shown on the privacy page). The service restarts; the log
   line `Google ads ON (...)` confirms it.
5. **Between-match ads** are a separate Google programme for web games: apply
   for "H5 Games Ads" (Ad Placement API) from your AdSense account, and set
   `ADSENSE_GAME_BREAKS=1` after Google enables it. While testing,
   `ADSENSE_TEST=1` makes Google serve test ads (no earnings).
6. **Europe / UK consent:** in AdSense → Privacy & messaging, publish the
   European regulations (GDPR) message. Google then shows the consent banner
   itself — required for visitors from the EEA, UK and Switzerland.

**Review the privacy policy** (`server/pages/privacy.html`) before going live —
it was written from what the code stores, but it is not legal advice.

Check it from a terminal with `node scripts/smoke-ads.mjs` (see the file for
the server settings it expects; Google's script is replaced by a stand-in).

## Running it

- **Players with bad connections:** a player who drops keeps their land for
  30 s (`RECONNECT_GRACE_SECONDS`), then a bot plays for them until they come
  back (they can return any time during the match). Others see 📡 / 🤖 next to
  their name. Players who quit from the menu are replaced by a bot at once.
- **Login protection:** login, registration and the password-reset /
  verification emails are rate-limited per IP (and per email address), so
  password guessing and email spamming are cut off with a "try again in N
  minutes" message.

- **Health & capacity:** `GET /healthz` — rooms running, `maxRooms`, CPU load,
  per-room tick cost. Upgrade the plan when rooms often reach `maxRooms`
  (new matches are refused then; players are sent back to the menu with a
  "servers are full" message).
- **Backups:** the server snapshots the database every hour into
  `/data/backups` (48 kept), on the same disk. For off-site copies, download
  one now and then (Render: service → Shell → `ls /data/backups`).
- **Deploys restart the server:** matches in progress end (players get a
  "server is restarting" notice). Merge to `main` at quiet times.
- **One instance only:** rooms live in one process's memory, so the service
  must not be scaled to several instances; scale by upgrading the plan.

## What was verified before launch

The production image (`Dockerfile`) was built and run with a 1-CPU / 1 GB
limit and a data volume: migrations ran, capacity detected the container's
limits (1 core, 1 GB → 8 rooms), the full browser test suite passed against
it, an account and its XP survived replacing the container, the per-IP limit
used the real client IP behind a proxy, and the Compose + Caddy stack served
HTTPS, the WebSocket handshake and a full match over `wss://`.
