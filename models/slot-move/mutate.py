#!/usr/bin/env python3
"""Plant each mistake of mutants.txt in a copy of its model and run TLC.

The id's first letter names the model: u is SlotMoveMsg.tla, n is
SlotMoveMembers.tla, every other letter is SlotMove.tla.

A mistake is caught when
  - a safety check fails on some bound (first without the check `Whole`,
    which compares a final copy with the source directly; then with it), or
  - a reach goal can no longer be reached, or
  - the stall check finds a state the writes cannot finish from.

Environment: TLA_JAR (the tla2tools jar), WORK (a scratch folder, default
./target/work), HEAVY (an optional wrapper command), WORKERS (default 2),
LIMIT (seconds one run may take, default 3600).
Usage: mutate.py [id ...]   writes results/mutants.json and results/mutants.md
       mutate.py --report   writes mutants.md again from mutants.json
"""
import json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.environ.get("WORK", "./target/work"))
JAR = os.environ.get("TLA_JAR", "tla2tools.jar")
HEAVY = os.environ.get("HEAVY", "").split()
LIMIT = int(os.environ.get("LIMIT", "3600"))
WORKERS = os.environ.get("WORKERS", "2")

SAFETY = ["core", "crash", "bulk", "twice", "lock", "ver", "ver2", "lazy", "down"]
REACH = ["r-moved", "r-back", "r-twice"]
STALL = ["s-lazy", "s-twice"]
# The second and third models: for each run of ids, the module, the quick
# safety bounds, the reach bounds, and the slower safety bounds (run last).
# A mistake is run on the bounds whose world can show it.
OTHER = {
    "u": [(1, 26, "SlotMoveMsg",       # the rules a recovery needs
           ["msg-rec", "msg-rec-twice", "msg-rec-lazy", "msg-rec-early", "msg-rec-crash", "msg-rec-down"],
           ["msg-r-early", "msg-r-lostback", "msg-r-reopen", "msg-r-oldreport", "msg-r-aftersrc",
            "msg-r-afterdst"],
           ["msg-rec-three", "msg-rec2"]),
          (27, 43, "SlotMoveMsg",      # the early carried set, the delta, the merge
           ["msg-early", "msg-crash", "msg-rec-early"],
           ["msg-r-early"],
           []),
          (44, 99, "SlotMoveMsg",      # the move's own guards
           ["msg-core", "msg-early", "msg-crash", "msg-rec", "msg-rec-twice", "msg-rec-lazy"],
           ["msg-r-early", "msg-r-lostback", "msg-r-reopen", "msg-r-oldreport"],
           ["msg-rec-three"])],
    "n": [(1, 99, "SlotMoveMembers",
           ["mem-src-core", "mem-dst-core", "mem-dst-grow", "mem-dst-shrink"],
           ["mem-src-r", "mem-dst-r"],
           ["mem-dst-fault", "mem-src-fault", "mem-src-cfg", "mem-src-cfg2"])],
}
def plan_of(mid):
    for lo, hi, module, safe, reach, slow in OTHER[mid[0]]:
        if lo <= int(mid[1:]) <= hi:
            return module, safe, reach, slow
    raise SystemExit(f"{mid}: no plan")
def module_of(mid):
    return plan_of(mid)[0] if mid[0] in OTHER else "SlotMove"
MARK = re.compile(r"\\\* @(?:rule|keeps|world) (.*)$")

def java(folder, args, name):
    cmd = HEAVY + ["java", "-Xmx3g", "-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC",
                   "-noGenerateSpecTE"] + args
    t0 = time.time()
    with open(os.path.join(folder, name + ".out"), "w") as f:
        p = subprocess.Popen(cmd, cwd=folder, stdout=f, stderr=subprocess.STDOUT,
                             start_new_session=True)
        try:
            p.wait(timeout=LIMIT)
            late = False
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9); p.wait(); late = True
    out = open(os.path.join(folder, name + ".out")).read()
    return out, late, round(time.time() - t0)

