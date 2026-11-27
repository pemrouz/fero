#!/usr/bin/env python3
"""Plant each mistake of decided-mutants.txt in the decided form and run TLC.

The decided form is the move as the owner decided it on card 0002: one commit
in the window (OneCommit = TRUE) and the source's reopen not waiting for the
row (BackFirst = FALSE).  Its bounds are named d-*, msg-d-* and mem-d-*.

A line of decided-mutants.txt either names an id of mutants.txt or of
extra-mutants.txt, and that mistake is planted as it stands there, or it
holds a new mistake with its module and its mark.

A mistake is caught as in mutate.py: a safety property fails on a bound (in
the first model first without the check `Whole`), the model stops with an
error, a reach goal can no longer be reached, or the stall check finds a
state the writes cannot finish from.

Environment: TLA_JAR, WORK, HEAVY, WORKERS, LIMIT, as for mutate.py.
Usage: decided.py [id ...]   writes results/decided-mutants.json and .md
       decided.py --report   writes the .md again from the .json
"""
import fcntl, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.environ.get("WORK", "./target/work"))
JAR = os.environ.get("TLA_JAR", "tla2tools.jar")
HEAVY = os.environ.get("HEAVY", "").split()
LIMIT = int(os.environ.get("LIMIT", "3600"))
WORKERS = os.environ.get("WORKERS", "2")
OUT = os.path.join(HERE, "results")
JSON = os.path.join(OUT, "decided-mutants.json")

# For each model: the quick safety bounds, the reach bounds, the stall bounds
# and the slower safety bounds (run last), all in the decided form.
PLAN = {
    "SlotMove": dict(
        safe=["d-core", "d-crash", "d-bulk", "d-twice", "d-lock", "d-ver", "d-ver2", "d-lazy", "d-down"],
        reach=["d-r-moved", "d-r-back", "d-r-twice"],
        stall=["d-s-lazy", "d-s-twice"], slow=[]),
    "SlotMoveMsg": dict(
        safe=["msg-d-core", "msg-d-early", "msg-d-crash", "msg-d-rec", "msg-d-rec-early",
              "msg-d-rec-crash", "msg-d-rec-down", "msg-d-rec-twice"],
        reach=["msg-d-r-early", "msg-d-r-lostback", "msg-d-r-reopen", "msg-d-r-oldreport",
               "msg-d-r-aftersrc", "msg-d-r-afterdst", "msg-d-r-twice"],
        stall=[], slow=["msg-d-rec-three", "msg-d-rec2"]),
    "SlotMoveMembers": dict(
        safe=["mem-d-src-core", "mem-d-dst-core", "mem-d-dst-grow", "mem-d-dst-shrink"],
        reach=["mem-d-src-r", "mem-d-dst-r", "mem-d-r-back"],
        stall=[], slow=["mem-d-dst-fault", "mem-d-src-fault", "mem-d-src-cfg"]),
}
MARK = re.compile(r"\\\* @(?:rule|keeps|world) (.*)$")


def split(line):
    return [x.strip() for x in line.rstrip("\n").split(" ; ")]


def rows_of(name):
    for line in open(os.path.join(HERE, name)):
        if line.strip() and not line.startswith("#"):
            yield split(line)


def mistakes():
    """Every mistake of decided-mutants.txt, as (id, record, module, mark, old, new, note)."""
    first = {r[0]: r for r in rows_of("mutants.txt")}
    extra = {r[0]: r for r in rows_of("extra-mutants.txt")}
    for r in rows_of("decided-mutants.txt"):
        if len(r) == 2:
            mid, record = r
            if mid in first:
                _, mark, old, new, note = first[mid]
                module = {"u": "SlotMoveMsg", "n": "SlotMoveMembers"}.get(mid[0], "SlotMove")
                yield mid, record, module, mark, old, new, note
            elif mid in extra:
                _, module, old, new, note = extra[mid]
                yield mid, record, module, "-", old, new, note
            else:
                raise SystemExit(f"{mid}: not in mutants.txt or extra-mutants.txt")
        else:
            yield tuple(r)


