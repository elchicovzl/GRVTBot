# GRVT Grid — Self-host install guide

> **Audience**: people who want to run their own GRVT Grid bot on their own
> server, with their own GRVT account, with their own keys. **No SaaS.** Your
> trades, your keys, your liability.

## Prerequisites

| Requirement | Why |
|---|---|
| **A GRVT account registered through the project's referral link** | Required to get repo access and to keep the project sustainable. Ask the maintainer for the link. |
| **A Linux server** (or Mac, or Windows with WSL2) with Docker Engine ≥ 24 and Docker Compose v2 | The whole stack is containerized. No host Node install needed. |
| **2 GB RAM** minimum, 1 vCPU is enough | The bot is ~110 MB, dashboard is static, notifier is tiny. |
| **A GRVT API key + secret + sub-account id** | Generate from grvt.io → Account → API Keys |
| **(Optional) A domain name pointed at your server** | Required only if you want HTTPS via Caddy. Without a domain, you can still access the dashboard locally or over a VPN. |
| **(Optional) A Telegram bot token + chat id** | For notifications. Skip with empty values if you don't want them. |

## Quick install (5 minutes)

```bash
# 1. Clone the private repo (you need access — contact maintainer)
git clone https://github.com/<owner>/grvt-grid.git
cd grvt-grid

# 2. Run the interactive installer
./scripts/install.sh
```

The installer will:
1. Check Docker is installed and running
2. Generate a fresh `DASHBOARD_API_KEY`
3. Prompt you for GRVT credentials (and Telegram if you want notifications)
4. Build the Docker images
5. Start the stack
6. Wait for the bot's health check to pass
7. Print the dashboard URL and API key

When it's done, open the printed URL, enter the API key when prompted by
the dashboard, and your bot will appear in the Overview.

## Manual install (if you want to skip the installer)

```bash
git clone https://github.com/<owner>/grvt-grid.git
cd grvt-grid

# 1. Create .env from the template and fill in your credentials
cp .env.example .env
chmod 600 .env
# Edit .env with your GRVT API keys, etc.

# 2. Build and start
docker compose build
docker compose up -d

# 3. Watch the logs until you see "✅ Active bots loaded"
docker compose logs -f bot

# 4. Open the dashboard
open http://localhost:3848/dashboard/
```

## Deployment profiles

`docker-compose.yml` defines three optional services controlled by Compose
profiles:

| Profile | Includes | When to use |
|---|---|---|
| _(default)_ | bot only | Local dev, behind a VPN, or you'll proxy from another reverse proxy |
| `with-notifier` | bot + notifier | You want Telegram alerts |
| `with-tls` | bot + caddy | You have a public domain and want HTTPS |
| `full` | bot + notifier + caddy | Production self-host with everything |

To start with a profile:

```bash
docker compose --profile full up -d
```

## TLS setup (with-tls profile)

1. Point an A record from your domain to your server's public IP.
2. Edit `Caddyfile`: replace `your-domain.example.com` with your domain.
3. Open ports 80 and 443 on your server's firewall.
4. `docker compose --profile with-tls up -d`
5. Caddy will automatically obtain a Let's Encrypt cert in ~30 seconds.
6. Open `https://your-domain/dashboard/`.

## Stopping safely

The bot installs a SIGTERM handler that **does not cancel any open GRVT
orders** when it stops. So:

```bash
# Safe — preserves the 93 (or however many) limit orders on GRVT
docker compose stop bot

# Also safe — same thing then removes the container
docker compose down

# Also safe (full restart, keeps orders intact)
docker compose restart bot
```

What you should NOT do:

```bash
# DON'T — sends SIGKILL, no graceful shutdown. Orders are still on GRVT
# (the bot doesn't actively cancel them on signal anyway), but you lose
# any in-flight DB writes and the bot might miss the latest fills on next
# boot.
docker kill grvt-grid-bot
```

## Backups

The bot's SQLite database lives at `./data/grid_bot.db` on the host. WAL
files (`*.db-wal`, `*.db-shm`) live next to it. Back the whole `data/`
directory up nightly to somewhere off-host:

```bash
# Example: cron job that pushes a daily snapshot to S3 / Backblaze / etc.
0 3 * * * cd /opt/grvt-grid && tar czf - data | rclone rcat \
    remote:grvt-grid-backups/$(date +\%F).tar.gz
```

## Updating

```bash
cd /opt/grvt-grid
git pull
docker compose build
docker compose up -d   # rolling restart, preserves data dir
```

The bot's SQLite migrations run automatically on boot.

## Troubleshooting

### "Bot did not become healthy"

Check the logs:

```bash
docker compose logs -f bot
```

Common causes:
- **GRVT_API_KEY / SECRET wrong**: you'll see authentication errors in the
  logs. Re-check the values in `.env`.
- **GRVT account not funded**: the bot won't start trading on a zero balance,
  but health check should still pass. If not, check your sub-account id.
- **Port 3848 already in use**: change `BOT_PORT` in `.env`.

### Dashboard says "GRVT session expired"

Your API key was rotated on grvt.io. Update `GRVT_API_KEY` and
`GRVT_API_SECRET` in `.env`, then `docker compose restart bot`.

### Notifier sends a flood of historical fills on first start

Shouldn't happen — the notifier fast-forwards its cursor on bootstrap. If
it does, stop the notifier, delete its state volume:

```bash
docker compose stop notifier
docker volume rm grvt-grid_notifier-state
docker compose start notifier
```

## Security checklist

Before you point a domain at this and walk away:

- [ ] `.env` permissions are `600` (the installer sets this; verify with `ls -la .env`)
- [ ] `DASHBOARD_API_KEY` is at least 32 chars (the installer generates 64)
- [ ] You're using the `with-tls` profile (or fronted with another HTTPS proxy)
- [ ] Your server's firewall blocks port 3848 from the public internet (Caddy
      proxies via the docker network — only 80/443 should be public)
- [ ] You've set up nightly backups of `./data/`
- [ ] You're not running the legacy basic auth dashboard (just remove
      `DASHBOARD_USER` / `DASHBOARD_PASS` from `.env` if you don't need it)
- [ ] Your GRVT API key is scoped to the trading sub-account only — not the
      master account with withdrawal permissions

## Where things live

```
/opt/grvt-grid/
├── data/                         ← SQLite db (bind mount)
│   ├── grid_bot.db
│   ├── grid_bot.db-wal
│   └── grid_bot.db-shm
├── logs/
│   ├── bot/                      ← bot stdout
│   └── notifier/                 ← notifier stdout
├── .env                          ← your secrets
└── docker-compose.yml
```
