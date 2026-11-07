#!/usr/bin/env python3
"""E-22b: how many operations overlap in time in each partition (the most calls open at once).

  overlap.py <min-ops> <hist.jsonl>...

Knossos's search grows with overlap, not with length; this sized the step for the 600 largest
partitions. Times are E-22's exported call (c) and return (r) times, a call before a return at
equal times, as Porcupine and knossos_check.clj order them.
"""
import json
import os
import statistics
import sys


def main():
    minops = int(sys.argv[1])
    print("| history file | partitions with at least", minops, "ops | ops: min / max | most ops open at once: median / max |")
    print("|---|---|---|---|")
    for path in sys.argv[2:]:
        rows = []
        with open(path) as f:
            for line in f:
                for p in json.loads(line)["parts"]:
                    ops = p["ops"]
                    if len(ops) < minops:
                        continue
                    ev = sorted([(o["c"], 0) for o in ops] + [(o["r"], 1) for o in ops])
                    cur = top = 0
                    for _, k in ev:
                        cur += 1 if k == 0 else -1
                        top = max(top, cur)
                    rows.append((len(ops), top))
        if rows:
            print(f"| {os.path.basename(path)} | {len(rows)} | {min(r[0] for r in rows)} / {max(r[0] for r in rows)} | "
                  f"{statistics.median(r[1] for r in rows):g} / {max(r[1] for r in rows)} |")


if __name__ == "__main__":
    main()
