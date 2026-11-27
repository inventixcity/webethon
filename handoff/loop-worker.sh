#!/usr/bin/env bash
# Usage: handoff/loop-worker.sh <ID> [max rounds]: resumes a Codex worker until handoff/log/<ID>.md ends with STATUS: COMPLETE.
set -uo pipefail
id="$1"; max="${2:-6}"
root="$(cd "$(dirname "$0")/.." && pwd)"
for i in $(seq 1 "$max"); do
  if tail -3 "$root/handoff/log/$id.md" 2>/dev/null | grep -q "STATUS: COMPLETE"; then echo "$id complete after $((i-1)) resumes"; exit 0; fi
  bash "$root/handoff/resume-worker.sh" "$id"
done
tail -3 "$root/handoff/log/$id.md"
