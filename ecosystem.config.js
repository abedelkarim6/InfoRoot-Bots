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
      // Run the venv's python with uvicorn as a module. This is the actual
      // HTTP server entry point — `python app.py` alone would just import the
      // module and exit without serving anything. Binding to 127.0.0.1 keeps
      // the FastAPI process private; nginx (or another reverse proxy) is
      // expected to listen on 80/443 and forward traffic to this port.
      script: './venv/bin/python',
      args: '-m uvicorn app:app --host 127.0.0.1 --port 8000',
      interpreter: 'none',
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
