// Copied into a scratch checkout of etcd raft (package raft_test) by diff/run_diff.sh.
// For every script in $E10_DIFF_IN it runs etcd's own InteractionEnv and writes the
// script with its real outputs to $E10_DIFF_OUT, in datadriven format. A Go panic ends
// that script: the file keeps the directives that ran, and its name gets a .panic note.
package raft_test

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cockroachdb/datadriven"

	"go.etcd.io/raft/v3"
	"go.etcd.io/raft/v3/rafttest"
)

func TestE10Diff(t *testing.T) {
	in, out := os.Getenv("E10_DIFF_IN"), os.Getenv("E10_DIFF_OUT")
	if in == "" || out == "" {
		t.Skip("E10_DIFF_IN and E10_DIFF_OUT not set")
	}
	files, _ := filepath.Glob(filepath.Join(in, "*.txt"))
	sort.Strings(files)
	for _, path := range files {
		runOne(t, path, filepath.Join(out, filepath.Base(path)))
	}
}

type directive struct {
	cmdLine string
	input   string
}

func readScript(path string) []directive {
	f, _ := os.Open(path)
	defer f.Close()
	sc := bufio.NewScanner(f)
	var ds []directive
	var cur *directive
	var inInput bool
	for sc.Scan() {
		line := sc.Text()
		switch {
		case cur == nil && strings.TrimSpace(line) == "":
		case cur == nil:
			cur = &directive{cmdLine: line}
			inInput = true
		case inInput && line == "----":
			inInput = false
			ds = append(ds, *cur)
		case inInput:
			cur.input += line + "\n"
		case !inInput && strings.TrimSpace(line) == "":
			cur = nil
		}
	}
	return ds
}

func runOne(t *testing.T, path, outPath string) {
	env := rafttest.NewInteractionEnv(&rafttest.InteractionOpts{
		SetRandomizedElectionTimeout: raft.SetRandomizedElectionTimeout,
	})
	var buf strings.Builder
	panicked := ""
	for i, d := range readScript(path) {
		cmd, args, err := datadriven.ParseLine(d.cmdLine)
		if err != nil {
			t.Fatal(err)
		}
		td := datadriven.TestData{Pos: fmt.Sprintf("%s:%d", path, i), Cmd: cmd, CmdArgs: args, Input: strings.TrimSpace(d.input)}
		var actual string
		func() {
			defer func() {
				if r := recover(); r != nil {
					panicked = fmt.Sprintf("directive %d (%s): %v", i, d.cmdLine, r)
				}
			}()
			if cmd == "read-index" {
				// Not an etcd harness command: a linearizable read on one node.
				var idx int
				fmt.Sscanf(args[0].Key, "%d", &idx)
				env.Nodes[idx-1].ReadIndex([]byte(args[1].Key))
				actual = "ok"
				return
			}
			if cmd == "restart" {
				// Not an etcd harness command: crash a node and restart it from its storage.
				var idx int
				fmt.Sscanf(args[0].Key, "%d", &idx)
				n := &env.Nodes[idx-1]
				env.Output.Reset()
				cfg := *n.Config
				cfg.Applied = n.History[len(n.History)-1].GetMetadata().GetIndex()
				rn, err := raft.NewRawNode(&cfg)
				if err != nil {
					panic(err)
				}
				n.RawNode = rn
				n.AppendWork = nil
				n.ApplyWork = nil
				actual = env.Output.String()
				if actual == "" {
					actual = "ok"
				}
				return
			}
			actual = env.Handle(t, td)
		}()
		if panicked != "" {
			break
		}
		if actual != "" && !strings.HasSuffix(actual, "\n") {
			actual += "\n"
		}
		buf.WriteString(d.cmdLine + "\n" + d.input + "----\n")
		if strings.Contains(actual, "\n\n") {
			buf.WriteString("----\n" + actual + "----\n----\n\n")
		} else {
			buf.WriteString(actual + "\n")
		}
	}
	if err := os.WriteFile(outPath, []byte(buf.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if panicked != "" {
		_ = os.WriteFile(outPath+".panic", []byte(panicked+"\n"), 0o644)
	}
}
