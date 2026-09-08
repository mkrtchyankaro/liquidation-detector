#!/usr/bin/env bash
set -euo pipefail

BOT_NAME="$(basename "$(pwd)")"

echo "==> Deploying ${BOT_NAME}"

git pull origin main
npm install

# Sep 8 2026 fix (Karo's own deploy.sh had this unconditional -- it would
# silently overwrite real .env/users.config.json with blank placeholder
# templates on EVERY deploy after the first one, destroying MONGO_URI,
# Binance API keys, and Telegram tokens. Now only copies the template the
# FIRST time (file doesn't exist yet); every subsequent deploy leaves
# your real, already-configured files completely untouched.
if [ ! -f .env ]; then
  echo "==> .env not found -- copying .env.example (fill in real values before starting)"
  cp .env.example .env
fi
if [ ! -f users.config.json ]; then
  echo "==> users.config.json not found -- copying users.config.example.json (fill in real secrets before starting)"
  cp users.config.example.json users.config.json
fi

rm -rf dist/
npm run build
npm test

# Sep 8 2026 fix -- ecosystem.config.js (not a raw `pm2 start dist/main.js`)
# so autorestart/max_restarts/restart_delay/cwd from that file are
# actually applied. `pm2 start` is a safe no-op if the process is already
# running under this name (use --update-env to pick up .env changes).
pm2 start ecosystem.config.js
pm2 restart "${BOT_NAME}" --update-env
pm2 save

echo "==> Done. Check: pm2 logs ${BOT_NAME} --lines 50"