#!/usr/bin/env bash
# Every tool call of the agent, summarised from LIA_CALL lines (one per call, from the runner worker).
# usage: tools/calls.sh [hours=24] [filter]     filter = a chat id, a member id, a model...
#   tools/calls.sh 24                 per tool: calls, failures, refusals, median ms
#   tools/calls.sh 6 <chatId>         one chat, call by call, in order
# Needs CF_API_TOKEN and CF_ACCOUNT. The Observability query returns at most 200 events per run.
set -euo pipefail
d="$(dirname "$0")"
"$d/logs.sh" "LIA_CALL" "${1:-24}" proaimain | python3 "$d/calls.py" "${2:-}"
