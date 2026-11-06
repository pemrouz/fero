#!/usr/bin/env python3
"""E-22b: join the real checkers' verdicts with E-22's, per history, and print tables.

  compare.py elle <port-raw.jsonl> <real.jsonl>
      Real Elle 0.2.8 against the Go port (tipocket v1.0.0) on E-22's 1,200 saga histories,
      per cell (variant x mode), at read committed and at serializable, and the anomaly types.
  compare.py elleself <selftest.json> <real-self.jsonl>
      Real Elle on E-22's 8 Elle self-test cases: the expected verdict, the port's, real Elle's.
  compare.py knossos <por-parts.jsonl> <knossos.jsonl>
      Knossos 0.3.16 against Porcupine v1.3.1, per partition, grouped by history file.
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
          "| same anomaly types | real Elle's anomalies (histories with it: total cases) |")
    print("|---|---|---|---|---|---|---|---|---|")
    dis = []
    tot = Counter()
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
            for f, p, r in rows:
                for t, c in r["sr"]["counts"].items():
                    tc[t] += c
                    th[t] += 1
                if p is None:
                    dis.append((f, "no port result"))
                    continue
                okrc = p["readCommittedValid"] == (r["rc"]["valid"] is True)
                oksr = p["serializableValid"] == (r["sr"]["valid"] is True)
                pt = sorted(p.get("serializableAnomalies") or [])
                rt = sorted({REAL_TO_PORT.get(t, t) for t in r["sr"]["types"]})
                okty = pt == rt
                arc += okrc
                asr += oksr
                aty += okty
                if not (okrc and oksr and okty):
                    dis.append((f, f"rc port {p['readCommittedValid']} real {r['rc']['valid']} {r['rc']['types']}; "
                                   f"sr port {p['serializableValid']} real {r['sr']['valid']}; "
                                   f"types port {pt} real {r['sr']['types']}; port counts {p.get('anomalyCounts')} "
                                   f"real counts {r['sr']['counts']}"))
            tot.update(n=n, arc=arc, asr=asr, aty=aty)
            print(f"| {v} | {m} | {n} | {prc} / {rrc} | {arc} | {psr} / {rsr} | {asr} | {aty} | {fmt_types(tc, th)} |")
    print()
    print(f"Total: {tot['n']} histories; read committed verdict agrees on {tot['arc']}, serializable on {tot['asr']}, "
          f"anomaly type set (item names mapped) on {tot['aty']}.")
    ms = [r["ms"] for r in real.values() if "ms" in r]
    if ms:
        print(f"Real Elle time per history (both checks): median {statistics.median(ms)} ms, max {max(ms)} ms, "
              f"total {sum(ms) / 1000:.1f} s.")
    print()
    print(f"## Disagreements ({len(dis)})")
    for f, why in sorted(dis):
        print(f"- {f}: {why}")
    for d in errors:
        print(f"- ERROR {d['file']}: {d['error']}")


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


def knossos(por_path, kn_path):
    por = {(d["file"], d["seed"], d["idx"]): d for d in jl(por_path)}
    kn = jl(kn_path)
    groups = defaultdict(list)
    missing = 0
    for k in kn:
        p = por.get((k["file"], k["seed"], k["idx"]))
        if p is None:
            missing += 1
            continue
        groups[k["file"]].append((p, k))
    print(f"# Knossos 0.3.16 vs Porcupine v1.3.1, per partition ({len(kn)} partitions checked, {missing} with no Porcupine line)")
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


if __name__ == "__main__":
    {"elle": elle, "elleself": elleself, "knossos": knossos, "knself": knself}[sys.argv[1]](*sys.argv[2:])
