// The Go side of the edge value check (../tests/edge_values.rs is the Rust side).
// Copy this file into a checkout of etcd raft at the vendored commit and run
//
//	go test -count=1 -run TestEdgeValues -v .
//
// It prints two lines, one per run: the number of cases and the FNV-1a hash of all the
// result lines. Those four numbers are the constants in ../tests/edge_values.rs.
// With EDGE_OUT=<dir> it also writes the result lines to <dir>/enum.txt and <dir>/seq.txt.
//
// What it does: it builds one node of a three-node group in one of four states
// (follower, candidate, new leader, leader with one caught-up follower), steps messages
// whose fields hold values from the bottom and the top of uint64, and prints what the
// node looks like after each one, or P when Go panics.
package raft_test

import (
	"bufio"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"go.etcd.io/raft/v3"
	pb "go.etcd.io/raft/v3/raftpb"
)

const edgeTop = uint64(math.MaxUint64)

func edgeNode(state uint64) *raft.RawNode {
	st := raft.NewMemoryStorage()
	must := func(err error) {
		if err != nil {
			panic(err)
		}
	}
	must(st.ApplySnapshot(&pb.Snapshot{Metadata: &pb.SnapshotMetadata{
		ConfState: &pb.ConfState{Voters: []uint64{1, 2, 3}}, Index: new(uint64(1)), Term: new(uint64(1)),
	}}))
	rn, err := raft.NewRawNode(&raft.Config{
		ID: 1, ElectionTick: 10, HeartbeatTick: 1, Storage: st, MaxSizePerMsg: edgeTop, MaxInflightMsgs: 256,
		Logger: &raft.DefaultLogger{Logger: log.New(io.Discard, "", 0)},
	})
	must(err)
	m := func(t pb.MessageType) *pb.Message {
		return &pb.Message{Type: t.Enum(), From: new(uint64(2)), To: new(uint64(1)), Term: new(uint64(1))}
	}
	switch state {
	case 0:
		h := m(pb.MsgHeartbeat)
		h.Commit = new(uint64(0))
		must(rn.Step(h))
	case 1:
		must(rn.Campaign())
		rn.Advance(rn.Ready())
	default:
		must(rn.Campaign())
		rn.Advance(rn.Ready())
		must(rn.Step(m(pb.MsgVoteResp)))
		rn.Advance(rn.Ready())
		if state == 3 {
			a := m(pb.MsgAppResp)
			a.Index = new(uint64(2))
			must(rn.Step(a))
			rn.Advance(rn.Ready())
		}
	}
	return rn
}

func edgeMsg(ty int32, from, term, idx, lt, c, h, rej, e uint64) *pb.Message {
	msg := &pb.Message{
		Type: pb.MessageType(ty).Enum(), From: new(from), To: new(uint64(1)), Term: new(term), Index: new(idx),
		LogTerm: new(lt), Commit: new(c), RejectHint: new(h), Reject: new(rej == 1),
	}
	if e == 1 {
		msg.Entries = []*pb.Entry{{Term: new(lt), Index: new(idx + 1), Data: []byte("x")}}
	}
	if e == 2 {
		msg.Entries = []*pb.Entry{{Term: new(edgeTop), Index: new(edgeTop), Data: []byte("x")}}
	}
	if ty == 7 {
		msg.Snapshot = &pb.Snapshot{Metadata: &pb.SnapshotMetadata{
			ConfState: &pb.ConfState{Voters: []uint64{1, 2, 3}}, Index: new(idx), Term: new(lt),
		}}
	}
	return msg
}

func edgeDescribe(b *strings.Builder, rn *raft.RawNode, err error) {
	e := 0
	if err != nil {
		e = 1
	}
	s := rn.Status()
	fmt.Fprintf(b, "err=%d st=%s term=%d vote=%d commit=%d lead=%d",
		e, s.RaftState, s.HardState.GetTerm(), s.HardState.GetVote(), s.HardState.GetCommit(), s.Lead)
	ids := []uint64{}
	for id := range s.Progress {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		p := s.Progress[id]
		fmt.Fprintf(b, " p%d=%d/%d/%s", id, p.Match, p.Next, p.State)
	}
	if rn.HasReady() {
		rd := rn.Ready()
		fmt.Fprintf(b, " rd=%d/%d/%d", len(rd.Messages), len(rd.Entries), len(rd.CommittedEntries))
	}
}