def tlc(folder, cfg, whole, module="SlotMove"):
    name = cfg + ("" if whole else "-nw")
    text = open(os.path.join(HERE, cfg + ".cfg")).read()
    if not whole:
        text = text.replace(" Whole", "")
    open(os.path.join(folder, name + ".cfg"), "w").write(text)
    meta = os.path.join(folder, "meta-" + name)
    out, late, secs = java(folder, ["-workers", WORKERS, "-metadir", meta,
                                    "-config", name + ".cfg", module + ".tla"], name)
    shutil.rmtree(meta, ignore_errors=True)
    if "No error has been found" in out:
        verdict = "pass"
    elif "is violated" in out:
        verdict = "violated"
    elif late:
        verdict = "timeout"
    else:
        verdict = "error"
    if verdict == "error" and "states generated" not in out and "Parsing or semantic" in out:
        raise SystemExit(f"{cfg}: the planted text does not parse")
    m = re.search(r"Invariant (\w+) is violated", out)
    steps = len(re.findall(r"^State \d+:", out, re.M))
    d = re.search(r"(\d+) distinct states found", out)
    return dict(verdict=verdict, inv=m.group(1) if m else None, steps=steps,
                distinct=int(d.group(1)) if d else None, secs=secs)

def stall(folder, cfg):
    meta = os.path.join(folder, "meta-" + cfg)
    dot = os.path.join(folder, cfg + ".dot")
    out, late, secs = java(folder, ["-workers", "1", "-metadir", meta, "-dump", "dot,actionlabels", dot,
                                    "-config", cfg + ".cfg", "SlotMoveStall.tla"], cfg)
    shutil.rmtree(meta, ignore_errors=True)
    if late or not os.path.exists(dot) or "Error" in out:
        return dict(verdict="timeout" if late else "error", secs=secs)
    r = subprocess.run([sys.executable, os.path.join(HERE, "stall.py"), dot],
                       capture_output=True, text=True).stdout
    os.remove(dot)
    found = [l.rsplit(": ", 1)[0] for l in r.split("\n")
             if "stuck of" in l and not l.rsplit(": ", 1)[1].startswith("0 ")]
    return dict(verdict="stall" if "stall: FOUND" in r else "pass", what="; ".join(found), secs=secs)

def plant(rule, old, new, folder, module="SlotMove"):
    lines = open(os.path.join(HERE, module + ".tla")).read().split("\n")
    hits = [i for i, l in enumerate(lines)
            if MARK.search(l) and MARK.search(l).group(1).strip() == rule and old in l]
    if len(hits) != 1:
        raise SystemExit(f"{rule}: the old text matches {len(hits)} marked lines, not 1")
    i = hits[0]
    lines[i] = lines[i].replace(old, new, 1)
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, module + ".tla"), "w").write("\n".join(lines))
    if module == "SlotMove":
        shutil.copy(os.path.join(HERE, "SlotMoveStall.tla"), folder)
    for f in os.listdir(HERE):
        if f.endswith(".cfg"):
            shutil.copy(os.path.join(HERE, f), folder)

def one(mid, rule, old, new, note):
    folder = os.path.join(WORK, "mutants", mid)
    shutil.rmtree(folder, ignore_errors=True)
    plant(rule, old, new, folder, module_of(mid))
    row = dict(id=mid, rule=rule, note=note, caught=False, by=None, runs=[])
    if mid[0] in OTHER:
        module, safe, reach, slow = plan_of(mid)
        def safety2(bounds):
            for cfg in ([] if row["caught"] else bounds):
                r = tlc(folder, cfg, True, module)
                row["runs"].append(dict(bound=cfg, **r))
                if r["verdict"] == "violated":
                    where = f"{r['steps']} steps" if r["steps"] else "the first state"
                    row.update(caught=True, by=f"{r['inv']} on {cfg}, {where}")
                    break
                if r["verdict"] == "error":
                    row.update(caught=True, by=f"the model stops with an error on {cfg}")
                    break
        safety2(safe)
        for cfg in ([] if row["caught"] else reach):
            r = tlc(folder, cfg, True, module)
            row["runs"].append(dict(bound=cfg, **r))
            if r["verdict"] == "pass":
                row.update(caught=True, by=f"the goal cannot be reached on {cfg}")
                break
        safety2(slow)
        shutil.rmtree(folder, ignore_errors=True)
        return row
    def safety(whole):
        for cfg in SAFETY:
            r = tlc(folder, cfg, whole)
            row["runs"].append(dict(bound=cfg + ("" if whole else " (no Whole)"), **r))
            if r["verdict"] == "violated":
                where = f"{r['steps']} steps" if r["steps"] else "the first state"
                row.update(caught=True, by=f"{r['inv']} on {cfg}, {where}")
                return
            if r["verdict"] == "error":
                row.update(caught=True, by=f"the model stops with an error on {cfg}")
                return
    safety(False)
    for cfg in ([] if row["caught"] else REACH):
        r = tlc(folder, cfg, True)
        row["runs"].append(dict(bound=cfg, **r))
        if r["verdict"] == "pass":
            row.update(caught=True, by=f"the goal cannot be reached on {cfg}")
            break
    for cfg in ([] if row["caught"] else STALL):
        r = stall(folder, cfg)
        row["runs"].append(dict(bound=cfg, **r))
        if r["verdict"] == "stall":
            row.update(caught=True, by=f"the stall check on {cfg} ({r['what']})")
            break
    if not row["caught"]:
        safety(True)
    shutil.rmtree(folder, ignore_errors=True)
    return row

