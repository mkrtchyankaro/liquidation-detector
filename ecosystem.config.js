// PM2 process definition. Memory caps sized for a 1 GB server: the V9 bot
// normally uses ~150-250 MB; pm2 restarts it if it ever exceeds 700 MB.
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
      max_memory_restart: "700M",
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=512",
      },
    },
  ],
};
