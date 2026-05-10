// PM2 process definition for the FastAPI app.
//
// First-time setup on the VPS:
//   cd ~/InfoRoot-Bots
//   cd frontend && npm ci && npm run build && cd ..       # produce static_react/
//   pm2 start ecosystem.config.js
//   pm2 save                                              # persist across reboots
//   pm2 startup                                           # one-time, prints a sudo cmd to run
//
// Every redeploy after that:
//   ./deploy.sh                  # pulls main, builds, restarts
//   ./deploy.sh -b v5-react      # pulls a different branch
//
// The React build (static_react/) is a build artifact, not a long-running
// process — only the Python app is managed by PM2.

module.exports = {
  apps: [
    {
      name: 'summariesbot',
      script: 'app.py',
      // venv-bound python so pip-installed packages (telethon, fastapi, etc.) are on path.
      interpreter: './venv/bin/python',
      // Resolve cwd at start time — `pm2 start ecosystem.config.js` runs from the
      // repo root and PM2 records the absolute path, so subsequent restarts work
      // regardless of where you invoke `pm2 restart` from.
      cwd: __dirname,
      autorestart: true,
      // Crash-loop guard: if the app exits cleanly more than 10 times in 10s,
      // PM2 stops trying. Hitting this means something is fundamentally broken
      // (e.g. missing static_react/ — app.py raises at startup).
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '1G',
      kill_timeout: 5000,           // ms to wait after SIGTERM before SIGKILL
      env: {
        PYTHONUNBUFFERED: '1',
      },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
      time: true,                   // prefix log lines with timestamps
    },
  ],
};
