#!/usr/bin/env python3
"""Plant each mistake of mutants.txt in a copy of its model and run TLC.

A mistake is caught when a safety check fails on some bound, when a reach
goal can no longer be reached, or when the "always can finish" check fails.

Environment: TLA_JAR (the tla2tools jar), WORK (a scratch folder, default
./target/work), HEAVY (an optional wrapper command), LIMIT (seconds a run
may take, default 3600), WORKERS (default 2), JAVA_MEM (the JVM's memory
flags, default -Xmx3g), FPMEM (TLC's -fpmem, default TLC's own).
Usage: mutate.py [id ...]   writes results/mutants.json and results/mutants.md
       mutate.py --report   writes mutants.md again from mutants.json
"""
import json, os, re, shutil, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.environ.get("WORK", "./target/work"))
JAR = os.environ.get("TLA_JAR", "tla2tools.jar")
HEAVY = os.environ.get("HEAVY", "").split()
LIMIT = int(os.environ.get("LIMIT", "3600"))
MEM = os.environ.get("JAVA_MEM", "-Xmx3g").split()
FPMEM = os.environ.get("FPMEM", "")
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import agef

# Per model: the safety bounds, small first; the reach bounds, whose goal
# must stay reachable; the bounds of the "always can finish" check.
PLAN = {
    "Settings": (["s-small", "s-two", "s-alter2"], ["s-reach", "s-reach-ro"], ["s-live"]),
    "HomeRecords": (["h-small", "h-foreign", "h-pre"], ["h-reach"], ["h-live"]),
    "Found": (["f-small", "f-crash", "f-homefirst", "f-quiet", "f-four"], ["f-reach"], ["f-live"]),
    "Selection": (["c-small", "c-move", "c-down", "c-back"], ["c-reach"], ["c-live", "c-back-live"]),
}
# The mistakes whose id starts with d: Found in the decided form (after card 0002).
DPLAN = (["fd-onebox", "fd-twobox", "fd-small", "fd-crash", "fd-shrink", "fd-late", "fd-four"],
         ["fd-reach", "fd-reach-late"], ["fd-live", "fd-late-live"])

def run(cmd, folder):
    """Run one TLC; on a timeout kill its whole process group."""
    p = subprocess.Popen(cmd, cwd=folder, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, start_new_session=True)
    try:
        out, _ = p.communicate(timeout=LIMIT)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        out, _ = p.communicate()
        out += "\nTIMEOUT\n"
    return out

def tlc(folder, module, cfg, dump=None):
    meta = os.path.join(folder, "meta-" + cfg)
    shutil.rmtree(meta, ignore_errors=True)
    cmd = HEAVY + ["java"] + MEM + ["-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC", "-noGenerateSpecTE",
                   "-workers", os.environ.get("WORKERS", "2"), "-metadir", meta]
    if FPMEM:
        cmd += ["-fpmem", FPMEM]
    if dump:
        cmd += ["-dump", "dot", dump]
    cmd += ["-config", cfg + ".cfg", module + ".tla"]
    t0 = time.time()
    out = run(cmd, folder)
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

def live(folder, module, cfg):
    """The "always can finish" check: TLC writes the graph, agef reads it."""
    dot = os.path.join(folder, cfg + ".dot")
    r = tlc(folder, module + "Live", cfg, dump=dot)
    if r["verdict"] == "pass":
        states, judged, goals, bad, _ = agef.check(dot)
        r.update(verdict="live" if not bad else "stuck", judged=judged, cannot=len(bad))
    if os.path.exists(dot):
        os.remove(dot)
    return r

def plant(module, rule, old, new, folder):
    lines = open(os.path.join(HERE, module + ".tla")).read().split("\n")
    hits = [i for i, l in enumerate(lines) if ("@rule " + rule) in l and old in l]
    if len(hits) != 1:
        raise SystemExit(f"{module} {rule}: the old text matches {len(hits)} lines, not 1")
    i = hits[0]
    lines[i] = lines[i].replace(old, new, 1)
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, module + ".tla"), "w").write("\n".join(lines))
    for f in os.listdir(HERE):
        if f.endswith(".cfg") or f == module + "Live.tla":
            shutil.copy(os.path.join(HERE, f), folder)

