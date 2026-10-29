#!/usr/bin/env python3
"""JSON helper for infra/cloudflare/apply.sh (no jq needed). Stdlib only; run with python3 -I.

Request bodies that carry secret VALUES are built from environment variables (never argv).

Usage: cfjson.py <op> [args]
  get PATH                        stdin JSON -> value at dotted PATH ("" if missing)
  ok                              stdin Cloudflare envelope -> exit 0 when success is true
  errors                          stdin envelope -> short error text (codes and messages only)
  scripts                         stdin scripts list -> JSON {name: {modified_on, created_on, id}}
  script NAME FIELD               stdin scripts list -> FIELD of the script NAME ("" if absent)
  snapshot-compare BASE NAME      stdin: current {name: {...}} ; BASE: baseline file. Prints a line
                                  per difference between the two, ignoring script NAME.
  lifecycle-rules                 stdin lifecycle envelope -> JSON list of rules (canonical)
  lifecycle-plan                  stdin: rules list JSON -> lines "add|keep|conflict <id>"
  lifecycle-body                  stdin: rules list JSON -> merged PUT body (existing + missing ours)
  lifecycle-check BASE            stdin: rules list after the PUT; verifies every baseline rule is
                                  intact and ours are present. Prints problems, exit 1 on any.
  baseline                        env CF_NOW CF_SUB CF_SCRIPTS CF_RULES -> baseline document
  body-secret                     env S_NAME S_VALUE -> secret_text body
  secret-names                    stdin secrets list -> names, one per line
"""
import json
import os
import sys

# The three rules this feature owns. Ids are fixed; nothing else is ever created or changed.
OURS = [
    {"id": "inputs-expire-7d", "enabled": True, "conditions": {"prefix": "inputs/"},
     "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 7 * 86400}}},
    {"id": "state-expire-40d", "enabled": True, "conditions": {"prefix": "state/"},
     "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 40 * 86400}}},
    {"id": "abort-multipart-1d", "enabled": True, "conditions": {"prefix": ""},
     "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 86400}}},
]


def dig(obj, path):
    for part in path.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            return None
    return obj


def load_stdin():
    try:
        return json.load(sys.stdin)
    except ValueError:
        return None


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def norm_rule(r):
    """Comparable form of a rule: only the fields we manage."""
    if not isinstance(r, dict):
        return None
    out = {"id": r.get("id"), "enabled": bool(r.get("enabled", True)),
           "prefix": (r.get("conditions") or {}).get("prefix", "")}
    for k in ("deleteObjectsTransition", "abortMultipartUploadsTransition"):
        if k in r:
            out[k] = dig(r, k + ".condition.maxAge")
    return out


def rules_from(env):
    rules = dig(env, "result.rules")
    if rules is None and isinstance(env, dict):
        rules = env.get("rules")
    return rules if isinstance(rules, list) else []


def main():
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    if op == "get":
        v = dig(load_stdin(), sys.argv[2])
        if v is None:
            return
        sys.stdout.write(v if isinstance(v, str) else json.dumps(v, separators=(",", ":")))
    elif op == "ok":
        d = load_stdin()
        sys.exit(0 if isinstance(d, dict) and d.get("success") is True else 1)
    elif op == "errors":
        d = load_stdin()
        errs = d.get("errors") if isinstance(d, dict) else None
        parts = []
        for e in errs or []:
            if isinstance(e, dict):
                parts.append("%s %s" % (e.get("code", ""), str(e.get("message", ""))[:120]))
        print("; ".join(parts))
    elif op == "scripts":
        d = load_stdin()
        out = {}
        for s in (d or {}).get("result") or []:
            if isinstance(s, dict) and isinstance(s.get("id"), str):
                out[s["id"]] = {"modified_on": s.get("modified_on"), "created_on": s.get("created_on"),
                                "id": s["id"]}
        sys.stdout.write(canon(out))
    elif op == "script":
        cur = json.loads(sys.stdin.read() or "{}")
        s = cur.get(sys.argv[2])
        v = s.get(sys.argv[3]) if isinstance(s, dict) else None
        sys.stdout.write("" if v is None else str(v))
    elif op == "snapshot-compare":
        base = json.load(open(sys.argv[2]))["scripts"]
        cur = json.loads(sys.stdin.read() or "{}")
        skip = sys.argv[3]
        for name in sorted(set(base) | set(cur)):
            if name == skip:
                continue
            if name not in cur:
                print("worker %s disappeared" % name)
            elif name not in base:
                print("worker %s appeared" % name)
            elif base[name].get("modified_on") != cur[name].get("modified_on"):
                print("worker %s modified_on changed: %s -> %s" % (name, base[name].get("modified_on"), cur[name].get("modified_on")))
    elif op == "lifecycle-rules":
        sys.stdout.write(canon(rules_from(load_stdin())))
    elif op in ("lifecycle-plan", "lifecycle-body"):
        existing = json.load(sys.stdin)
        by_id = {r.get("id"): r for r in existing if isinstance(r, dict)}
        merged = list(existing)
        for want in OURS:
            have = by_id.get(want["id"])
            if have is None:
                merged.append(want)
                if op == "lifecycle-plan":
                    print("add " + want["id"])
            elif norm_rule(have) == norm_rule(want):
                if op == "lifecycle-plan":
                    print("keep " + want["id"])
            else:
                if op == "lifecycle-plan":
                    print("conflict " + want["id"])
        if op == "lifecycle-body":
            sys.stdout.write(canon({"rules": merged}))
    elif op == "lifecycle-check":
        after = json.load(sys.stdin)
        base = json.load(open(sys.argv[2])).get("lifecycle_rules", [])
        problems = []
        after_by_id = {r.get("id"): r for r in after if isinstance(r, dict)}
        for r in base:
            if canon(after_by_id.get(r.get("id"))) != canon(r):
                problems.append("existing rule %s was changed or removed" % r.get("id"))
        for want in OURS:
            if norm_rule(after_by_id.get(want["id"])) != norm_rule(want):
                problems.append("our rule %s is missing or differs" % want["id"])
        for p in problems:
            print(p)
        sys.exit(1 if problems else 0)
    elif op == "baseline":
        # env CF_SCRIPTS (json), CF_RULES (json), CF_SUB, CF_NOW -> baseline document
        sys.stdout.write(json.dumps({
            "taken_at": os.environ["CF_NOW"], "workers_dev_subdomain": os.environ["CF_SUB"],
            "scripts": json.loads(os.environ["CF_SCRIPTS"]),
            "lifecycle_rules": json.loads(os.environ["CF_RULES"]),
        }, indent=2, sort_keys=True) + "\n")
    elif op == "body-secret":
        sys.stdout.write(canon({"name": os.environ["S_NAME"], "text": os.environ["S_VALUE"], "type": "secret_text"}))
    elif op == "secret-names":
        d = load_stdin()
        for s in (d or {}).get("result") or []:
            if isinstance(s, dict) and s.get("name"):
                print(s["name"])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
