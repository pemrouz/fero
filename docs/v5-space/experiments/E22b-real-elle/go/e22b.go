// e22b.go — E-22b's extra commands for E-22's Go checker. It is built in a copy of E-22's build
// folder ($SP/e22v/go-build: main.go, model.go, selftest.go, unchanged and checked with cmp), so
// Porcupine runs on exactly E-22's model and the self-test cases are exactly E-22's.
//
//   e22b dumpself <out.json>              E-22's 18 Porcupine and 8 Elle self-test cases, as JSON,
//                                         with Porcupine's and the Go port's verdict on each
//   e22b parts <out.jsonl> <hist.jsonl>…  Porcupine (20 s per partition, as E-22) on every partition,
//                                         one line per partition (E-22 kept only per-file totals)
//
// An init() takes these two commands before E-22's main() sees the arguments.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/anishathalye/porcupine"
	"github.com/pingcap/tipocket/pkg/elle/core"
)

type selfLin struct {
	Name string `json:"name"`
	Want string `json:"want"`
	Got  string `json:"got"`
	Ops  []HOp  `json:"ops"`
}
type selfElle struct {
	Name    string   `json:"name"`
	EDN     string   `json:"edn"`
	RCWant  bool     `json:"rcWant"`
	SRWant  bool     `json:"srWant"`
	Must    string   `json:"must"`
	RCGot   bool     `json:"rcGot"`
	SRGot   bool     `json:"srGot"`
	TypesGo []string `json:"typesGo"`
}

func resName(r porcupine.CheckResult) string {
	switch r {
	case porcupine.Ok:
		return "ok"
	case porcupine.Illegal:
		return "illegal"
	}
	return "unknown"
}

func dumpSelf(out string) {
	model := Model.ToModel()
	var d struct {
		Lin  []selfLin  `json:"lin"`
		Elle []selfElle `json:"elle"`
	}
	for _, c := range linCases() {
		p := Part{Res: "t", P: "p", Vals: true, Ops: c.ops}
		got := porcupine.CheckOperationsTimeout(model, toOps(p), 10*time.Second)
		d.Lin = append(d.Lin, selfLin{c.name, resName(c.want), resName(got), c.ops})
	}
	for _, c := range elleCases() {
		h, err := core.ParseHistory(c.edn)
		if err != nil {
			panic(err)
		}
		s := elleCheck(c.name, h)
		d.Elle = append(d.Elle, selfElle{c.name, c.edn, c.rcValid, c.srValid, c.must, s.ReadCommitted, s.Serializable, s.SerializableNo})
	}
	b, _ := json.MarshalIndent(d, "", " ")
	if err := os.WriteFile(out, b, 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("wrote %d Porcupine and %d Elle self-test cases to %s\n", len(d.Lin), len(d.Elle), out)
}

type partLine struct {
	File   string `json:"file"`
	Check  string `json:"check"`
	Mode   string `json:"mode"`
	Mutant string `json:"mutant,omitempty"`
	Seed   int    `json:"seed"`
	Idx    int    `json:"idx"`
	Res    string `json:"res"`
	P      string `json:"p"`
	Ops    int    `json:"ops"`
	Por    string `json:"por"`
	Us     int64  `json:"us"`
}

func parts(out string, files []string) {
	w, err := os.Create(out)
	if err != nil {
		panic(err)
	}
	defer w.Close()
	bw := bufio.NewWriter(w)
	defer bw.Flush()
	model := Model.ToModel()
	for _, path := range files {
		f, err := os.Open(path)
		if err != nil {
			panic(err)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<30)
		for sc.Scan() {
			var line SeedLine
			if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
				panic(err)
			}
			mut := ""
			if line.Mutant != nil {
				mut = *line.Mutant
			}
			for i, p := range line.Parts {
				t0 := time.Now()
				res := porcupine.CheckOperationsTimeout(model, toOps(p), 20*time.Second)
				b, _ := json.Marshal(partLine{filepath.Base(path), line.Check, line.Mode, mut, line.Seed, i, p.Res, p.P, len(p.Ops), resName(res), time.Since(t0).Microseconds()})
				bw.Write(b)
				bw.WriteString("\n")
			}
		}
		f.Close()
	}
}

func init() {
	if len(os.Args) >= 3 && os.Args[1] == "dumpself" {
		dumpSelf(os.Args[2])
		os.Exit(0)
	}
	if len(os.Args) >= 4 && os.Args[1] == "parts" {
		parts(os.Args[2], os.Args[3:])
		os.Exit(0)
	}
}