def main():
    want = set(sys.argv[1:])
    rows = []
    out = os.path.join(HERE, "results")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "mutants.json")
    for line in open(os.path.join(HERE, "mutants.txt")):
        if not line.strip() or line.startswith("#"):
            continue
        mid, rule, old, new, note = [x.strip() for x in line.rstrip("\n").split(" ; ")]
        if want and mid not in want:
            continue
        row = one(mid, rule, old, new, note)
        rows.append(row)
        print(mid, rule, "CAUGHT" if row["caught"] else "not caught", row["by"] or "", flush=True)
        # save as we go, so a stopped run keeps what it has
        old_rows = {r["id"]: r for r in json.load(open(path))} if os.path.exists(path) else {}
        old_rows.update({r["id"]: r for r in rows})
        json.dump([old_rows[k] for k in sorted(old_rows)], open(path, "w"), indent=1)
    report(json.load(open(path)), out)

GROUPS = [
    ("m", "The move's own entries and guards", "A good model catches each."),
    ("c", "The carried set, one part at a time", "Each part left behind must break something."),
    ("t", "The slot table in the home log", "The row, the write-back, and when a move has ended."),
    ("k", "Rules of other mechanisms the move leans on", "The model must still need them."),
    ("x", "Probes", "Changes the model says are harmless. They should NOT be caught."),
    ("u", "The second model (SlotMoveMsg): stored reports, the recovery, the early carried set",
     "The rules a recovery needs, the delta and its merge, and the move's own guards again."),
    ("n", "The third model (SlotMoveMembers): a group with its members",
     "The move's guards as a leader reads them, and the Raft rules the move leans on."),
]

def report(rows, out):
    with open(os.path.join(out, "mutants.md"), "w") as f:
        f.write("# Planted mistakes\n\nMade by `mutate.py` from `mutants.txt`. A mistake is caught when a "
                "property fails on a bound, when a reach goal can no longer be reached, or when the stall "
                "check finds a state the writes cannot finish from. The safety bounds run first without "
                "`Whole` (the check that compares a final copy with the source directly), so a caught "
                "mistake names the end property it breaks.\n")
        for key, title, text in GROUPS:
            part = [r for r in rows if r["id"][0] == key]
            if not part:
                continue
            n = sum(r["caught"] for r in part)
            f.write(f"\n## {title}: {n} of {len(part)} caught\n\n{text}\n\n")
            f.write("| id | rule | the mistake | caught by | runs |\n|---|---|---|---|---|\n")
            for r in part:
                secs = sum(x["secs"] for x in r["runs"])
                f.write(f"| {r['id']} | `{r['rule']}` | {r['note']} | "
                        f"{r['by'] or '**not caught**'} | {len(r['runs'])}, {secs} s |\n")
            print(f"{title}: {n} of {len(part)} caught")

if sys.argv[1:] == ["--report"]:
    out = os.path.join(HERE, "results")
    report(json.load(open(os.path.join(out, "mutants.json"))), out)
else:
    main()
