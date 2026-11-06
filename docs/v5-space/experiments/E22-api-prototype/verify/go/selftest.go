// selftest.go — both checkers on small histories whose answer is known, so a pass on the
// prototype's histories means something. Each known-bad case is a bug class the prototype could
// have: a stale read, a lost acknowledged write, an op applied twice, a version given twice or out
// of real-time order, a wrong refusal; for Elle: G0, G1a, G1c, G-single, G2-item, a list that
// loses elements, a duplicate.
package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/anishathalye/porcupine"
	"github.com/pingcap/tipocket/pkg/elle/core"
)

func v(i int) string { return fmt.Sprintf("0000:%012x", i) }
func bp(b bool) *bool  { return &b }
func set(c, r float64, key string, val interface{}, ver string, cond *Cond) HOp {
	return HOp{C: c, R: r, Kind: "w", In: In{Ws: []WIn{{K: []interface{}{key}, V: val, If: cond}}}, Out: Out{Ok: bp(true), V: ver}}
}
func incr(c, r float64, key string, n float64, min *float64, ans float64, ver string) HOp {
	return HOp{C: c, R: r, Kind: "w", In: In{Ws: []WIn{{K: []interface{}{key}, Op: &OpSpec{Op: "incr", N: &n, Min: min}}}}, Out: Out{Ok: bp(true), V: ver, Ans: ans, HasAns: true}}
}
func read(c, r float64, key string, ver string, val interface{}) HOp {
	return HOp{C: c, R: r, Kind: "r", In: In{K: []interface{}{key}}, Out: Out{V: ver, Has: val != nil, Val: val}}
}
func refuse(c, r float64, key string, code string, cond *Cond, op *OpSpec) HOp {
	return HOp{C: c, R: r, Kind: "w", In: In{Ws: []WIn{{K: []interface{}{key}, If: cond, Op: op}}}, Out: Out{Ok: bp(false), Code: code}}
}
func f(x float64) *float64 { return &x }
func vp(s string) *string  { return &s }

type linCase struct {
	name string
	ops  []HOp
	want porcupine.CheckResult
}

func linCases() []linCase {
	// round-trip through JSON, as the real histories are read
	rt := func(ops []HOp) []HOp {
		b, _ := json.Marshal(ops)
		var out []HOp
		_ = json.Unmarshal(b, &out)
		return out
	}
	cs := []linCase{
		{"good: two overlapping writes, a later read sees the second by version", []HOp{set(0, 5, "x", 1.0, v(1), nil), set(1, 6, "x", 2.0, v(2), nil), read(7, 8, "x", v(2), 2.0)}, porcupine.Ok},
		{"good: a read overlapping a write may see the old value", []HOp{set(0, 1, "x", 1.0, v(1), nil), set(2, 6, "x", 2.0, v(2), nil), read(3, 4, "x", v(1), 1.0)}, porcupine.Ok},
		{"bad: a stale read after a newer write was acknowledged", []HOp{set(0, 1, "x", 1.0, v(1), nil), set(2, 3, "x", 2.0, v(2), nil), read(4, 5, "x", v(1), 1.0)}, porcupine.Illegal},
		{"bad: an acknowledged write lost (a later read finds no row)", []HOp{set(0, 1, "x", 1.0, v(1), nil), read(2, 3, "x", "", nil)}, porcupine.Illegal},
		{"bad: a read with the right version but another value", []HOp{set(0, 1, "x", 1.0, v(1), nil), read(2, 3, "x", v(1), 9.0)}, porcupine.Illegal},
		{"bad: one incr applied twice (answers 1 then 3)", []HOp{incr(0, 1, "c", 1, nil, 1, v(1)), incr(2, 3, "c", 1, nil, 3, v(3))}, porcupine.Illegal},
		{"good: two concurrent incrs answer 1 and 2 in either order", []HOp{incr(0, 3, "c", 1, nil, 2, v(2)), incr(1, 2, "c", 1, nil, 1, v(1))}, porcupine.Ok},
		{"bad: one version given to two writes", []HOp{set(0, 1, "x", 1.0, v(1), nil), set(2, 3, "x", 2.0, v(1), nil)}, porcupine.Illegal},
		{"bad: versions out of real-time order", []HOp{set(0, 1, "x", 1.0, v(2), nil), set(2, 3, "x", 2.0, v(1), nil)}, porcupine.Illegal},
		{"bad: an if-version write refused although the version matched", []HOp{set(0, 1, "x", 1.0, v(1), nil), refuse(2, 3, "x", "conflict", &Cond{Version: vp(v(1))}, nil)}, porcupine.Illegal},
		{"good: an if-version write refused after another write moved the version", []HOp{set(0, 1, "x", 1.0, v(1), nil), set(2, 3, "x", 2.0, v(2), nil), refuse(4, 5, "x", "conflict", &Cond{Version: vp(v(1))}, nil)}, porcupine.Ok},
		{"bad: an if-version write passed on a stale version", []HOp{set(0, 1, "x", 1.0, v(1), nil), set(2, 3, "x", 2.0, v(2), nil), set(4, 5, "x", 3.0, v(3), &Cond{Version: vp(v(1))})}, porcupine.Illegal},
		{"bad: incr below min 0 acknowledged (stock 0 sold)", []HOp{set(0, 1, "s", 0.0, v(1), nil), incr(2, 3, "s", -1, f(0), -1, v(2))}, porcupine.Illegal},
		{"good: incr below min 0 refused", []HOp{set(0, 1, "s", 0.0, v(1), nil), refuse(2, 3, "s", "conflict", nil, &OpSpec{Op: "incr", N: f(-1), Min: f(0)})}, porcupine.Ok},
		{"bad: incr refused though the bound held", []HOp{set(0, 1, "s", 5.0, v(1), nil), refuse(2, 3, "s", "conflict", nil, &OpSpec{Op: "incr", N: f(-1), Min: f(0)})}, porcupine.Illegal},
		{"bad: if-absent write passed on a row that exists", []HOp{set(0, 1, "x", 1.0, v(1), nil), set(2, 3, "x", 2.0, v(2), &Cond{Absent: true})}, porcupine.Illegal},
		{"good: a writer-made ttl removal, then a read finds no row", []HOp{set(0, 1, "x", 1.0, v(1), nil), {C: 10, R: 11, Kind: "e", In: In{Recs: []Rec{{T: 2, K: []interface{}{"x"}}}}, Out: Out{V: v(2)}}, read(12, 13, "x", "", nil)}, porcupine.Ok},
		{"good: a write whose client died, found in the log, seen by a later read", []HOp{{C: 0, R: 1e12, Kind: "e", In: In{Recs: []Rec{{T: 0, K: []interface{}{"x"}, V: 7.0}}}, Out: Out{V: v(1)}}, read(5, 6, "x", v(1), 7.0)}, porcupine.Ok},
	}
	for i := range cs {
		cs[i].ops = rt(cs[i].ops)
	}
	return cs
}

