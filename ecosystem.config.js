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
      // Sep 19 2026 (Karo), operator-reported PRODUCTION MEMORY
      // INCIDENT -- CORRECTED: the server is NOT 1GB RAM as the
      // previous comment (and the 512MB heap cap it justified)
      // assumed -- confirmed via `free -h` on the real deployment
      // target: 3.8GB total, ~2.6GB available. The stale 512MB cap
      // was almost certainly causing V8's OWN "JavaScript heap out of
      // memory" fatal crashes (a hard process abort, distinct from
      // pm2's own max_memory_restart below, and one that may not
      // surface cleanly in pm2's normal error log) well before
      // legitimate memory needs were met -- especially after Sep 19's
      // Episode Research capture feature added meaningful new
      // in-memory buffering. Raised to a cap that leaves comfortable
      // headroom on the real 3.8GB box. If this server's actual specs
      // ever change again, update BOTH this and max_memory_restart
      // below together, and confirm with `free -h` first rather than
      // trusting a hostname or an old comment.
      node_args: "--max-old-space-size=2048",
      max_memory_restart: "2400M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
