#!/usr/bin/env python3
"""E-22b: join the real checkers' verdicts with E-22's, per history, and print tables.

  compare.py elle <port-raw.jsonl> <real.jsonl>
      Real Elle 0.2.8 against the Go port (tipocket v1.0.0) on E-22's 1,200 saga histories,
      per cell (variant x mode), at read committed and at serializable, and the anomaly types.
  compare.py elletsv <port-raw.jsonl> <real.jsonl> <portrule.jsonl>
      One line per saga history: the three tools' verdicts (results/elle-verdicts.tsv).
  compare.py elleself <selftest.json> <real-self.jsonl>
      Real Elle on E-22's 8 Elle self-test cases: the expected verdict, the port's, real Elle's.
  compare.py knossos <por specs> <knossos specs>
      Knossos 0.3.16 against Porcupine v1.3.1, per partition, grouped by history file.
  compare.py knsum <por specs> <knossos specs>
      The same join, as one table per group (register workload, known-bad, other checks) and mode.
  A por spec is <por.jsonl>=<hist.jsonl>:<hist.jsonl>:... (the Porcupine lines and the history files
  e22b parts read, in that order); a knossos spec is <knossos.jsonl>=<jobs.jsonl> (Knossos writes
  one line per job, in order). Several specs are joined with commas. The join key is (file, seed,
  partition, a hash of the partition's operations): seeds repeat inside some files (TEST-02 runs
  each seed twice, P-18 three worlds per seed), so (file, seed, partition) alone is not unique.
  compare.py knself <selftest.json> <knossos-self.jsonl>
      Knossos on E-22's 18 Porcupine self-test cases.
"""
import json
import re
import statistics
import sys
from collections import Counter, defaultdict

# Elle 0.2.x names the item-only forms of these cycles; the port (from Elle 0.1.x) does not.
REAL_TO_PORT = {"G-single-item": "G-single", "G-nonadjacent-item": "G-nonadjacent"}


