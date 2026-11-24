#!/usr/bin/env python3
"""Plant each mistake of mutants.txt in a copy of its model and run TLC.

A mistake is caught when a safety check fails on some bound, or when the
goal of the reach bound (every write lands) can no longer be reached.

Environment: TLA_JAR (the tla2tools jar), WORK (a scratch folder, default
./target/work), HEAVY (an optional wrapper command), LIMIT (seconds a run
may take, default 3600).
Usage: mutate.py [id ...]   writes results/mutants.json and results/mutants.md
       mutate.py --report   writes mutants.md again from mutants.json
"""
import json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.environ.get("WORK", "./target/work"))
JAR = os.environ.get("TLA_JAR", "tla2tools.jar")
HEAVY = os.environ.get("HEAVY", "").split()
LIMIT = int(os.environ.get("LIMIT", "3600"))

# Bounds tried for each model, small first; then the reach bounds, whose goal
# must stay reachable.
PLAN = {
    "OneNumber": (["movedoor", "move", "restart", "lapse", "door", "lost", "all", "retrylife"], ["reach", "reachdoor"]),
    "OneNumberDerived": (["d-small", "d-crash", "d-move"], ["d-reach"]),
}

def tlc(folder, module, cfg):
    meta = os.path.join(folder, "meta-" + cfg)
    shutil.rmtree(meta, ignore_errors=True)
    cmd = HEAVY + ["java", "-Xmx3g", "-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC", "-noGenerateSpecTE",
                   "-workers", os.environ.get("WORKERS", "2"), "-metadir", meta,
                   "-config", cfg + ".cfg", module + ".tla"]
    t0 = time.time()
    try:
        out = subprocess.run(cmd, cwd=folder, capture_output=True, text=True, timeout=LIMIT).stdout
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        out += "\nTIMEOUT\n"
    secs = round(time.time() - t0)
    with open(os.path.join(folder, cfg + ".out"), "w") as f:
        f.write(out)
    shutil.rmtree(meta, ignore_errors=True)
    if "No error has been found" in out:
        verdict = "pass"
    elif "is violated" in out:
        verdict = "violated"
    elif "TIMEOUT" in out:
        verdict = "timeout"
    else:
        verdict = "error"
    m = re.search(r"Invariant (\w+) is violated", out)
    steps = len(re.findall(r"^State \d+:", out, re.M))
    d = re.search(r"(\d+) distinct states found", out)
    return dict(verdict=verdict, inv=m.group(1) if m else None, steps=steps,
                distinct=int(d.group(1)) if d else None, secs=secs)

def plant(module, rule, old, new, folder):
    lines = open(os.path.join(HERE, module + ".tla")).read().split("\n")
    # A rule named "-" is a line with no mark: the old text must be on one line only.
    hits = [i for i, l in enumerate(lines)
            if (rule == "-" or any((tag + rule) in l for tag in ("@rule ", "@keeps ", "@probe "))) and old in l]
    if len(hits) != 1:
        raise SystemExit(f"{module} {rule}: the old text matches {len(hits)} lines, not 1")
    i = hits[0]
    lines[i] = lines[i].replace(old, new, 1)
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, module + ".tla"), "w").write("\n".join(lines))
    for f in os.listdir(HERE):
        if f.endswith(".cfg"):
            shutil.copy(os.path.join(HERE, f), folder)

def main():
    want = set(sys.argv[1:])
    rows = []
    for line in open(os.path.join(HERE, "mutants.txt")):
        if not line.strip() or line.startswith("#"):
            continue
        mid, module, rule, old, new, note = [x.strip() for x in line.rstrip("\n").split(" ; ")]
        if want and mid not in want:
            continue
        folder = os.path.join(WORK, "mutants", mid)
        plant(module, rule, old, new, folder)
        safety, reach = PLAN[module]
        row = dict(id=mid, model=module, rule=rule, note=note, caught=False, by=None, runs=[])
        for cfg in safety:
            r = tlc(folder, module, cfg)
            row["runs"].append(dict(bound=cfg, **r))
            if r["verdict"] == "violated":
                where = f"{r['steps']} steps" if r["steps"] else "the first state"
                row.update(caught=True, by=f"{r['inv']} on {cfg}, {where}")
                break
            if r["verdict"] == "error":
                row.update(caught=True, by=f"the model stops with an error on {cfg}")
                break
        for cfg in ([] if row["caught"] else reach):
            r = tlc(folder, module, cfg)
            row["runs"].append(dict(bound=cfg, **r))
            if r["verdict"] == "pass":
                row.update(caught=True, by=f"the goal cannot be reached on {cfg}")
                break
        rows.append(row)
        print(mid, rule, "CAUGHT" if row["caught"] else "not caught", row["by"] or "", flush=True)
    out = os.path.join(HERE, "results")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "mutants.json")
    if want and os.path.exists(path):
        old = {r["id"]: r for r in json.load(open(path))}
        old.update({r["id"]: r for r in rows})
        rows = [old[k] for k in sorted(old)]
    json.dump(rows, open(path, "w"), indent=1)
    report(rows, out)

GROUPS = [
    ("md", "The new form's rules",
     "Each line is a mistake in a rule of the one-number form. A good model catches it."),
    ("k", "Today's rules that stay",
     "Rules of today that the form keeps as they are. The model must still need them."),
    ("c", "A second check: mistakes on lines with no mark",
     "Planted by a second reader, on lines of the world and of the client that hold no marked rule."),
    ("x", "Probes",
     "Changes the design says are harmless. They should NOT be caught."),
]

def report(rows, out):
    with open(os.path.join(out, "mutants.md"), "w") as f:
        f.write("# Planted mistakes\n\nMade by `mutate.py` from `mutants.txt`. "
                "A mistake is caught when a property fails on a bound, "
                "or when a reach goal can no longer be reached.\n")
        for keys, title, text in GROUPS:
            part = [r for r in rows if r["id"][0] in keys]
            if not part:
                continue
            n = sum(r["caught"] for r in part)
            f.write(f"\n## {title}: {n} of {len(part)} caught\n\n{text}\n\n")
            f.write("| id | model | rule | the mistake | caught by | bounds run |\n|---|---|---|---|---|---|\n")
            for r in part:
                secs = sum(x["secs"] for x in r["runs"])
                f.write(f"| {r['id']} | {r['model']} | `{r['rule']}` | {r['note']} | "
                        f"{r['by'] or '**not caught**'} | {len(r['runs'])}, {secs} s |\n")
            print(f"{title}: {n} of {len(part)} caught")

if sys.argv[1:] == ["--report"]:
    out = os.path.join(HERE, "results")
    report(json.load(open(os.path.join(out, "mutants.json"))), out)
else:
    main()
