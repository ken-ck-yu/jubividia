#!/usr/bin/env python3
"""JSON helper for infra/runpod/apply.sh (no jq needed). Stdlib only; run with python3 -I.

Request bodies that carry secret VALUES are built from environment variables
(never argv), so a value cannot show up in `ps` or in a shell trace.

Usage: rpjson.py <op> [args]
  get PATH                      stdin JSON -> value at dotted PATH ("" if missing)
  ids KEY=VAL ...               stdin list (or {"x": [..]}) -> ids of items matching ALL pairs
  body-volume | body-volume-size
  body-secret | body-secret-value        env S_NAME S_VALUE
  body-endpoint                 env EP_* (see build_endpoint) -> desired endpoint body
  diff-endpoint                 stdin actual endpoint, env EP_DESIRED -> differing group names
  group-body GROUP              env EP_DESIRED -> {GROUP: desired[GROUP]}
  body-pod                      env POD_* -> create-pod body
"""
import json
import os
import sys

GPU_POOL = "ADA_48_PRO"
# Pool ADA_48_PRO also holds these; excluding them pins the endpoint to
# NVIDIA RTX 6000 Ada Generation (the only remaining type).
EXCLUDED_TYPES = [
    "NVIDIA L40",
    "NVIDIA L40S",
    "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb",
]
MIN_CUDA = "12.8"
SECRET_REF = "{{ RUNPOD_SECRET_%s }}"
GROUPS = ("image", "env", "gpu", "dataCenterIds", "mounts", "workers", "scaling",
          "flashboot", "timeout", "disk")

POD_SCRIPT = r"""set -eu
export DEBIAN_FRONTEND=noninteractive
need=""
for c in git curl python3 flock; do command -v "$c" >/dev/null 2>&1 || need=1; done
if [ -n "$need" ]; then
  apt-get update -qq && apt-get install -y -qq git curl ca-certificates python3 util-linux
fi
git clone https://github.com/ken-ck-yu/jubividia /tmp/j
cd /tmp/j
git checkout --detach "$GIT_REF"
echo "pinned to $(git rev-parse HEAD)"
scripts/download-models.sh
scripts/download-models.sh --verify
echo "MODELS DONE - TERMINATE THIS POD NOW (apply.sh pod-down)"
sleep infinity
"""


def env(name, default=None, required=True):
    v = os.environ.get(name)
    if v is None or v == "":
        if default is not None:
            return default
        if required:
            sys.exit(f"rpjson: missing env {name}")
        return None
    return v


def listify(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list):
                return v
    return []


def dig(obj, path):
    for part in path.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            return None
    return obj


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), sort_keys=True))


