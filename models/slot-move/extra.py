#!/usr/bin/env python3
"""Plant each mistake of extra-mutants.txt and run TLC on its model's small bounds.

These mistakes sit on lines that mutants.txt does not list; most are not
marked lines.  The old text must occur exactly once in the module.

A mistake is caught when a safety bound fails (the property is named), when
the model stops with an error, or when a reach goal can no longer be reached.
The stall check is not run here.

Environment as for mutate.py: TLA_JAR, WORK, HEAVY, WORKERS, LIMIT.
Usage: extra.py [id ...]   writes results/extra-mutants.json and .md
"""
import json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.environ.get("WORK", "./target/work"))
JAR = os.environ.get("TLA_JAR", "tla2tools.jar")
HEAVY = os.environ.get("HEAVY", "").split()
LIMIT = int(os.environ.get("LIMIT", "3600"))
WORKERS = os.environ.get("WORKERS", "2")

PLAN = {  # module: (safety bounds, reach bounds)
    "SlotMove": (["core", "crash", "bulk", "twice", "lock", "ver", "ver2", "lazy", "down",
                  "x-ver-copy", "x-lock-ver"],
                 ["r-moved", "r-back", "r-twice"]),
    "SlotMoveMsg": (["msg-core", "msg-early", "msg-crash", "msg-rec", "msg-rec-early", "msg-rec-crash",
                     "msg-rec-down", "msg-rec-twice", "msg-rec-lazy", "msg-rec-three", "msg-rec2"],
                    ["msg-r-early", "msg-r-lostback", "msg-r-reopen", "msg-r-oldreport",
                     "msg-r-aftersrc", "msg-r-afterdst", "msg-r-twice"]),
    "SlotMoveMembers": (["mem-src-core", "mem-dst-core", "mem-dst-grow", "mem-dst-shrink",
                         "mem-dst-fault", "mem-src-fault", "mem-src-cfg", "mem-src-cfg2"],
                        ["mem-src-r", "mem-dst-r", "mem-r-back"]),
}

def tlc(folder, cfg, module):
    meta = os.path.join(folder, "meta-" + cfg)
    cmd = HEAVY + ["java", "-Xmx3g", "-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC", "-noGenerateSpecTE",
                   "-workers", WORKERS, "-metadir", meta, "-config", cfg + ".cfg", module + ".tla"]
    t0 = time.time()
    with open(os.path.join(folder, cfg + ".out"), "w") as f:
        p = subprocess.Popen(cmd, cwd=folder, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            p.wait(timeout=LIMIT); late = False
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9); p.wait(); late = True
    out = open(os.path.join(folder, cfg + ".out")).read()
    shutil.rmtree(meta, ignore_errors=True)
    if "No error has been found" in out: verdict = "pass"
    elif "is violated" in out: verdict = "violated"
    elif late: verdict = "timeout"
    else: verdict = "error"
    if verdict == "error" and "states generated" not in out:
        raise SystemExit(f"{cfg}: the planted text does not parse or the run did not start")
    m = re.search(r"Invariant (\w+) is violated", out)
    return dict(bound=cfg, verdict=verdict, inv=m.group(1) if m else None,
                steps=len(re.findall(r"^State \d+:", out, re.M)), secs=round(time.time() - t0))

def one(mid, module, old, new, note):
    old, new = old.replace("\\n", "\n"), new.replace("\\n", "\n")
    text = open(os.path.join(HERE, module + ".tla")).read()
    if text.count(old) != 1:
        raise SystemExit(f"{mid}: the old text occurs {text.count(old)} times, not once")
    folder = os.path.join(WORK, "extra", mid)
    shutil.rmtree(folder, ignore_errors=True); os.makedirs(folder)
    open(os.path.join(folder, module + ".tla"), "w").write(text.replace(old, new))
    for f in os.listdir(HERE):
        if f.endswith(".cfg"): shutil.copy(os.path.join(HERE, f), folder)
    row = dict(id=mid, module=module, note=note, caught=False, by=None, runs=[])
    safe, reach = PLAN[module]
    for cfg in safe:
        r = tlc(folder, cfg, module); row["runs"].append(r)
        if r["verdict"] == "violated":
            row.update(caught=True, by=f"{r['inv']} on {cfg}, {r['steps']} steps"); break
        if r["verdict"] == "error":
            row.update(caught=True, by=f"the model stops with an error on {cfg}"); break
        if r["verdict"] == "timeout":
            row.update(by=f"(a run on {cfg} passed the time limit)")
    for cfg in ([] if row["caught"] else reach):
        r = tlc(folder, cfg, module); row["runs"].append(r)
        if r["verdict"] == "pass":
            row.update(caught=True, by=f"the goal cannot be reached on {cfg}"); break
    shutil.rmtree(folder, ignore_errors=True)
    return row

def main():
    want = set(sys.argv[1:])
    out = os.path.join(HERE, "results"); path = os.path.join(out, "extra-mutants.json")
    for line in open(os.path.join(HERE, "extra-mutants.txt")):
        if not line.strip() or line.startswith("#"): continue
        mid, module, old, new, note = [x.strip() for x in line.rstrip("\n").split(" ; ")]
        if want and mid not in want: continue
        row = one(mid, module, old, new, note)
        print(mid, "CAUGHT" if row["caught"] else "not caught", row["by"] or "", flush=True)
        rows = {r["id"]: r for r in json.load(open(path))} if os.path.exists(path) else {}
        rows[mid] = row
        json.dump([rows[k] for k in sorted(rows)], open(path, "w"), indent=1)
    rows = json.load(open(path))
    with open(os.path.join(out, "extra-mutants.md"), "w") as f:
        f.write("# More planted mistakes\n\nMade by `extra.py` from `extra-mutants.txt`: mistakes on lines "
                "that `mutants.txt` does not list. A probe is a change expected to be harmless.\n\n"
                "| id | model | the mistake | caught by | runs |\n|---|---|---|---|---|\n")
        for r in rows:
            f.write(f"| {r['id']} | {r['module']} | {r['note']} | {r['by'] if r['caught'] else '**not caught**'} | "
                    f"{len(r['runs'])}, {sum(x['secs'] for x in r['runs'])} s |\n")

main()
