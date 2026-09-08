#!/usr/bin/env bash
BOT_NAME="$(basename "$(pwd)")"

pm2 delete "${BOT_NAME}"
rm -rf dist/
git pull origin main
npm run build
pm2 start dist/app.js --name "${BOT_NAME}"
pm2 save
pm2 restart "${BOT_NAME}" --update-env
pm2 save