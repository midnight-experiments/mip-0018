# SPDX-License-Identifier: Apache-2.0
#
# Host-side helper of examples-e2e.sh: reads a Stagenet case folder (deployments/stagenet/cases/<ID>/case.json) and
# expands each step's argv for the LOCAL stack, exactly as the signer expands it for Stagenet (only the placeholders differ):
#
#   python3 case.py steps <case.json>                       one line per step: index TAB id TAB runner TAB exit TAB stdout
#                                                           TAB expected output text (failing steps)
#   python3 case.py argv <case.json> <index> <e2e dir>      the step's argv, NUL-separated (container paths)
#
# Local values: {net} = --network undeployed (URLs from the container environment); {signer} = the dev chain's
# public genesis wallet with a 0600 sync cache; {signer2} = the funded local test wallet B with its OWN private-state
# file; {case} = the case folder in the repository; {out} / {out:<ID>} = /e2e/cases/<ID>; {firstHeight} /
# {lastHeight} = the lowest inclusion height of every case record minus 10 / the highest one.
import glob
import json
import os
import sys

LOCAL = {
    "{net}": ["--network", "undeployed"],
    "{signer}": ["--dev-genesis-wallet", "--wallet-cache", "/run/mip0018/state/a.wallet-cache"],
    "{signer2}": [
        "--seed-file", "/run/mip0018/secrets/b.seed",
        "--private-state", "/run/mip0018/state/b-private-state.json",
        "--wallet-cache", "/run/mip0018/state/b.wallet-cache",
    ],
}


def heights(e2e):
    hs = []
    for f in glob.glob(os.path.join(e2e, "cases", "*", "record.json")):
        for s in json.load(open(f)).get("steps", []):
            h = (s.get("inclusion") or {}).get("height")
            if h is not None:
                hs.append(h)
    if not hs:
        raise SystemExit("no inclusion heights in the case records yet")
    return max(0, min(hs) - 10), max(hs)


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    c = json.load(open(path))
    case_id = c["id"]
    if cmd == "steps":
        for i, s in enumerate(c["steps"]):
            print("\t".join([str(i), s["id"], s["runner"], str(s["expectExit"]), s.get("stdout", ""), s.get("expectOutput", "")]))
        return
    if cmd == "argv":
        step = c["steps"][int(sys.argv[3])]
        e2e = sys.argv[4]
        first = last = None
        out = []
        for a in step["argv"]:
            if a in LOCAL:
                out.extend(LOCAL[a])
                continue
            if "{firstHeight}" in a or "{lastHeight}" in a:
                first, last = heights(e2e)
                a = a.replace("{firstHeight}", str(first)).replace("{lastHeight}", str(last))
            a = a.replace("{case}", "deployments/stagenet/cases/" + case_id).replace("{out}", "/e2e/cases/" + case_id)
            while "{out:" in a:
                i = a.index("{out:")
                j = a.index("}", i)
                a = a[:i] + "/e2e/cases/" + a[i + 5 : j] + a[j + 1 :]
            out.append(a)
        sys.stdout.write("\0".join(out) + "\0")
        return
    raise SystemExit("usage: case.py steps <case.json> | argv <case.json> <index> <e2e dir>")


main()
