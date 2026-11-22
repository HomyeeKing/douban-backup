#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf -- "$test_dir"' EXIT

git init --bare --quiet "$test_dir/remote.git"
git init --quiet -b main "$test_dir/work"
cd "$test_dir/work"
git config user.name Test
git config user.email test@example.com
git remote add origin "$test_dir/remote.git"
git commit --quiet --allow-empty -m initial
git push --quiet origin main

initial_head=$(git rev-parse HEAD)
GITHUB_REF_NAME=main bash "$script_dir/keepalive.sh"
[[ $(git rev-parse HEAD) == "$initial_head" ]]

old_date=$(date -d '31 days ago' --iso-8601=seconds)
GIT_AUTHOR_DATE="$old_date" GIT_COMMITTER_DATE="$old_date" git commit --quiet --allow-empty -m old
old_head=$(git rev-parse HEAD)
GITHUB_REF_NAME=main bash "$script_dir/keepalive.sh"
new_head=$(git rev-parse HEAD)
[[ "$new_head" != "$old_head" ]]
[[ $(git rev-parse HEAD^) == "$old_head" ]]
[[ $(git --git-dir="$test_dir/remote.git" rev-parse main) == "$new_head" ]]

GITHUB_REF_NAME=main bash "$script_dir/keepalive.sh"
[[ $(git rev-parse HEAD) == "$new_head" ]]
echo 'Keepalive checks passed: fresh commits skip, inactive repositories push once.'
