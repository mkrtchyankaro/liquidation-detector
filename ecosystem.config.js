module.exports = {
  apps: [
    {
      name: "liquidation-detector",
      script: "dist/main.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      watch: false,
      // Sep 8 2026 (Karo) -- defensive safety net for a 1GB-RAM server
      // (confirmed real deployment target). Caps Node's own heap so a
      // future leak (or a temporary spike) triggers a clean, fast
      // "heap out of memory" PM2 restart at ~512MB, rather than
      // growing toward 2GB+ and risking the whole box hanging/OOM-
      // killing something else. The root cause of the one confirmed
      // OOM crash (unbounded per-tick Mongo queries in
      // ReconciliationManager) is fixed separately -- this is
      // defense-in-depth, not a substitute for that fix.
      node_args: "--max-old-space-size=512",
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
