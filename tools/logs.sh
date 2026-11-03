#!/usr/bin/env bash
# Worker logs through the Workers Observability API.
# usage: tools/logs.sh <substring> [hours=6] [script=proaimain]
#   tools/logs.sh LIA_DOOR 3          every door answer (door, ok, error, guard)
#   tools/logs.sh <chatId> 24         one chat's server lines
#   tools/logs.sh LIA_CHAT_DONE 12    per-turn model, effort, ms, tools, reasoning tokens
# Needs CF_API_TOKEN and CF_ACCOUNT. Prints the messages oldest first.
set -euo pipefail
q="$1"; h="${2:-6}"; s="${3:-proaimain}"
now=$(date +%s000); from=$((now - h*3600*1000))
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"queryId\":\"cli\",\"timeframe\":{\"from\":$from,\"to\":$now},\"view\":\"events\",\"limit\":200,\"parameters\":{\"filters\":[{\"key\":\"\$workers.scriptName\",\"operation\":\"eq\",\"type\":\"string\",\"value\":\"$s\"},{\"key\":\"\$metadata.message\",\"operation\":\"includes\",\"type\":\"string\",\"value\":\"$q\"}]}}" \
| python3 -c '
import json,sys
d=json.load(sys.stdin); ev=((d.get("result") or {}).get("events") or {}).get("events") or []
for e in sorted(ev, key=lambda e: e.get("timestamp") or 0):
    src=e.get("source"); m=(src.get("message") if isinstance(src,dict) else None) or (e.get("$metadata") or {}).get("message") or ""
    print(m[:600])'