func edgeRun(state uint64, msgs []*pb.Message) (o string) {
	step := 0
	defer func() {
		if r := recover(); r != nil {
			o = fmt.Sprintf("P%d", step)
		}
	}()
	rn := edgeNode(state)
	var b strings.Builder
	for _, msg := range msgs {
		step++
		b.WriteString("| ")
		edgeDescribe(&b, rn, rn.Step(msg))
	}
	return b.String()
}

type edgeLcg struct{ x uint64 }

func (g *edgeLcg) n(n uint64) uint64 {
	g.x = g.x*6364136223846793005 + 1442695040888963407
	return (g.x >> 33) % n
}

type edgeSink struct {
	h interface {
		Write([]byte) (int, error)
		Sum64() uint64
	}
	w     *bufio.Writer
	lines uint64
}

func newEdgeSink(t *testing.T, name string) *edgeSink {
	s := &edgeSink{h: fnv.New64a()}
	if dir := os.Getenv("EDGE_OUT"); dir != "" {
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.w.Flush(); f.Close() })
		s.w = bufio.NewWriter(f)
	}
	return s
}

func (s *edgeSink) line(l string) {
	s.h.Write([]byte(l))
	s.h.Write([]byte("\n"))
	if s.w != nil {
		s.w.WriteString(l)
		s.w.WriteString("\n")
	}
	s.lines++
}

// Every message type, on every state, with every mix of the edge values: one message per case.
func TestEdgeValuesEnum(t *testing.T) {
	s := newEdgeSink(t, "enum.txt")
	vals := []uint64{0, 1, 2, edgeTop - 1, edgeTop}
	terms := []uint64{0, 1, edgeTop}
	for state := uint64(0); state < 4; state++ {
		for ty := int32(0); ty < 23; ty++ {
			for _, term := range terms {
				for _, idx := range vals {
					for _, lt := range vals {
						for _, c := range vals {
							for _, h := range vals {
								for rej := uint64(0); rej < 2; rej++ {
									for e := uint64(0); e < 3; e++ {
										msg := edgeMsg(ty, 2, term, idx, lt, c, h, rej, e)
										s.line(fmt.Sprintf("%d %d %d %d %d %d %d %d %d => %s",
											state, ty, term, idx, lt, c, h, rej, e, edgeRun(state, []*pb.Message{msg})))
									}
								}
							}
						}
					}
				}
			}
		}
	}
	t.Logf("enum: lines=%d fnv=0x%016x", s.lines, s.h.Sum64())
}

// Random runs of four messages from the same space. EDGE_SEQ sets the count (default 500000).
func TestEdgeValuesSeq(t *testing.T) {
	s := newEdgeSink(t, "seq.txt")
	count := uint64(500000)
	if v := os.Getenv("EDGE_SEQ"); v != "" {
		count, _ = strconv.ParseUint(v, 10, 64)
	}
	vals := []uint64{0, 1, 2, 3, edgeTop - 1, edgeTop}
	terms := []uint64{0, 1, 1, 2, edgeTop}
	g := &edgeLcg{42}
	for c := uint64(0); c < count; c++ {
		state := g.n(4)
		var msgs []*pb.Message
		for i := 0; i < 4; i++ {
			ty := int32(g.n(23))
			from := 2 + g.n(2)
			term := terms[g.n(5)]
			idx, lt, cm, h := vals[g.n(6)], vals[g.n(6)], vals[g.n(6)], vals[g.n(6)]
			rej, e := g.n(2), g.n(3)
			msgs = append(msgs, edgeMsg(ty, from, term, idx, lt, cm, h, rej, e))
		}
		s.line(fmt.Sprintf("%d %d => %s", c, state, edgeRun(state, msgs)))
	}
	t.Logf("seq: lines=%d fnv=0x%016x", s.lines, s.h.Sum64())
}
