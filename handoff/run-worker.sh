#!/usr/bin/env bash
# Usage: handoff/run-worker.sh <ID> [model] [effort]   e.g. handoff/run-worker.sh C1
# Runs one Codex worker non-interactively with handoff/briefs/_common.md + <ID>.md. Log: handoff/run/<ID>.log
set -uo pipefail
id="$1"; model="${2:-gpt-6-luna}"; effort="${3:-medium}"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/handoff/run"
{ cat "$root/handoff/briefs/_common.md"; echo; echo "YOUR ID: $id"; echo; cat "$root/handoff/briefs/$id.md"; } | codex exec \
  -m "$model" -c "model_reasoning_effort=\"$effort\"" -s danger-full-access --skip-git-repo-check \
  -C "$root" - > "$root/handoff/run/$id.log" 2>&1
code=$?
echo "exit $code" >> "$root/handoff/run/$id.log"
grep -m1 -E "^session id:" "$root/handoff/run/$id.log" | sed "s/^/$id /" >> "$root/handoff/run/SESSIONS.txt"
