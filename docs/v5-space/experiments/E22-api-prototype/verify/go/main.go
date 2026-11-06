// e22check — the outside checkers for E-22 step 3 (TEST-13).
//
//   e22check lin <hist.jsonl> [-timeout 20s] [-viz dir]   Porcupine v1.3.1 on every partition of every seed
//   e22check elle <hist.edn> [<hist.edn> ...]              Elle's list-append checker (the Go port in
//                                                          pingcap/tipocket v1.0.0, pkg/elle) on each file
//   e22check selftest                                      both checkers on known-bad and known-good histories
//
// Output: one JSON object per input file on stdout.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/anishathalye/porcupine"
	"github.com/pingcap/tipocket/pkg/elle/core"
	listappend "github.com/pingcap/tipocket/pkg/elle/list_append"
	"github.com/pingcap/tipocket/pkg/elle/txn"
)

type Part struct {
	Res  string `json:"res"`
	P    string `json:"p"`
	Vals bool   `json:"vals"`
	Ops  []HOp  `json:"ops"`
}
type SeedLine struct {
	Check  string  `json:"check"`
	Mode   string  `json:"mode"`
	Mutant *string `json:"mutant"`
	Seed   int     `json:"seed"`
	Parts  []Part  `json:"parts"`
}

func toOps(p Part) []porcupine.Operation {
	ops := make([]porcupine.Operation, 0, len(p.Ops))
	for i, o := range p.Ops {
		ops = append(ops, porcupine.Operation{ClientId: i, Input: Input{Kind: o.Kind, In: o.In, Vals: p.Vals}, Call: int64(o.C * 1e6), Output: o.Out, Return: int64(o.R * 1e6)})
	}
	return ops
}

type LinSummary struct {
	File       string         `json:"file"`
	Check      string         `json:"check"`
	Mode       string         `json:"mode"`
	Mutant     string         `json:"mutant,omitempty"`
	Seeds      int            `json:"seeds"`
	Parts      int            `json:"parts"`
	Ops        int            `json:"ops"`
	OpsByKind  map[string]int `json:"opsByKind"`
	Ok         int            `json:"ok"`
	Illegal    int            `json:"illegal"`
	Unknown    int            `json:"unknown"`
	BadSeeds   []int          `json:"badSeeds"`
	Examples   []string       `json:"examples"`
	MaxPartOps int            `json:"maxPartOps"`
	Ms         int64          `json:"ms"`
}

func lin(path string, timeout time.Duration, viz string) LinSummary {
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer f.Close()
	sum := LinSummary{File: filepath.Base(path), OpsByKind: map[string]int{}, BadSeeds: []int{}, Examples: []string{}}
	t0 := time.Now()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<30)
	model := Model.ToModel()
	bad := map[int]bool{}
	for sc.Scan() {
		var line SeedLine
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			fmt.Fprintln(os.Stderr, "bad line:", err)
			os.Exit(2)
		}
		sum.Check, sum.Mode = line.Check, line.Mode
		if line.Mutant != nil {
			sum.Mutant = *line.Mutant
		}
		sum.Seeds++
		for _, p := range line.Parts {
			sum.Parts++
			sum.Ops += len(p.Ops)
			if len(p.Ops) > sum.MaxPartOps {
				sum.MaxPartOps = len(p.Ops)
			}
			for _, o := range p.Ops {
				sum.OpsByKind[o.Kind]++
			}
			res, info := porcupine.CheckOperationsVerbose(model, toOps(p), timeout)
			switch res {
			case porcupine.Ok:
				sum.Ok++
			case porcupine.Illegal:
				sum.Illegal++
				if !bad[line.Seed] {
					bad[line.Seed] = true
					sum.BadSeeds = append(sum.BadSeeds, line.Seed)
				}
				if len(sum.Examples) < 4 {
					sum.Examples = append(sum.Examples, fmt.Sprintf("seed %d %s/%s: %d ops not linearizable", line.Seed, p.Res, p.P, len(p.Ops)))
					if viz != "" {
						_ = os.MkdirAll(viz, 0o755)
						_ = porcupine.VisualizePath(model, info, filepath.Join(viz, fmt.Sprintf("%s-%s-seed%d-%s.html", strings.TrimSuffix(line.Check, ".check.ts"), line.Mode, line.Seed, sanitize(p.Res+"_"+p.P))))
					}
				}
			default:
				sum.Unknown++
			}
		}
	}
	sort.Ints(sum.BadSeeds)
	sum.Ms = time.Since(t0).Milliseconds()
	return sum
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '#' || r == ' ' || r == ':' {
			return '_'
		}
		return r
	}, s)
}

// ── Elle ──────────────────────────────────────────────────────────────────────────────────────
type ElleSummary struct {
	File           string         `json:"file"`
	Ops            int            `json:"ops"`
	ReadCommitted  bool           `json:"readCommittedValid"`
	Serializable   bool           `json:"serializableValid"`
	AnomalyCounts  map[string]int `json:"anomalyCounts"`
	SerializableNo []string       `json:"serializableAnomalies"`
	Example        string         `json:"example,omitempty"`
}

func elleCheck(name string, h core.History) ElleSummary {
	s := ElleSummary{File: name, Ops: len(h), AnomalyCounts: map[string]int{}}
	rc := listappend.Check(txn.Opts{ConsistencyModels: []core.ConsistencyModelName{"read-committed"}}, cloneHistory(h))
	s.ReadCommitted = rc.Valid && !rc.IsUnknown
	sr := listappend.Check(txn.Opts{ConsistencyModels: []core.ConsistencyModelName{"serializable"}}, cloneHistory(h))
	s.Serializable = sr.Valid && !sr.IsUnknown
	for _, k := range sr.AnomalyTypes {
		s.SerializableNo = append(s.SerializableNo, k)
		s.AnomalyCounts[k] = len(sr.Anomalies[k])
		if s.Example == "" && len(sr.Anomalies[k]) > 0 {
			b, _ := json.Marshal(sr.Anomalies[k][0])
			ex := string(b)
			if len(ex) > 600 {
				ex = ex[:600] + "..."
			}
			s.Example = k + ": " + ex
		}
	}
	sort.Strings(s.SerializableNo)
	return s
}
func cloneHistory(h core.History) core.History {
	out := make(core.History, len(h))
	for i, op := range h {
		out[i] = op.Copy()
	}
	return out
}
func elleFile(path string) ElleSummary {
	b, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	h, err := core.ParseHistory(string(b))
	if err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(2)
	}
	return elleCheck(filepath.Base(path), h)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: e22check lin|elle|selftest ...")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "lin":
		fs := flag.NewFlagSet("lin", flag.ExitOnError)
		timeout := fs.Duration("timeout", 20*time.Second, "per partition")
		viz := fs.String("viz", "", "write a Porcupine visualization of the first failures here")
		_ = fs.Parse(os.Args[2:])
		for _, p := range fs.Args() {
			b, _ := json.Marshal(lin(p, *timeout, *viz))
			fmt.Println(string(b))
		}
	case "elle":
		for _, p := range os.Args[2:] {
			b, _ := json.Marshal(elleFile(p))
			fmt.Println(string(b))
		}
	case "selftest":
		if !selftest() {
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
}