def plant(module, mark, old, new, folder):
    text = open(os.path.join(HERE, module + ".tla")).read()
    old, new = old.replace("\\n", "\n"), new.replace("\\n", "\n")
    if mark == "-":
        if text.count(old) != 1:
            raise SystemExit(f"{old!r}: occurs {text.count(old)} times in {module}, not once")
        text = text.replace(old, new)
    else:
        lines = text.split("\n")
        hits = [i for i, l in enumerate(lines)
                if MARK.search(l) and MARK.search(l).group(1).strip() == mark and old in l]
        if len(hits) != 1:
            raise SystemExit(f"{mark}: the old text matches {len(hits)} marked lines, not 1")
        lines[hits[0]] = lines[hits[0]].replace(old, new, 1)
        text = "\n".join(lines)
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, module + ".tla"), "w").write(text)
    if module == "SlotMove":
        shutil.copy(os.path.join(HERE, "SlotMoveStall.tla"), folder)
    for f in os.listdir(HERE):
        if f.endswith(".cfg"):
            shutil.copy(os.path.join(HERE, f), folder)


def java(folder, args, name):
    cmd = HEAVY + ["java", "-Xmx2g", "-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC",
                   "-noGenerateSpecTE"] + args
    t0 = time.time()
    with open(os.path.join(folder, name + ".out"), "w") as f:
        p = subprocess.Popen(cmd, cwd=folder, stdout=f, stderr=subprocess.STDOUT,
                             start_new_session=True)
        try:
            p.wait(timeout=LIMIT); late = False
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9); p.wait(); late = True
    return open(os.path.join(folder, name + ".out")).read(), late, round(time.time() - t0)


def tlc(folder, cfg, whole, module):
    name = cfg + ("" if whole else "-nw")
    text = open(os.path.join(HERE, cfg + ".cfg")).read()
    if not whole:
        text = text.replace(" Whole", "")
    open(os.path.join(folder, name + ".cfg"), "w").write(text)
    meta = os.path.join(folder, "meta-" + name)
    out, late, secs = java(folder, ["-workers", WORKERS, "-metadir", meta,
                                    "-config", name + ".cfg", module + ".tla"], name)
    shutil.rmtree(meta, ignore_errors=True)
    if "No error has been found" in out: verdict = "pass"
    elif "is violated" in out: verdict = "violated"
    elif late: verdict = "timeout"
    else: verdict = "error"
    if verdict == "error" and "states generated" not in out:
        raise SystemExit(f"{cfg}: the planted text does not parse or the run did not start")
    m = re.search(r"Invariant (\w+) is violated", out)
    d = re.search(r"(\d+) distinct states found", out)
    return dict(bound=cfg + ("" if whole else " (no Whole)"), verdict=verdict,
                inv=m.group(1) if m else None, steps=len(re.findall(r"^State \d+:", out, re.M)),
                distinct=int(d.group(1)) if d else None, secs=secs)


def stall(folder, cfg):
    meta = os.path.join(folder, "meta-" + cfg)
    dot = os.path.join(folder, cfg + ".dot")
    out, late, secs = java(folder, ["-workers", "1", "-metadir", meta, "-dump", "dot,actionlabels", dot,
                                    "-config", cfg + ".cfg", "SlotMoveStall.tla"], cfg)
    shutil.rmtree(meta, ignore_errors=True)
    if late or not os.path.exists(dot) or "Error" in out:
        return dict(bound=cfg, verdict="timeout" if late else "error", secs=secs)
    r = subprocess.run([sys.executable, os.path.join(HERE, "stall.py"), dot],
                       capture_output=True, text=True).stdout
    os.remove(dot)
    found = [l.rsplit(": ", 1)[0] for l in r.split("\n")
             if "stuck of" in l and not l.rsplit(": ", 1)[1].startswith("0 ")]
    way = [l.split(":", 1)[1].strip() for l in r.split("\n") if "shortest way in" in l]
    return dict(bound=cfg, verdict="stall" if "stall: FOUND" in r else "pass",
                what="; ".join(found), way=way[0] if way else None, secs=secs)