def rows_of(want):
    for line in open(os.path.join(HERE, "mutants.txt")):
        if not line.strip() or line.startswith("#"):
            continue
        mid, module, rule, old, new, note = [x.strip() for x in line.rstrip("\n").split(" ; ")]
        if want and mid not in want:
            continue
        yield mid, module, rule, old, new, note

def main():
    want = set(sys.argv[1:])
    if want == {"--check"}:                 # only check that every line plants
        for mid, module, rule, old, new, note in rows_of(set()):
            plant(module, rule, old, new, os.path.join(WORK, "mutants", mid))
        print("every mistake plants on one line")
        return
    rows = []
    for mid, module, rule, old, new, note in rows_of(want):
        folder = os.path.join(WORK, "mutants", mid)
        plant(module, rule, old, new, folder)
        safety, reach, lives = DPLAN if mid[0] == "d" else PLAN[module]
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
        for cfg in ([] if row["caught"] else lives):
            r = live(folder, module, cfg)
            row["runs"].append(dict(bound=cfg, **r))
            if r["verdict"] == "stuck":
                row.update(caught=True, by=f"cannot always finish on {cfg}: {r['cannot']} of {r['judged']} judged states")
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
    ("s", "Settings (row 1)"), ("h", "HomeRecords (row 2)"),
    ("f", "Found (row 3)"), ("c", "Selection (row 4)"),
]

def report(rows, out):
    with open(os.path.join(out, "mutants.md"), "w") as f:
        f.write("# Planted mistakes\n\nMade by `mutate.py` from `mutants.txt`. "
                "A mistake is caught when a property fails on a bound, when a reach goal "
                "can no longer be reached, or when the \"always can finish\" check fails.\n")
        real = [r for r in rows if r["id"][0] in "shfc"]
        n = sum(r["caught"] for r in real)
        pct = f" ({100 * n // len(real)} %)" if real else ""
        f.write(f"\n**{n} of {len(real)} caught{pct}.**\n")
        head = "| id | rule | the mistake | caught by | runs |\n|---|---|---|---|---|\n"
        for key, title in GROUPS:
            part = [r for r in real if r["id"][0] == key]
            if not part:
                continue
            k = sum(r["caught"] for r in part)
            f.write(f"\n## {title}: {k} of {len(part)} caught\n\n" + head)
            for r in part:
                secs = sum(x["secs"] for x in r["runs"])
                f.write(f"| {r['id']} | `{r['rule']}` | {r['note']} | "
                        f"{r['by'] or '**not caught**'} | {len(r['runs'])}, {secs} s |\n")
            print(f"{title}: {k} of {len(part)} caught")
        later = [r for r in rows if r["id"][0] == "d"]
        if later:
            k = sum(r["caught"] for r in later)
            f.write(f"\n## Found in the decided form, after card 0002: {k} of {len(later)} caught\n\n"
                    "Way B and the new reading of `slot-move.22` (Fewer = \"every\"), on the fd- bounds. "
                    "Counted apart from the total above.\n\n" + head)
            for r in later:
                secs = sum(x["secs"] for x in r["runs"])
                f.write(f"| {r['id']} | `{r['rule']}` | {r['note']} | "
                        f"{r['by'] or '**not caught**'} | {len(r['runs'])}, {secs} s |\n")
            print(f"decided form: {k} of {len(later)} caught")
        probes = [r for r in rows if r["id"][0] == "x"]
        if probes:
            k = sum(not r["caught"] for r in probes)
            f.write(f"\n## Probes: {k} of {len(probes)} not caught, as expected\n\n"
                    "Changes the design says are harmless in these worlds. They should NOT be caught.\n\n" + head)
            for r in probes:
                secs = sum(x["secs"] for x in r["runs"])
                f.write(f"| {r['id']} | `{r['rule']}` | {r['note']} | "
                        f"{r['by'] or 'not caught'} | {len(r['runs'])}, {secs} s |\n")
        print(f"all: {n} of {len(real)} caught")

if __name__ == "__main__":
    if sys.argv[1:] == ["--report"]:
        out = os.path.join(HERE, "results")
        report(json.load(open(os.path.join(out, "mutants.json"))), out)
    else:
        main()
