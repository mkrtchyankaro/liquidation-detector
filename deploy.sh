#!/usr/bin/env bash
# Safe deploy for liquidation-detector.
#
# Order matters: nothing that the RUNNING bot depends on (dist/, the pm2
# process) is touched until the new code has been pulled, installed,
# built into a separate folder, tested, and its config validated. A
# failed step aborts the deploy and leaves the currently running bot
# exactly as it was.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="liquidation-detector"   # must match ecosystem.config.js "name"
BUILD_DIR="dist.next"

echo "==> [1/7] Pulling latest code (fast-forward only)"
git pull --ff-only origin main

echo "==> [2/7] Installing exact dependencies from package-lock.json"
npm ci

echo "==> [3/7] Checking local config files (never overwritten)"
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "!! .env was missing -- copied .env.example. Fill in real values, then run ./deploy.sh again."
  else
    echo "!! .env is missing. Create it (MONGO_URI, ...) and run ./deploy.sh again."
  fi
  exit 1
fi
if [ ! -f users.config.json ]; then
  cp users.config.example.json users.config.json
  echo "!! users.config.json was missing -- copied the example. Fill in real secrets, then run ./deploy.sh again."
  exit 1
fi

echo "==> [4/7] Building into ${BUILD_DIR}/ (running bot keeps using dist/)"
rm -rf "${BUILD_DIR}"
npx tsc -p . --outDir "${BUILD_DIR}"

echo "==> [5/7] Running tests"
npm test

echo "==> [6/7] Validating .env + users.config.json with the NEW code"
node -e '
  require("dotenv/config");
  const env = require("./'"${BUILD_DIR}"'/config/env").loadEnv();
  const c = require("./'"${BUILD_DIR}"'/config/users-config").loadAppConfig(env.usersConfigPath, env.symbols);
  console.log("symbols collected: " + env.symbols.join(","));
  console.log("realOrdersEnabled=" + c.realOrdersEnabled + "  v10.enabled=" + c.v10.enabled + "  v11.enabled=" + c.v11.enabled + (c.v11.enabled ? "  v11.tpR=" + c.v11.tpR + "  v11.coins=" + c.v11.symbols.length : ""));
  if (c.legacyBlocks.length) console.log("NOTE: ignored old blocks in users.config.json: " + c.legacyBlocks.join(",") + " (V9 / ZZ were removed)");
  const mode = (s, u) => { const m = s.enabled ? (s.userModes.get(u.userId) || "OFF") : "OFF"; return m === "OFF" ? "OFF" : m === "REAL" && c.realOrdersEnabled && !!u.binance ? "REAL(after readiness check)" : "PAPER"; };
  for (const u of c.users.filter((x) => x.enabled)) {
    console.log("  " + u.userId.padEnd(10) + "V10=" + mode(c.v10, u).padEnd(28) + "V11=" + mode(c.v11, u).padEnd(28) + "riskUsd=" + u.riskUsd + "  telegram=" + (u.telegram ? "yes" : "no"));
  }
'

echo "==> [7/7] Swapping build and restarting ${APP_NAME}"
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
mv "${BUILD_DIR}" dist
pm2 startOrRestart ecosystem.config.js --update-env
pm2 save

echo "==> Waiting 20s for startup..."
sleep 20
if ! pm2 describe "${APP_NAME}" | grep -q "status.*online"; then
  echo "!! ${APP_NAME} is NOT online. Rolling back to the previous build."
  if [ -d dist.prev ]; then
    rm -rf dist && mv dist.prev dist
    pm2 restart "${APP_NAME}" --update-env
  fi
  pm2 logs "${APP_NAME}" --lines 80 --nostream
  exit 1
fi

echo "==> Startup user modes:"
pm2 logs "${APP_NAME}" --lines 400 --nostream | grep -E "V10_USER_MODE|V11_USER_MODE|V10_READY|V10_WALL_READY|V11_READY|V11_MONITOR_ONLY|V9_REAL_TRADES_LEFT_OPEN|LEGACY_CONFIG_IGNORED|REAL_NOT_READY|REAL_DOWNGRADED|COLLECTOR_STARTED" | tail -16 || true
echo "==> Done. Previous build kept in dist.prev/ for quick rollback."