def build_endpoint():
    timeout_ms = int(env("EP_TIMEOUT_MS"))
    e = {
        "R2_ACCOUNT_ID": env("EP_R2_ACCOUNT_ID"),
        "R2_BUCKET": env("EP_R2_BUCKET"),
        "R2_ACCESS_KEY_ID": SECRET_REF % env("EP_SECRET_KEY_ID"),
        "R2_SECRET_ACCESS_KEY": SECRET_REF % env("EP_SECRET_KEY_SECRET"),
        # keeps handler.PLATFORM_LIMIT_S tied to the endpoint execution timeout
        "EXEC_TIMEOUT_S": str(timeout_ms // 1000),
    }
    e.update(json.loads(env("EP_TUNE_JSON", "{}")))
    return {
        "name": env("EP_NAME"),
        "type": "QUEUE",
        "image": env("EP_IMAGE"),
        "gpu": {"pools": [GPU_POOL], "excludedTypes": list(EXCLUDED_TYPES),
                "count": 1, "minCudaVersion": MIN_CUDA},
        "dataCenterIds": [env("EP_DC")],
        "mounts": {"network": [{"volumeId": env("EP_VOLUME_ID")}]},
        "workers": {"min": int(env("EP_MIN")), "max": int(env("EP_MAX")),
                    "idleTimeout": int(env("EP_IDLE"))},
        "scaling": {"type": "QUEUE_DELAY", "queueDelay": int(env("EP_QUEUE_DELAY", "4"))},
        "flashboot": "FLASHBOOT",  # REST default is OFF: always send it
        "timeout": timeout_ms,  # milliseconds
        "disk": int(env("EP_DISK", "20")),
        "env": e,
    }


def volume_ids(actual):
    ids = []
    for m in (dig(actual, "mounts.network") or []):
        if isinstance(m, dict) and m.get("volumeId"):
            ids.append(m["volumeId"])
    if actual.get("networkVolumeId"):
        ids.append(actual["networkVolumeId"])
    return sorted(set(ids))


def diff_endpoint(actual, desired):
    out = []
    if actual.get("image") != desired["image"]:
        out.append("image")
    ae = actual.get("env") or {}
    if any(ae.get(k) != v for k, v in desired["env"].items()):
        out.append("env")
    ag, dg = actual.get("gpu") or {}, desired["gpu"]
    if (sorted(ag.get("pools") or []) != sorted(dg["pools"])
            or sorted(ag.get("excludedTypes") or []) != sorted(dg["excludedTypes"])
            or ag.get("count") != dg["count"] or str(ag.get("minCudaVersion")) != dg["minCudaVersion"]):
        out.append("gpu")
    if sorted(actual.get("dataCenterIds") or []) != sorted(desired["dataCenterIds"]):
        out.append("dataCenterIds")
    if volume_ids(actual) != sorted(m["volumeId"] for m in desired["mounts"]["network"]):
        out.append("mounts")
    aw, dw = actual.get("workers") or {}, desired["workers"]
    if any(aw.get(k) != dw[k] for k in dw):
        out.append("workers")
    asc, dsc = actual.get("scaling") or {}, desired["scaling"]
    if any(asc.get(k) != dsc[k] for k in dsc):
        out.append("scaling")
    if actual.get("flashboot") != desired["flashboot"]:
        out.append("flashboot")
    if actual.get("timeout") != desired["timeout"]:
        out.append("timeout")
    if actual.get("disk") != desired["disk"]:
        out.append("disk")
    return out


def main():
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    if op == "get":
        try:
            v = dig(json.load(sys.stdin), sys.argv[2])
        except ValueError:
            v = None
        if v is None:
            return
        sys.stdout.write(v if isinstance(v, str) else json.dumps(v, separators=(",", ":")))
    elif op == "ids":
        pairs = [a.split("=", 1) for a in sys.argv[2:]]
        try:
            items = listify(json.load(sys.stdin))
        except ValueError:
            items = []
        for it in items:
            if isinstance(it, dict) and it.get("id") and all(str(dig(it, k)) == v for k, v in pairs):
                print(it["id"])
    elif op == "body-volume":
        emit({"name": env("V_NAME"), "size": int(env("V_GB")), "dataCenterId": env("V_DC")})
    elif op == "body-volume-size":
        emit({"size": int(env("V_GB"))})
    elif op == "body-secret":
        emit({"name": env("S_NAME"), "value": env("S_VALUE")})
    elif op == "body-secret-value":
        emit({"value": env("S_VALUE")})
    elif op == "body-endpoint":
        emit(build_endpoint())
    elif op == "diff-endpoint":
        for g in diff_endpoint(json.load(sys.stdin), json.loads(env("EP_DESIRED"))):
            print(g)
    elif op == "group-body":
        g = sys.argv[2]
        if g not in GROUPS:
            sys.exit(f"rpjson: unknown group {g}")
        emit({g: json.loads(env("EP_DESIRED"))[g]})
    elif op == "body-pod":
        e = {"HF_TOKEN": SECRET_REF % env("POD_SECRET_HF"), "VOLUME_ROOT": "/runpod-volume",
             "GIT_REF": env("POD_GIT_REF")}
        if os.environ.get("POD_SKIP_MOUNT_CHECK") == "1":
            e["SKIP_MOUNT_CHECK"] = "1"
        emit({
            "name": env("POD_NAME"), "image": env("POD_IMAGE"), "cloud": "SECURE",
            "cpu": {"id": env("POD_CPU_ID", "cpu3c"), "vcpuCount": int(env("POD_VCPU", "2"))},
            "dataCenterIds": [env("POD_DC")],
            "mounts": {"network": [{"volumeId": env("POD_VOLUME_ID"), "path": "/runpod-volume"}]},
            "disk": int(env("POD_DISK", "20")), "ports": [], "env": e,
            "cmd": ["bash", "-c", POD_SCRIPT],
        })
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
