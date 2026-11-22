#!/usr/bin/env bash
set -euo pipefail

# GitHub disables public repository schedules after 60 days without activity.
last_commit=$(git log -1 --format=%ct)
if (( $(date +%s) - last_commit < 30 * 24 * 60 * 60 )); then
  exit 0
fi

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git commit --allow-empty -m 'chore: keep RSS sync schedule active'
git push origin "HEAD:${GITHUB_REF_NAME}"