type elleCase struct {
	name    string
	edn     string
	rcValid bool   // read committed (no G0, G1a, G1b, G1c)
	srValid bool   // serializable
	must    string // an anomaly that must be reported ("" = none)
}

func elleCases() []elleCase {
	return []elleCase{
		{"good: serial appends and reads", `{:type :ok, :value [[:append x 1]]}
{:type :ok, :value [[:r x [1]] [:append x 2]]}
{:type :ok, :value [[:r x [1 2]]]}`, true, true, ""},
		{"bad G0: two units write x and y in opposite orders", `{:type :ok, :value [[:append x 1] [:append y 1]]}
{:type :ok, :value [[:append x 2] [:append y 2]]}
{:type :ok, :value [[:r x [1 2]] [:r y [2 1]]]}`, false, false, "G0"},
		{"bad G1c: each unit reads the other's append", `{:type :ok, :value [[:append x 1] [:r y [1]]]}
{:type :ok, :value [[:append y 1] [:r x [1]]]}`, false, false, "G1c"},
		{"bad G1a: a read sees a failed unit's append", `{:type :fail, :value [[:append x 1]]}
{:type :ok, :value [[:r x [1]]]}`, false, false, "G1a"},
		{"bad G-single: a fractured read (half a unit)", `{:type :ok, :value [[:append x 1] [:append y 1]]}
{:type :ok, :value [[:r x [1]] [:r y nil]]}
{:type :ok, :value [[:r x [1]] [:r y [1]]]}`, true, false, "G-single"},
		{"bad G2-item: write skew", `{:type :ok, :value [[:r x nil] [:append y 1]]}
{:type :ok, :value [[:r y nil] [:append x 1]]}
{:type :ok, :value [[:r x [1]] [:r y [1]]]}`, true, false, "G2-item"},
		{"bad: a list that loses an element (incompatible order)", `{:type :ok, :value [[:append x 1]]}
{:type :ok, :value [[:append x 2]]}
{:type :ok, :value [[:r x [1 2]]]}
{:type :ok, :value [[:r x [2]]]}`, false, false, "incompatible-order"},
		{"bad: an element appended once, read twice", `{:type :ok, :value [[:append x 1]]}
{:type :ok, :value [[:r x [1 1]]]}`, false, false, "duplicate-elements"},
	}
}

func selftest() bool {
	all := true
	model := Model.ToModel()
	fmt.Println("# Porcupine v1.3.1 on known histories (the fero partition model)")
	for _, c := range linCases() {
		p := Part{Res: "t", P: "p", Vals: true, Ops: c.ops}
		got := porcupine.CheckOperationsTimeout(model, toOps(p), 10*time.Second)
		ok := got == c.want
		all = all && ok
		fmt.Printf("%s  want %-7s got %-7s  %s\n", mark(ok), c.want, got, c.name)
	}
	fmt.Println("# Elle list-append (tipocket v1.0.0 Go port) on known histories")
	for _, c := range elleCases() {
		h, err := core.ParseHistory(c.edn)
		if err != nil {
			fmt.Println("parse error:", err)
			return false
		}
		s := elleCheck(c.name, h)
		found := c.must == ""
		if c.must != "" {
			_, found = s.AnomalyCounts[c.must]
		}
		ok := s.ReadCommitted == c.rcValid && s.Serializable == c.srValid && found
		all = all && ok
		fmt.Printf("%s  read-committed %-5v serializable %-5v anomalies %v  %s\n", mark(ok), s.ReadCommitted, s.Serializable, s.SerializableNo, c.name)
	}
	if all {
		fmt.Println("ok selftest: every known-bad history is flagged and every known-good one passes")
	} else {
		fmt.Println("FAILED selftest")
	}
	return all
}
func mark(ok bool) string {
	if ok {
		return "ok  "
	}
	return "FAIL"
}
