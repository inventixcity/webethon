#!/usr/bin/env bash
# Usage: handoff/resume-worker.sh <ID> [prompt-file]  (resumes the Codex session recorded in handoff/run/SESSIONS.txt)
set -uo pipefail
id="$1"; prompt_file="${2:-handoff/continue.md}"
root="$(cd "$(dirname "$0")/.." && pwd)"
sid=$(grep "^$id session id:" "$root/handoff/run/SESSIONS.txt" | tail -1 | awk '{print $4}')
[ -n "$sid" ] || { echo "no session for $id"; exit 1; }
cd "$root"
codex exec -m "${CODEX_MODEL:-gpt-6-luna}" -c "model_reasoning_effort=\"${CODEX_EFFORT:-medium}\"" -s danger-full-access --skip-git-repo-check -C "$root" resume "$sid" "$(cat "$root/$prompt_file")" >> "$root/handoff/run/$id.log" 2>&1
echo "exit $? (resume)" >> "$root/handoff/run/$id.log"
