#!/usr/bin/env python3
"""E-22b: build Knossos job files (one partition per line) from E-22's saved histories.

  prep.py elleself <selftest.json> <dir>
      E-22's 8 Elle self-test cases as EDN files self-elle-<i>.edn.
  prep.py self <selftest.json> <jobs.jsonl>
      E-22's 18 Porcupine self-test cases (dumped by `e22b dumpself`) as jobs.
  prep.py all <jobs.jsonl> <hist.jsonl>...
      every partition of every seed of the given history files.
  prep.py sample <jobs.jsonl> <k> <max-ops> <hist.jsonl>...
      per file, k partitions drawn at random (seeded by the file name, so it replays) from the
      partitions with at most max-ops operations; the cut and the draw are written to stderr.

A job line is E-22's partition object ({res, p, vals, ops}) plus where it came from
(file, check, mode, mutant, seed, idx), so a result joins back to Porcupine's line for it.
"""
import json
import os
import random
import sys


def parts_of(path):
    base = os.path.basename(path)
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            for i, p in enumerate(d["parts"]):
                yield {"file": base, "check": d["check"], "mode": d["mode"], "mutant": d.get("mutant"),
                       "seed": d["seed"], "idx": i, **p}


def main():
    cmd = sys.argv[1]
    if cmd == "elleself":
        d = json.load(open(sys.argv[2]))
        os.makedirs(sys.argv[3], exist_ok=True)
        for i, c in enumerate(d["elle"]):
            with open(os.path.join(sys.argv[3], f"self-elle-{i}.edn"), "w") as w:
                w.write(c["edn"].strip() + "\n")
        return
    if cmd == "self":
        d = json.load(open(sys.argv[2]))
        with open(sys.argv[3], "w") as w:
            for i, c in enumerate(d["lin"]):
                w.write(json.dumps({"file": "selftest", "check": c["name"], "mode": "want " + c["want"],
                                    "seed": 0, "idx": i, "res": "t", "p": "p", "vals": True, "ops": c["ops"]}) + "\n")
        return
    out = sys.argv[2]
    if cmd == "all":
        n = 0
        with open(out, "a") as w:
            for path in sys.argv[3:]:
                for p in parts_of(path):
                    w.write(json.dumps(p) + "\n")
                    n += 1
        print(f"all: {n} partitions from {len(sys.argv) - 3} files", file=sys.stderr)
        return
    if cmd == "sample":
        k, maxops = int(sys.argv[3]), int(sys.argv[4])
        with open(out, "a") as w:
            for path in sys.argv[5:]:
                ps = list(parts_of(path))
                small = [p for p in ps if len(p["ops"]) <= maxops]
                rng = random.Random(os.path.basename(path))
                pick = sorted(rng.sample(range(len(small)), min(k, len(small))))
                for i in pick:
                    w.write(json.dumps(small[i]) + "\n")
                print(f"sample {os.path.basename(path)}: {len(ps)} partitions, {len(small)} with <= {maxops} ops, "
                      f"drew {len(pick)}", file=sys.stderr)
        return
    raise SystemExit("usage: prep.py self|all|sample ...")


if __name__ == "__main__":
    main()
