#!/usr/bin/env bash
# Poll GitHub for new commits and rebuild the agent if there are any.
# Designed to be run from cron or a systemd timer; safe to run frequently
# because git fetch is cheap and we exit immediately when up to date.

set -euo pipefail

# Resolve the repo root (this script lives in <repo>/scripts).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

LOG_PREFIX="$(date -Is) [soundtide-update]"

# Fetch quietly. If the remote isn't reachable, just bail.
if ! git fetch --quiet 2>/dev/null; then
  echo "$LOG_PREFIX cannot reach origin; skipping"
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse '@{u}' 2>/dev/null || echo '')"

if [ -z "$REMOTE" ]; then
  echo "$LOG_PREFIX no upstream tracking branch; configure with 'git branch -u origin/main'"
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  # Up to date; nothing to do.
  exit 0
fi

echo "$LOG_PREFIX updating $LOCAL -> $REMOTE"

# Fast-forward only — refuse to merge or rebase if there are local changes.
if ! git pull --quiet --ff-only; then
  echo "$LOG_PREFIX local changes block ff-only pull; aborting"
  exit 1
fi

# Rebuild and restart. --build forces image rebuild for code changes; -d keeps
# us detached so cron returns quickly.
docker-compose up -d --build

echo "$LOG_PREFIX done"
