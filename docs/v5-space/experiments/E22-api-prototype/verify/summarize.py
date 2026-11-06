"""summarize — step 3's tables from the raw results (run by run.sh; plain Python, no packages).

  python3 summarize.py elle <elle-raw.jsonl>   per variant and mode: Elle's verdicts and anomaly counts
  python3 summarize.py report <results dir>    results/matrix.md: the per-pattern table and the rest
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PATTERNS = [
    ("P-01", "live shared state", "p01", "examples/p01-live-state.ts"),
    ("P-02", "cache, sessions", "p02", "patterns/p02-cache.ts"),
    ("P-03", "near cache", "p03", "patterns/p03-near-cache.ts"),
    ("P-04", "read-through", "p04", "patterns/p04-read-through.ts"),
    ("P-05", "rooms (fan-out)", "p05", "patterns/p05-rooms.ts"),
    ("P-06", "pub/sub", "p06", "patterns/p06-pubsub.ts"),
    ("P-07", "streams, replay", "p07", "patterns/p07-stream.ts"),
    ("P-08", "consumer groups", "p08", "patterns/p08-consumer-groups.ts"),
    ("P-09", "work queue", "p09", "patterns/p09-queue.ts"),
    ("P-10", "locks, election", "p10", "patterns/p10-locks.ts"),
    ("P-11", "counters, limits", "p11", "patterns/p11-counters.ts"),
    ("P-12", "leaderboards", "p12", "patterns/p12-leaderboard.ts"),
    ("P-13", "presence", "p13", "patterns/p13-presence.ts"),
    ("P-14", "invariants", "p14", "examples/p14-invariants.ts"),
    ("P-15", "sagas", "p15", "patterns/p15-saga.ts"),
    ("P-16", "event sourcing", "p16", "patterns/p16-event-sourcing.ts"),
    ("P-17", "derived resources", "p17", "patterns/p17-derive.ts"),
    ("P-18", "tapes (fork not built)", "p18", "patterns/p18-tapes.ts"),
    ("P-19", "clients everywhere", "p19", "patterns/p19-clients.ts"),
    ("P-20", "shape change", "p20", "patterns/p20-shape.ts"),
    ("P-21", "request, reply", "p21", "patterns/p21-request-reply.ts"),
    ("P-22", "delayed jobs", "p22", "patterns/p22-delayed.ts"),
]
EXTRA = [
    ("Q-22", "check-then-set race", "cts", None),
    ("core", "exactly once", "core-exactly-once", None),
    ("core", "log reader cursors", "core-reader", None),
    ("core", "feature checks", "core-features", None),
    ("TEST-02", "determinism", "core-determinism", None),
    ("TEST-13", "register workload", "lin-kv", None),
    ("P-14", "phantom conflict (refusal under a lost tail)", "phantom", None),
    ("TEST-12", "planted app (2 partitions)", "order-planted", None),
    ("TEST-12", "fixed app (1 partition)", "order-fixed", None),
]


def lines(path):
    with open(os.path.join(ROOT, path)) as f:
        return sum(1 for _ in f)


def jl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("{"):
                out.append(json.loads(line))
    return out


def elle(raw):
    rows = defaultdict(lambda: {"files": 0, "rc": 0, "sr": 0, "anom": defaultdict(int), "files_with": defaultdict(int), "ex": None})
    for d in jl(raw):
        m = re.match(r"(\w+)-(\w+)-seed(\d+)\.edn", d["file"])
        if not m:
            continue
        r = rows[(m.group(1), m.group(2))]
        r["files"] += 1
        r["rc"] += 1 if d["readCommittedValid"] else 0
        r["sr"] += 1 if d["serializableValid"] else 0
        for k, v in d.get("anomalyCounts", {}).items():
            r["anom"][k] += v
            r["files_with"][k] += 1
    print("| variant | mode | histories | read committed valid | serializable valid | anomalies (histories with it: total cases) |")
    print("|---|---|---|---|---|---|")
    for (v, mode), r in sorted(rows.items(), key=lambda x: (["saga", "owned", "undo", "nolock"].index(x[0][0]), ["calm", "faults", "shuffle"].index(x[0][1]))):
        an = ", ".join(f"{k} {r['files_with'][k]}: {r['anom'][k]}" for k in sorted(r["anom"])) or "none"
        print(f"| {v} | {mode} | {r['files']} | {r['rc']} | {r['sr']} | {an} |")


def report(rdir):
    mx = jl(os.path.join(rdir, "matrix.jsonl"))
    por = jl(os.path.join(rdir, "porcupine.jsonl"))
    by = {(d["name"], d["mode"]): d for d in mx}
    # matrix names: the check's own name (r.name) differs from the short name; map by E22 short name
    short = {}
    for d in mx:
        short[(d["check"], d["name"], d["mode"])] = d
    pmap = {}
    for d in por:
        m = re.match(r"(.+)-(calm|faults|shuffle)\.jsonl", d["file"])
        if m:
            pmap[(m.group(1), m.group(2))] = d

    def find(n, mode):
        for d in mx:
            if d["mode"] == mode and (d["name"] == n or d["name"].startswith(n + "-") or d["check"].startswith(n + ".") or d["check"].startswith(n + "-")):
                return d
        return None

    def cell(d):
        if d is None:
            return "not run"
        w = d["worlds"] if d["name"] != "core-determinism" else d["worlds"] // 2
        bad = len([s for s in d["failedSeeds"] if s is not None])
        if d["line"].startswith("HUNG"):
            return f"hung at seed {d['failedSeeds'][0]}"
        if d["name"] == "core-determinism":
            return "ok" if bad == 0 else "FAIL"
        return f"{w - bad}/{w}" if bad else f"{w}/{w}"

    def cover(d):
        if d is None or d["mode"] == "calm":
            return ""
        w = d["worlds"]
        c = d["cover"]
        return f"{c['lcInFlight']}/{w}, {c['moveInFlight']}/{w}"

    def lin(n):
        tot = {"parts": 0, "ok": 0, "ill": 0, "unk": 0, "ops": 0}
        for mode in ("calm", "faults", "shuffle"):
            d = pmap.get((n, mode))
            if not d:
                continue
            tot["parts"] += d["parts"]; tot["ok"] += d["ok"]; tot["ill"] += d["illegal"]; tot["unk"] += d["unknown"]; tot["ops"] += d["ops"]
        if tot["parts"] == 0:
            return "no KV history (log readers or streams only)"
        s = f"{tot['ok']}/{tot['parts']} linearizable ({tot['ops']} ops)"
        if tot["ill"]:
            s += f", **{tot['ill']} not**"
        if tot["unk"]:
            s += f", {tot['unk']} timed out"
        return s

    def direct(n):
        tot = defaultdict(int)
        for mode in ("calm", "faults", "shuffle"):
            d = find(n, mode)
            if d:
                for k, v in d["direct"].items():
                    tot[k] += v
        bad = {k: v for k, v in tot.items() if v}
        return "clean" if not bad else ", ".join(f"**{k} {v}**" for k, v in bad.items())

    out = []
    out.append("# E-22 step 3: the matrix (generated by verify/summarize.py from verify/results/)\n")
    out.append("Seeds per cell: 100 (core-determinism: 100 seeds, each run twice). calm = no leader change, move or message loss, shuffle off; faults = the check's own faults plus one forced leader change and one forced slot move aimed at a write in flight, shuffle off; shuffle = faults with TEST-12's shuffle on. In flight = seeds where a leader change (LC) or a move overlapped a client operation on the same resource. Porcupine = per-partition histories of every mode together. Direct = exactly-once, refusals, acks in the log, committed entries kept, fencing (log and real time), session order.\n")
    out.append("| id | pattern | example lines | calm | faults | shuffle | LC, move in flight (shuffle) | Porcupine | direct checks |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for pid, name, n, ex in PATTERNS + EXTRA:
        ln = str(lines(ex)) if ex else "-"
        out.append(f"| {pid} | {name} | {ln} | {cell(find(n, 'calm'))} | {cell(find(n, 'faults'))} | {cell(find(n, 'shuffle'))} | {cover(find(n, 'shuffle'))} | {lin(n)} | {direct(n)} |")
    out.append("")
    out.append("## Failures, by check and mode\n")
    for d in mx:
        if d["failedSeeds"]:
            out.append(f"- **{d['name']} {d['mode']}**: {d['line']}")
            for e in d["errors"][:4]:
                out.append(f"  - {e[:400]}")
    out.append("")
    out.append("## Fault totals per mode (all checks)\n")
    out.append("| mode | worlds | elections | tail entries lost | moves done / started | forced faults landed | resends answered by dedup |")
    out.append("|---|---|---|---|---|---|---|")
    for mode in ("calm", "faults", "shuffle"):
        ds = [d for d in mx if d["mode"] == mode]
        f = lambda k: sum(d["cover"][k] for d in ds)
        out.append(f"| {mode} | {sum(d['worlds'] for d in ds)} | {f('elections')} | {f('lost')} | {f('movesDone')}/{f('moves')} | {f('forced')} | {f('dedup')} |")
    out.append("")
    mut = jl(os.path.join(rdir, "mutants.jsonl"))
    if mut:
        out.append("## Mutants: planted kernel bugs, and who caught them\n")
        mp = {}
        for d in jl(os.path.join(rdir, "mutants.txt")):
            m = re.match(r"mut-(\w+)-(.+)\.jsonl", d.get("file", ""))
            if m:
                mp[(m.group(1), m.group(2))] = d
        out.append("| mutant | check | the check's own assertions | direct checks | Porcupine |")
        out.append("|---|---|---|---|---|")
        for d in mut:
            p = mp.get((d["mutant"], d["check"].replace(".check.ts", "")))
            ps = f"{p['illegal']} of {p['parts']} partitions not linearizable, in {len(p['badSeeds'])} of {p['seeds']} seeds" if p else "-"
            dr = ", ".join(f"{k} {v}" for k, v in d["direct"].items() if v) or "none"
            own = d["line"].split(";")[0]
            out.append(f"| {d['mutant']} | {d['name']} | {own} | {dr} | {ps} |")
        out.append("")
    print("\n".join(out))


if __name__ == "__main__":
    if sys.argv[1] == "elle":
        elle(sys.argv[2])
    else:
        report(sys.argv[2])
