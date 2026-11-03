"""The agent's tool calls from LIA_CALL lines on stdin (tools/calls.sh feeds it)."""
import sys, json, collections, statistics as st
flt = sys.argv[1] if len(sys.argv) > 1 else ""
rows = []
for line in sys.stdin:
    if "{" not in line:
        continue
    try:
        d = json.loads(line[line.index("{"):])
    except Exception:
        continue
    if "out" in d and "kind" not in d:   # LIA_CALL_OUT shares the prefix; it is the payload, not a call
        continue
    if flt and flt not in json.dumps(d, ensure_ascii=False):
        continue
    rows.append(d)
if not rows:
    print("no LIA_CALL lines")
    sys.exit()
if flt and len({r.get("chat") for r in rows}) == 1:
    for r in rows:
        print("%-28s %-20s %s %6d ms  %s" % (r.get("tool"), r.get("kind"), "ok " if r.get("ok") else "ERR", r.get("ms", 0), r.get("error") or ""))
    sys.exit()
g = collections.defaultdict(list)
for r in rows:
    g[r.get("tool")].append(r)
print("%-28s %5s %5s %7s %7s %7s" % ("tool", "calls", "fail", "refused", "not_run", "ms med"))
for t, v in sorted(g.items(), key=lambda x: -len(x[1])):
    ran = [x for x in v if x.get("kind") == "ran"]
    refused = sum(1 for x in v if str(x.get("kind", "")).startswith("refused") or x.get("kind") == "not_offered")
    print("%-28s %5d %5d %7d %7d %7d" % (t, len(v), sum(1 for x in ran if not x.get("ok")), refused,
          sum(1 for x in v if x.get("kind") == "not_run"), int(st.median([x.get("ms", 0) for x in ran])) if ran else 0))
print("\n%d calls, %d chats, models: %s" % (len(rows), len({r.get("chat") for r in rows}), dict(collections.Counter(r.get("model") for r in rows))))