def one(mid, record, module, mark, old, new, note):
    folder = os.path.join(WORK, "decided", mid)
    shutil.rmtree(folder, ignore_errors=True)
    plant(module, mark, old, new, folder)
    plan = PLAN[module]
    row = dict(id=mid, record=record, module=module, mark=mark, note=note,
               caught=False, by=None, runs=[])
    first = module == "SlotMove"

    def safety(bounds, whole):
        for cfg in ([] if row["caught"] else bounds):
            r = tlc(folder, cfg, whole, module)
            row["runs"].append(r)
            if r["verdict"] == "violated":
                where = f"{r['steps']} steps" if r["steps"] else "the first state"
                row.update(caught=True, by=f"{r['inv']} on {cfg}, {where}")
                break
            elif r["verdict"] == "error":
                row.update(caught=True, by=f"the model stops with an error on {cfg}")
                break
            elif r["verdict"] == "timeout":
                row["late"] = row.get("late", []) + [cfg]

    safety(plan["safe"], not first)
    for cfg in ([] if row["caught"] else plan["reach"]):
        r = tlc(folder, cfg, True, module)
        row["runs"].append(r)
        if r["verdict"] == "pass":
            row.update(caught=True, by=f"the goal cannot be reached on {cfg}")
            break
    for cfg in ([] if row["caught"] else plan["stall"]):
        r = stall(folder, cfg)
        row["runs"].append(r)
        if r["verdict"] == "stall":
            row.update(caught=True, by=f"the stall check on {cfg} ({r['what']})")
            break
    safety(plan["slow"], True)
    if first:
        safety(plan["safe"], True)
    shutil.rmtree(folder, ignore_errors=True)
    return row


def save(row):
    """Merge one row into the json under a lock, so two runners can share it."""
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(WORK, "decided-mutants.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        rows = {r["id"]: r for r in json.load(open(JSON))} if os.path.exists(JSON) else {}
        rows[row["id"]] = row
        json.dump([rows[k] for k in sorted(rows)], open(JSON, "w"), indent=1)


ORDER = ["slot-table.8", "slot-table.9", "slot-table.10", "slot-table.11", "slot-move.24",
         "slot-move.23", "move-policy.7", "slot-table.5", "slot-move.19", "slot-table.1",
         "slot-move.3", "slot-move.7", "slot-move.4", "stream-numbers.4", "slot-move.13", "none"]


def report():
    rows = json.load(open(JSON))
    order = [m[0] for m in mistakes()]
    rows.sort(key=lambda r: (ORDER.index(r["record"]) if r["record"] in ORDER else 99,
                             order.index(r["id"]) if r["id"] in order else 999))
    with open(os.path.join(OUT, "decided-mutants.md"), "w") as f:
        f.write("# Planted mistakes in the decided form\n\nMade by `decided.py` from `decided-mutants.txt`, "
                "on the decided form's bounds (OneCommit = TRUE, BackFirst = FALSE). A mistake is caught "
                "when a property fails on a bound, when the model stops with an error, when a reach goal can "
                "no longer be reached, or when the stall check finds a state the writes cannot finish from. "
                "In the first model the safety bounds run first without `Whole`.\n\n"
                "| record | id | model | the mistake | caught by | runs |\n|---|---|---|---|---|---|\n")
        for r in rows:
            by = r["by"] if r["caught"] else "**not caught**"
            note = r["note"]
            if r["id"][0] in "efg" and note.startswith("probe: "):
                note = note[len("probe: "):] + " (a probe of the second reading)"
            f.write(f"| `{r['record']}` | {r['id']} | {r['module']} | {note} | {by} | "
                    f"{len(r['runs'])}, {sum(x['secs'] for x in r['runs'])} s |\n")


def main():
    want = set(sys.argv[1:])
    for m in mistakes():
        if want and m[0] not in want:
            continue
        row = one(*m)
        save(row)
        print(m[0], m[1], "CAUGHT" if row["caught"] else "not caught", row["by"] or "", flush=True)
    report()


if sys.argv[1:] == ["--report"]:
    report()
else:
    main()