def jl(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("{"):
                out.append(json.loads(line))
    return out


def cell_of(name):
    m = re.match(r"(\w+)-(\w+)-seed(\d+)\.edn", name)
    return m.group(1), m.group(2), int(m.group(3))


def fmt_types(c, n_hist):
    return ", ".join(f"{t} {n_hist[t]}: {c[t]}" for t in sorted(c)) or "none"


def elle(port_path, real_path):
    port = {d["file"]: d for d in jl(port_path)}
    real = {d["file"]: d for d in jl(real_path)}
    errors = [d for d in real.values() if "error" in d]
    cells = defaultdict(list)
    for f, r in real.items():
        if "error" in r:
            continue
        cells[cell_of(f)[:2]].append((f, port.get(f), r))
    order_v = ["saga", "owned", "undo", "nolock"]
    order_m = ["calm", "faults", "shuffle"]
    print(f"# Real Elle 0.2.8 vs the Go port (tipocket v1.0.0): {len(real)} histories read, "
          f"{len(errors)} errors, {sum(1 for f in real if f not in port)} with no port result")
    print()
    print("| variant | mode | histories | read committed valid: port / real | agree | serializable valid: port / real | agree "
          "| G0 histories: port / real | G-single histories: port / real "
          "| same anomaly types | real Elle's anomalies (histories with it: total cases) |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    dis = []
    tot = Counter()
    kinds = Counter()
    for v in order_v:
        for m in order_m:
            rows = cells.get((v, m), [])
            n = len(rows)
            prc = sum(1 for _, p, _ in rows if p and p["readCommittedValid"])
            rrc = sum(1 for _, _, r in rows if r["rc"]["valid"] is True)
            psr = sum(1 for _, p, _ in rows if p and p["serializableValid"])
            rsr = sum(1 for _, _, r in rows if r["sr"]["valid"] is True)
            arc = asr = aty = 0
            tc, th = Counter(), Counter()
            g = Counter()
            for f, p, r in rows:
                for t, c in r["sr"]["counts"].items():
                    tc[t] += c
                    th[t] += 1
                if p is None:
                    dis.append((f, "no port result", "verdict"))
                    continue
                okrc = p["readCommittedValid"] == (r["rc"]["valid"] is True)
                oksr = p["serializableValid"] == (r["sr"]["valid"] is True)
                pt = sorted(p.get("serializableAnomalies") or [])
                rt = sorted({REAL_TO_PORT.get(t, t) for t in r["sr"]["types"]})
                okty = pt == rt
                g.update(pg0="G0" in pt, rg0="G0" in rt, pgs="G-single" in pt, rgs="G-single" in rt)
                # why the types differ, when the verdicts agree: real Elle skips a type implied by a worse one
                # it found (policy), or the two inferred different version orders (heuristic)
                if okrc and oksr and not okty:
                    sp, sr_ = set(pt) - {"G-nonadjacent"}, set(rt) - {"G-nonadjacent"}
                    kinds[("policy" if sp == sr_ and ("G-single" in rt or "G-nonadjacent" in rt) else "order", v)] += 1
                arc += okrc
                asr += oksr
                aty += okty
                if not (okrc and oksr):
                    dis.append((f, f"read committed: port {p['readCommittedValid']}, real {r['rc']['valid']} {r['rc']['types']}; "
                                   f"serializable: port {p['serializableValid']}, real {r['sr']['valid']}; "
                                   f"port {p.get('anomalyCounts')}, real {r['sr']['counts']}", "verdict"))
                elif not okty:
                    dis.append((f, (tuple(pt), tuple(rt)), "types"))
            tot.update(n=n, arc=arc, asr=asr, aty=aty)
            print(f"| {v} | {m} | {n} | {prc} / {rrc} | {arc} | {psr} / {rsr} | {asr} | {g['pg0']} / {g['rg0']} | "
                  f"{g['pgs']} / {g['rgs']} | {aty} | {fmt_types(tc, th)} |")
    print()
    print(f"Total: {tot['n']} histories; read committed verdict agrees on {tot['arc']}, serializable on {tot['asr']}, "
          f"anomaly type set (item names mapped) on {tot['aty']}.")
    print("Same verdicts, different types: " + ", ".join(f"{k} in {v}: {n}" for (k, v), n in sorted(kinds.items()))
          + " (policy: real Elle skips a cycle type implied by a worse one it found; order: the two built different version orders, from never-read appends, duplicates or reads that disagree)")
    ms = [r["ms"] for r in real.values() if "ms" in r]
    if ms:
        print(f"Real Elle time per history (both checks): median {statistics.median(ms)} ms, max {max(ms)} ms, "
              f"total {sum(ms) / 1000:.1f} s.")
    print()
    verdict = [(f, w) for f, w, kind in dis if kind == "verdict"]
    typeonly = Counter(w for f, w, kind in dis if kind == "types")
    print(f"## Histories where a verdict differs ({len(verdict)})")
    for f, why in sorted(verdict):
        print(f"- {f}: {why}")
    print()
    print(f"## Same verdicts, different anomaly types ({sum(typeonly.values())} histories), by pattern")
    print()
    print("| histories | the port's types | real Elle's types (item names mapped) |")
    print("|---|---|---|")
    for w, n in typeonly.most_common():
        pt, rt = w
        print(f"| {n} | {', '.join(pt) or 'none'} | {', '.join(rt) or 'none'} |")
    for d in errors:
        print(f"- ERROR {d['file']}: {d['error']}")


def elletsv(port_path, real_path, portrule_path):
    """One line per history: the port's, real Elle's and real Elle-with-the-port's-rule verdicts."""
    port = {d["file"]: d for d in jl(port_path)}
    real = {d["file"]: d for d in jl(real_path)}
    abl = {d["file"]: d for d in jl(portrule_path)}
    b = lambda x: "valid" if x is True else "no"
    print("# per history: read committed and serializable verdicts of the port (E-22), real Elle 0.2.8, and real Elle "
          "with the port rule; real Elle anomaly types at serializable")
    print("file\trc_port\trc_real\trc_portrule\tsr_port\tsr_real\tsr_portrule\treal_types")
    for f in sorted(real, key=lambda f: (f.split("-seed")[0], int(f.split("seed")[1].split(".")[0]))):
        p, r, a = port[f], real[f], abl[f]
        print("\t".join([f, b(p["readCommittedValid"]), b(r["rc"]["valid"]), b(a["rc"]["valid"]), b(p["serializableValid"]),
                         b(r["sr"]["valid"]), b(a["sr"]["valid"]), ",".join(r["sr"]["types"]) or "-"]))


def elleself(self_path, real_path):
    cases = json.load(open(self_path))["elle"]
    real = {d["file"]: d for d in jl(real_path)}
    print("# Real Elle 0.2.8 on E-22's 8 Elle self-test cases")
    print()
    print("| case | want rc / sr | port rc / sr | real rc / sr | real anomaly types | must-have found by real | agree |")
    print("|---|---|---|---|---|---|---|")
    agree = 0
    for i, c in enumerate(cases):
        r = real.get(f"self-elle-{i}.edn")
        if not r or "error" in r:
            print(f"| {c['name']} | | | ERROR {r and r.get('error')} | | | no |")
            continue
        rrc, rsr = r["rc"]["valid"] is True, r["sr"]["valid"] is True
        types = sorted(set(r["rc"]["types"]) | set(r["sr"]["types"]))
        found = (c["must"] == "") or (c["must"] in {REAL_TO_PORT.get(t, t) for t in types})
        ok = rrc == c["rcWant"] and rsr == c["srWant"] and found
        agree += ok
        print(f"| {c['name']} | {c['rcWant']} / {c['srWant']} | {c['rcGot']} / {c['srGot']} | {rrc} / {rsr} | "
              f"{', '.join(types) or 'none'} | {c['must'] or '-'}: {found} | {'yes' if ok else 'NO'} |")
    print()
    print(f"{agree} of {len(cases)} cases: real Elle gives the expected verdict and finds the named anomaly.")


def fp(ops):
    import hashlib
    return hashlib.sha1(json.dumps(ops, sort_keys=True).encode()).hexdigest()[:16]


def hist_parts(paths):
    for path in paths:
        base = path.rsplit("/", 1)[-1]
        with open(path) as f:
            for line in f:
                d = json.loads(line)
                for i, p in enumerate(d["parts"]):
                    yield base, d["seed"], i, p["ops"]


def joined(por_specs, kn_specs):
    """[(por line, knossos line)] for every partition Knossos checked, and the Porcupine lines."""
    por = defaultdict(list)
    all_por = []
    for spec in por_specs.split(","):
        out, hists = spec.split("=", 1)
        lines = jl(out)
        n = 0
        for d, (f, seed, idx, ops) in zip(lines, hist_parts(hists.split(":"))):
            assert (d["file"], d["seed"], d["idx"]) == (f, seed, idx), (out, d, f, seed, idx)
            por[(f, seed, idx, fp(ops))].append(d)
            all_por.append(d)
            n += 1
        assert n == len(lines), (out, n, len(lines))
    pairs = []
    missing = 0
    for spec in kn_specs.split(","):
        out, jobs = spec.split("=", 1)
        with open(jobs) as jf:
            for k, j in zip(jl(out), (json.loads(x) for x in jf)):
                assert (k["file"], k["seed"], k["idx"]) == (j["file"], j["seed"], j["idx"]), (out, k, j["file"])
                key = (j["file"], j["seed"], j["idx"], fp(j["ops"]))
                if por[key]:
                    pairs.append((por[key].pop(), k))
                else:
                    missing += 1
    return pairs, all_por, missing


def knossos(por_specs, kn_specs):
    pairs, _, missing = joined(por_specs, kn_specs)
    groups = defaultdict(list)
    for p, k in pairs:
        groups[k["file"]].append((p, k))
    print(f"# Knossos 0.3.16 vs Porcupine v1.3.1, per partition ({len(pairs) + missing} partitions checked, {missing} with no Porcupine line)")
    print()
    print("| history file | partitions | ops (max per partition) | both linearizable | both not | Porcupine only not | Knossos only not | Knossos unknown | Knossos ms: median / max / total | Porcupine ms total |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    tot = Counter()
    dis = []
    for f in sorted(groups):
        rows = groups[f]
        c = Counter()
        for p, k in rows:
            a, b = p["por"], k["knossos"]
            if a == "ok" and b == "ok":
                c["ok"] += 1
            elif a == "illegal" and b == "illegal":
                c["bad"] += 1
            elif b in ("unknown", "error"):
                c["unk"] += 1
                dis.append((f, p, k))
            elif a == "illegal" and b == "ok":
                c["por"] += 1
                dis.append((f, p, k))
            elif a == "ok" and b == "illegal":
                c["kn"] += 1
                dis.append((f, p, k))
            else:
                c["other"] += 1
                dis.append((f, p, k))
        ms = [k["ms"] for _, k in rows]
        ops = [k["ops"] for _, k in rows]
        pus = sum(p["us"] for p, _ in rows)
        tot.update(n=len(rows), ops=sum(ops), **c)
        tot["ms"] += sum(ms)
        tot["pus"] += pus
        print(f"| {f} | {len(rows)} | {sum(ops)} ({max(ops)}) | {c['ok']} | {c['bad']} | {c['por']} | {c['kn']} | {c['unk']} | "
              f"{statistics.median(ms):.0f} / {max(ms)} / {sum(ms) / 1000:.1f} s | {pus / 1000:.0f} |")
    print(f"| **total** | {tot['n']} | {tot['ops']} | {tot['ok']} | {tot['bad']} | {tot['por']} | {tot['kn']} | {tot['unk']} | "
          f"total {tot['ms'] / 1000:.1f} s | {tot['pus'] / 1000:.0f} |")
    print()
    print(f"## Disagreements and unknowns ({len(dis)})")
    for f, p, k in dis:
        print(f"- {f} seed {p['seed']} part {p['idx']} ({p['res']}/{p['p']}, {p['ops']} ops): Porcupine {p['por']}, "
              f"Knossos {k['knossos']} {k.get('cause') or ''} {k.get('why') or ''}")


def knself(self_path, kn_path):
    cases = json.load(open(self_path))["lin"]
    kn = {d["idx"]: d for d in jl(kn_path) if d["file"] == "selftest"}
    print("# Knossos 0.3.16 (E-22's partition model, ported) on E-22's 18 Porcupine self-test cases")
    print()
    print("| case | want | Porcupine | Knossos | agree |")
    print("|---|---|---|---|---|")
    agree = 0
    for i, c in enumerate(cases):
        k = kn.get(i, {}).get("knossos", "missing")
        ok = k == c["want"] == c["got"]
        agree += ok
        print(f"| {c['name']} | {c['want']} | {c['got']} | {k} | {'yes' if ok else 'NO'} |")
    print()
    print(f"{agree} of {len(cases)} cases: Knossos, Porcupine and the expected answer agree.")


def knsum(por_specs, kn_specs):
    """One table over every Knossos run: per group and mode, checked partitions against all."""
    pairs, all_por, missing = joined(por_specs, kn_specs)
    checked = {id(p): k for p, k in pairs}

    def group(f, ops):
        if f.startswith("lin-kv-") and "before" not in f:
            return "1 register workload (lin-kv), every partition"
        if f.startswith("mut-") or "before" in f:
            return "2 known-bad: 7 mutant runs, lin-kv before fix G1"
        return "3 every other check, at most 120 ops" if ops <= 120 else "4 every other check, 677 to 902 ops"
    rows = defaultdict(Counter)
    for p in all_por:
        f = p["file"]
        mode = "before G1" if "before" in f else (p.get("mutant") and "mutant " + p["mutant"]) or p["mode"]
        g = (group(f, p["ops"]), mode)
        r = rows[g]
        r["all"] += 1
        r["por_bad"] += p["por"] == "illegal"
        k = checked.get(id(p))
        if k is None:
            continue
        r["checked"] += 1
        r["ops"] += k["ops"]
        r["ms"] += k["ms"]
        a, b = p["por"], k["knossos"]
        r["both_ok"] += a == "ok" and b == "ok"
        r["both_bad"] += a == "illegal" and b == "illegal"
        r["unknown"] += b not in ("ok", "illegal")
        r["differ"] += (a, b) in (("ok", "illegal"), ("illegal", "ok"))
    print("| group | mode | partitions | checked by Knossos | both linearizable | both not | differ | Knossos unknown | Knossos ms per op |")
    print("|---|---|---|---|---|---|---|---|---|")
    tot = Counter()
    for (g, m) in sorted(rows):
        r = rows[(g, m)]
        tot.update(r)
        per = f"{r['ms'] / r['ops']:.1f}" if r["ops"] else "-"
        print(f"| {g[2:]} | {m} | {r['all']} | {r['checked']} | {r['both_ok']} | {r['both_bad']} | {r['differ']} | {r['unknown']} | {per} |")
    print(f"| **all** | | {tot['all']} | {tot['checked']} | {tot['both_ok']} | {tot['both_bad']} | {tot['differ']} | {tot['unknown']} | "
          f"{tot['ms'] / max(tot['ops'], 1):.1f} |")
    print()
    if missing:
        print(f"WARNING: {missing} Knossos lines matched no Porcupine line")
    print(f"Porcupine found {tot['por_bad']} of {tot['all']} partitions not linearizable; Knossos checked {tot['checked']} "
          f"({tot['ops']} operations, {tot['ms'] / 3.6e6:.2f} h of Knossos time).")


if __name__ == "__main__":
    {"elle": elle, "elleself": elleself, "knossos": knossos, "knself": knself, "knsum": knsum, "elletsv": elletsv}[sys.argv[1]](*sys.argv[2:])
