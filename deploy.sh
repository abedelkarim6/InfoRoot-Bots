#!/usr/bin/env bash
# Deploy script — pulls latest code, rebuilds the React bundle, restarts PM2.
#
# Usage:
#   ./deploy.sh                  # pulls origin/main (default)
#   ./deploy.sh -b feature-x     # pulls origin/feature-x
#   ./deploy.sh -b v5-react      # pulls the current dev branch
#
# Safe to re-run. If anything fails, PM2 is NOT restarted (set -e aborts first).

set -euo pipefail

BRANCH="main"
PM2_NAME="summariesbot"

while getopts ":b:n:h" opt; do
  case "$opt" in
    b) BRANCH="$OPTARG" ;;
    n) PM2_NAME="$OPTARG" ;;
    h)
      echo "Usage: $0 [-b branch] [-n pm2_name]"
      echo "  -b   git branch to deploy (default: main)"
      echo "  -n   PM2 process name to restart (default: summariesbot)"
      exit 0
      ;;
    \?) echo "Unknown option: -$OPTARG" >&2; exit 1 ;;
    :)  echo "Option -$OPTARG requires an argument." >&2; exit 1 ;;
  esac
done

# Always run from the repo root, no matter where the script was invoked from.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "==> Repo:    $REPO_DIR"
echo "==> Branch:  $BRANCH"
echo "==> PM2:     $PM2_NAME"
echo

# ── 1. Pull latest code ─────────────────────────────────────────────────────
echo "==> Fetching origin..."
git fetch origin "$BRANCH"

echo "==> Checking out $BRANCH..."
git checkout "$BRANCH"

echo "==> Fast-forwarding to origin/$BRANCH..."
git pull --ff-only origin "$BRANCH"
echo

# ── 2. Install + build the React bundle ─────────────────────────────────────
echo "==> Installing frontend dependencies (npm ci)..."
cd frontend
# npm ci is strict; fall back to npm install if the lockfile drifted.
if ! npm ci --no-audit --no-fund 2>/dev/null; then
  echo "    npm ci failed (likely lockfile drift) — falling back to npm install"
  npm install --no-audit --no-fund
fi

echo "==> Building React bundle..."
npm run build
cd "$REPO_DIR"
echo

# ── 3. Restart PM2 ──────────────────────────────────────────────────────────
echo "==> Restarting PM2 process '$PM2_NAME'..."
pm2 restart "$PM2_NAME" --update-env
echo

echo "==> Deploy complete. Recent log lines:"
pm2 logs "$PM2_NAME" --lines 15 --nostream || true
