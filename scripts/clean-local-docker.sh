#!/usr/bin/env sh
# Removes this project's leftover Docker containers on a dev machine. Safe to run any time:
# it never touches running containers or other projects.
#
#   npm run docker:clean
#
# - Stopped judge sandboxes (label managed-by=judge-service). The judge removes its own at
#   startup and every 5 minutes while running, but a judge that was killed (laptop sleep,
#   Docker Desktop quitting) leaves them behind until its next start.
# - The judge_*_env containers: compose creates them only to build the language images and
#   they exit at once; the images stay.
# - Dangling images left by rebuilds of this project's images.
set -e

sandboxes=$(docker ps -aq --filter label=managed-by=judge-service --filter status=exited --filter status=dead --filter status=created)
placeholders=$(docker ps -a --filter status=exited --format '{{.Names}}' | grep -E '^(judge_[a-z]+_env|codespace_submission_harness)$' || true)

count() { [ -n "$1" ] && echo "$1" | wc -w | tr -d ' ' || echo 0; }
echo "Stopped judge sandboxes:  $(count "$sandboxes")"
echo "Image-build placeholders: $(count "$placeholders")"

[ -n "$sandboxes" ] && docker rm $sandboxes >/dev/null
[ -n "$placeholders" ] && docker rm $placeholders >/dev/null

dangling=$(docker images -q --filter dangling=true --filter label=com.docker.compose.project=leetcode_clone)
echo "Dangling project images:  $(count "$dangling")"
[ -n "$dangling" ] && docker rmi $dangling >/dev/null 2>&1 || true

echo "Done. Containers left: $(docker ps -aq | wc -l | tr -d ' ')"
