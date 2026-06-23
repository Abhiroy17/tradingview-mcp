# Fly.io Deploy Runbook — MunafaSutra Dashboard

5-command deploy. Run from the repo root.

## Prerequisites

```bash
# Install Fly CLI (once)
curl -L https://fly.io/install.sh | sh   # macOS/Linux
# Windows: winget install flyio.flyctl

fly auth login
```

## First-time setup

```bash
# 1. Create the app (use the name already in fly.toml)
fly apps create munafasutra-dashboard

# 2. Create persistent volume (keeps .data/ across redeploys — 1 GB is plenty)
fly volumes create tradingview_data --size 1 --region sin

# 3. Set secrets (never stored in repo or fly.toml)
fly secrets set \
  TELEGRAM_BOT_TOKEN=your_token_from_botfather \
  TELEGRAM_CHAT_ID=your_chat_id

# 4. Build React UI locally, then deploy
cd ui && npm install && npm run build && cd ..
fly deploy

# 5. Check it's live
fly status
fly logs --tail
curl https://munafasutra-dashboard.fly.dev/health
```

## Redeploy after code changes

```bash
cd ui && npm run build && cd ..
fly deploy
```

## Useful commands

```bash
fly logs --tail           # stream live logs
fly status                # VM status, health checks
fly ssh console           # SSH into the running container
fly volumes list          # confirm volume is mounted
fly secrets list          # confirm secrets (values are masked)
```

## Notes

- Region `sin` (Singapore) — lowest latency to NSE/BSE.
- Volume `tradingview_data` mounts at `/app/.data` — watchlist, settings, alert history, and Upstox token all persist here across redeploys.
- The dashboard runs in `HEADLESS=true` mode — no TradingView Desktop is needed. Chart/Pine/Replay API endpoints return errors; scanner, Telegram, and strategy engine work normally.
- Free Fly.io tier: 1 shared-cpu-1x VM (256 MB RAM) + 3 GB volumes is within the free allowance.
- Dashboard URL: `https://munafasutra-dashboard.fly.dev`
- No dashboard auth by default — add HTTP Basic Auth via `FLY_HTTP_AUTH=user:pass` if you want to restrict access.
