// sim.go: a deterministic discrete-event simulation of etcd's raft
// (go.etcd.io/raft/v3 at c51f010, RawNode) for fero's E-38.
//
// Each node is a single-threaded raft loop (each step costs CPU time), an
// append thread that group-commits MsgStorageAppend with one fsync, and an
// apply thread. With Async (etcd's AsyncStorageWrites, fero's design: "the
// leader writes its own journal in parallel"), a leader sends appends before
// its own fsync and counts itself only once its fsync lands. Without Async,
// the raft loop fsyncs before it sends (etcd's classic Ready loop).
//
// The network is a set of directed links, each up or down, with FIFO
// delivery and a latency. A client proposes writes at a fixed rate to the
// node it believes leads, follows leader hints, and retries.
//
// Time is in microseconds. Nothing here reads the wall clock; raft's own
// election jitter is seeded through the one-line patch in patch-raft.sh.
package main

import (
	"container/heap"
	"encoding/binary"
	"math/rand"
	"sort"

	"go.etcd.io/raft/v3"
	pb "go.etcd.io/raft/v3/raftpb"
	"google.golang.org/protobuf/proto"
)

type Params struct {
	N           int
	ElectionMs  int64 // election.ms; one tick is ElectionMs/10
	PreVote     bool
	CheckQuorum bool
	Async       bool
	StepUs      int64 // CPU per raft step
	FsyncUs     int64 // one group-committed fsync
	ApplyUs     int64
	NetUs       int64 // one-way latency
	NetJitterUs int64
	Rate        int   // client writes a second
	RetryUs     int64 // client resend if no commit by then
	FaultAt     int64
	EndAt       int64
	Seed        int64
	FeroTimers  bool // CheckQuorum every E/2, election jitter 0.25 E (patched knobs)
	CQDiv4      bool // with FeroTimers: CheckQuorum every E/4
}

func DefaultParams() Params {
	return Params{N: 3, ElectionMs: 1000, PreVote: true, CheckQuorum: true, Async: true,
		StepUs: 20, FsyncUs: 2000, ApplyUs: 20, NetUs: 250, NetJitterUs: 100,
		Rate: 200, RetryUs: 1_000_000, FaultAt: 15_000_000, EndAt: 75_000_000, Seed: 1}
}

// ---- events -------------------------------------------------------------

const (
	evInbox = iota // an item reaches a node's raft loop queue
	evCPUFree
	evAppendDone
	evApplyDone
	evTick
	evClient
	evRetry
	evAction // a scheduled scenario action
	evPoll   // the client looks for a leader again
)

type item struct {
	kind    int // 0 step msg, 1 tick, 2 propose, 3 transfer, 4 campaign
	msg     *pb.Message
	data    []byte
	target  uint64
	writeID int64
	attempt int64
}

type event struct {
	at   int64
	seq  int64
	kind int
	node int
	it   item
	fn   func()
}

type evq []*event

func (q evq) Len() int { return len(q) }
func (q evq) Less(i, j int) bool {
	if q[i].at != q[j].at {
		return q[i].at < q[j].at
	}
	return q[i].seq < q[j].seq
}
func (q evq) Swap(i, j int)       { q[i], q[j] = q[j], q[i] }
func (q *evq) Push(x interface{}) { *q = append(*q, x.(*event)) }
func (q *evq) Pop() interface{} {
	old := *q
	n := len(old)
	x := old[n-1]
	*q = old[:n-1]
	return x
}

// ---- nodes --------------------------------------------------------------

type node struct {
	id       uint64
	rn       *raft.RawNode
	st       *raft.MemoryStorage
	inbox    []item
	busy     bool
	slow     int64 // CPU multiplier
	slowDisk int64 // fsync multiplier
	down     bool
	appendQ  []*pb.Message
	appendBz bool
	applyQ   []*pb.Message
	applyBz  bool
	wasLead  bool
	term     uint64
}

type LeaderEvent struct {
	At   int64
	Node uint64
	Term uint64
}

type Sim struct {
	P       Params
	now     int64
	seq     int64
	q       evq
	rng     *rand.Rand
	nodes   []*node
	link    [][]bool  // link[i][j]: messages from i to j get through
	lastArr [][]int64 // FIFO per link

	// client
	waiting    []int64
	polling    bool
	nextWrite  int64
	submitted  map[int64]int64 // write id -> first submit time
	committed  map[int64]int64 // write id -> commit time
	commitList []int64         // commit times in order
	Leaders    []LeaderEvent
	Log        []string
	Verbose    bool
}

func NewSim(p Params) *Sim {
	raft.SeedElectionJitter(p.Seed)
	raft.E38CQDiv, raft.E38JitterTicks = 1, 0
	if p.FeroTimers {
		raft.E38CQDiv, raft.E38JitterTicks = 2, 3
		if p.CQDiv4 {
			raft.E38CQDiv = 4
		}
	}
	s := &Sim{P: p, rng: rand.New(rand.NewSource(p.Seed)), submitted: map[int64]int64{}, committed: map[int64]int64{}}
	peers := make([]uint64, p.N)
	for i := range peers {
		peers[i] = uint64(i + 1)
	}
	s.link = make([][]bool, p.N)
	s.lastArr = make([][]int64, p.N)
	for i := 0; i < p.N; i++ {
		s.link[i] = make([]bool, p.N)
		s.lastArr[i] = make([]int64, p.N)
		for j := range s.link[i] {
			s.link[i][j] = true
		}
	}
	for i := 0; i < p.N; i++ {
		st := raft.NewMemoryStorage()
		snap := &pb.Snapshot{Metadata: &pb.SnapshotMetadata{
			ConfState: &pb.ConfState{Voters: peers}, Index: proto.Uint64(1), Term: proto.Uint64(1)}}
		if err := st.ApplySnapshot(snap); err != nil {
			panic(err)
		}
		c := &raft.Config{ID: uint64(i + 1), ElectionTick: 10, HeartbeatTick: 1, Storage: st,
			MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, CheckQuorum: p.CheckQuorum, PreVote: p.PreVote,
			AsyncStorageWrites: p.Async, StepDownOnRemoval: true, Logger: quiet{}}
		rn, err := raft.NewRawNode(c)
		if err != nil {
			panic(err)
		}
		s.nodes = append(s.nodes, &node{id: uint64(i + 1), rn: rn, st: st, slow: 1, slowDisk: 1})
	}
	tick := p.ElectionMs * 1000 / 10
	for i := range s.nodes {
		s.at(s.rng.Int63n(tick), evTick, i, item{}, nil)
	}
	s.at(500_000, evClient, 0, item{}, nil)
	return s
}

type quiet struct{}

func (quiet) Debug(v ...interface{})                   {}
func (quiet) Debugf(format string, v ...interface{})   {}
func (quiet) Error(v ...interface{})                   {}
func (quiet) Errorf(format string, v ...interface{})   {}
func (quiet) Info(v ...interface{})                    {}
func (quiet) Infof(format string, v ...interface{})    {}
func (quiet) Warning(v ...interface{})                 {}
func (quiet) Warningf(format string, v ...interface{}) {}
func (quiet) Fatal(v ...interface{})                   { panic(v) }
func (quiet) Fatalf(format string, v ...interface{})   { panic(format) }
func (quiet) Panic(v ...interface{})                   { panic(v) }
func (quiet) Panicf(format string, v ...interface{})   { panic(format) }

func (s *Sim) at(t int64, kind, n int, it item, fn func()) {
	s.seq++
	heap.Push(&s.q, &event{at: t, seq: s.seq, kind: kind, node: n, it: it, fn: fn})
}

// Do schedules a scenario action at time t.
func (s *Sim) Do(t int64, fn func()) { s.at(t, evAction, 0, item{}, fn) }

func (s *Sim) Run() {
	for s.q.Len() > 0 {
		e := heap.Pop(&s.q).(*event)
		if e.at > s.P.EndAt {
			break
		}
		s.now = e.at
		switch e.kind {
		case evInbox:
			n := s.nodes[e.node]
			if n.down {
				continue
			}
			n.inbox = append(n.inbox, e.it)
			s.kick(e.node)
		case evCPUFree:
			s.nodes[e.node].busy = false
			s.kick(e.node)
		case evTick:
			n := s.nodes[e.node]
			if !n.down {
				s.at(s.now, evInbox, e.node, item{kind: 1}, nil)
			}
			s.at(s.now+s.P.ElectionMs*100, evTick, e.node, item{}, nil)
		case evAppendDone:
			s.appendDone(e.node)
		case evApplyDone:
			s.applyDone(e.node)
		case evClient:
			s.client()
			s.at(s.now+1_000_000/int64(s.P.Rate), evClient, 0, item{}, nil)
		case evRetry:
			if _, ok := s.committed[e.it.writeID]; !ok {
				s.submit(e.it.writeID)
			}
		case evAction:
			e.fn()
		case evPoll:
			s.poll()
		}
	}
}

// kick runs node i's raft loop if it is idle: it steps every item queued
// so far (each costs StepUs), then handles one Ready for the batch, as
// etcd's node loop does while the previous Ready was being handled.
func (s *Sim) kick(i int) {
	n := s.nodes[i]
	if n.busy || n.down || len(n.inbox) == 0 {
		return
	}
	batch := n.inbox
	n.inbox = nil
	cost := int64(0)
	for _, it := range batch {
		cost += s.P.StepUs * n.slow
		switch it.kind {
		case 0:
			_ = n.rn.Step(it.msg)
		case 1:
			n.rn.Tick()
		case 2:
			if err := n.rn.Propose(it.data); err != nil {
				s.waiting = append(s.waiting, it.writeID)
				if !s.polling {
					s.polling = true
					s.at(s.now+5_000, evPoll, 0, item{}, nil)
				}
			}
		case 3:
			n.rn.TransferLeader(it.target)
		case 4:
			_ = n.rn.Campaign()
		}
		s.trackLeader(i)
	}
	cost += s.ready(i, cost)
	n.busy = true
	s.at(s.now+cost, evCPUFree, i, item{}, nil)
}

// ready handles the node's Ready after one step. It returns extra CPU time
// spent in the raft loop (the inline fsync without Async).
func (s *Sim) ready(i int, cpu int64) int64 {
	n := s.nodes[i]
	if !n.rn.HasReady() {
		return 0
	}
	rd := n.rn.Ready()
	if s.P.Async {
		for _, m := range rd.Messages {
			switch m.GetTo() {
			case raft.LocalAppendThread:
				n.appendQ = append(n.appendQ, m)
				s.startAppend(i, cpu)
			case raft.LocalApplyThread:
				n.applyQ = append(n.applyQ, m)
				s.startApply(i, cpu)
			default:
				s.send(i, m, s.now+cpu)
			}
		}
		return 0
	}
	extra := int64(0)
	if !raft.IsEmptyHardState(rd.HardState) || len(rd.Entries) > 0 || !raft.IsEmptySnap(rd.Snapshot) {
		if rd.Snapshot != nil && !raft.IsEmptySnap(rd.Snapshot) {
			_ = n.st.ApplySnapshot(rd.Snapshot)
		}
		if !raft.IsEmptyHardState(rd.HardState) {
			_ = n.st.SetHardState(rd.HardState)
		}
		_ = n.st.Append(rd.Entries)
		if rd.MustSync {
			extra = s.P.FsyncUs * n.slowDisk
		}
	}
	for _, m := range rd.Messages {
		s.send(i, m, s.now+cpu+extra)
	}
	s.observe(i, rd.CommittedEntries, s.now+cpu+extra)
	n.rn.Advance(rd)
	return extra
}

func (s *Sim) startAppend(i int, delay int64) {
	n := s.nodes[i]
	if n.appendBz || len(n.appendQ) == 0 || n.down {
		return
	}
	n.appendBz = true
	s.at(s.now+delay+s.P.FsyncUs*n.slowDisk, evAppendDone, i, item{}, nil)
}

// appendDone: one fsync covered every append queued when it started (group
// commit). Writes land in storage, then the responses go out.
func (s *Sim) appendDone(i int) {
	n := s.nodes[i]
	n.appendBz = false
	if n.down {
		return
	}
	batch := n.appendQ
	n.appendQ = nil
	for _, m := range batch {
		if hs := hardState(m); !raft.IsEmptyHardState(hs) {
			_ = n.st.SetHardState(hs)
		}
		if snap := m.GetSnapshot(); snap != nil && !raft.IsEmptySnap(snap) {
			_ = n.st.ApplySnapshot(snap)
		} else if len(m.GetEntries()) > 0 {
			_ = n.st.Append(m.GetEntries())
		}
		for _, r := range m.GetResponses() {
			s.route(i, r, s.now)
		}
	}
	s.startAppend(i, 0)
}

func hardState(m *pb.Message) *pb.HardState {
	return &pb.HardState{Term: proto.Uint64(m.GetTerm()), Vote: proto.Uint64(m.GetVote()), Commit: proto.Uint64(m.GetCommit())}
}

func (s *Sim) startApply(i int, delay int64) {
	n := s.nodes[i]
	if n.applyBz || len(n.applyQ) == 0 || n.down {
		return
	}
	n.applyBz = true
	s.at(s.now+delay+s.P.ApplyUs*n.slow, evApplyDone, i, item{}, nil)
}

func (s *Sim) applyDone(i int) {
	n := s.nodes[i]
	n.applyBz = false
	if n.down {
		return
	}
	m := n.applyQ[0]
	n.applyQ = n.applyQ[1:]
	s.observe(i, m.GetEntries(), s.now)
	for _, r := range m.GetResponses() {
		s.route(i, r, s.now)
	}
	s.startApply(i, 0)
}

// route delivers a storage thread's response: to its own raft loop, or
// over the network.
func (s *Sim) route(i int, m *pb.Message, t int64) {
	if m.GetTo() == uint64(i+1) {
		s.at(t, evInbox, i, item{kind: 0, msg: m}, nil)
		return
	}
	s.send(i, m, t)
}

func (s *Sim) send(i int, m *pb.Message, t int64) {
	j := int(m.GetTo()) - 1
	if j < 0 || j >= s.P.N {
		return
	}
	if j == i {
		s.at(t, evInbox, i, item{kind: 0, msg: m}, nil)
		return
	}
	if !s.link[i][j] {
		return
	}
	arr := t + s.P.NetUs + s.rng.Int63n(s.P.NetJitterUs+1)
	if arr <= s.lastArr[i][j] {
		arr = s.lastArr[i][j] + 1
	}
	s.lastArr[i][j] = arr
	s.at(arr, evInbox, j, item{kind: 0, msg: proto.Clone(m).(*pb.Message)}, nil)
}

// observe records client writes seen in committed entries (the first node
// to apply one is, in practice, its leader).
func (s *Sim) observe(i int, ents []*pb.Entry, t int64) {
	for _, e := range ents {
		d := e.GetData()
		if e.GetType() != pb.EntryType_EntryNormal || len(d) != 8 {
			continue
		}
		id := int64(binary.BigEndian.Uint64(d))
		if _, ok := s.committed[id]; !ok {
			s.committed[id] = t
			s.commitList = append(s.commitList, t)
		}
	}
}

func (s *Sim) trackLeader(i int) {
	n := s.nodes[i]
	bs := n.rn.BasicStatus()
	isLead := bs.RaftState == raft.StateLeader
	if isLead && (!n.wasLead || bs.GetTerm() != n.term) {
		s.Leaders = append(s.Leaders, LeaderEvent{At: s.now, Node: n.id, Term: bs.GetTerm()})
	}
	n.wasLead = isLead
	n.term = bs.GetTerm()
}

// ---- client -------------------------------------------------------------

func (s *Sim) client() {
	s.nextWrite++
	s.submitted[s.nextWrite] = s.now
	s.submit(s.nextWrite)
}

func (s *Sim) submit(id int64) {
	// An oracle client: it proposes at the node that leads with the highest
	// term, so the numbers measure the cluster, not a client's routing.
	// While no node leads, writes wait in one queue polled every 5 ms.
	g := s.Leader()
	if g < 0 {
		s.waiting = append(s.waiting, id)
		if !s.polling {
			s.polling = true
			s.at(s.now+5_000, evPoll, 0, item{}, nil)
		}
		return
	}
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(id))
	s.at(s.now+s.P.NetUs, evInbox, g, item{kind: 2, data: b, writeID: id}, nil)
	s.at(s.now+s.P.RetryUs, evRetry, 0, item{writeID: id}, nil)
}

func (s *Sim) poll() {
	s.polling = false
	if s.Leader() < 0 {
		s.polling = true
		s.at(s.now+5_000, evPoll, 0, item{}, nil)
		return
	}
	w := s.waiting
	s.waiting = nil
	for _, id := range w {
		if _, ok := s.committed[id]; !ok {
			s.submit(id)
		}
	}
}

// ---- scenario helpers ---------------------------------------------------

func (s *Sim) SetLink(i, j int, up bool) { s.link[i][j] = up }
func (s *Sim) Cut(i, j int)              { s.link[i][j] = false; s.link[j][i] = false }
func (s *Sim) Heal() {
	for i := range s.link {
		for j := range s.link[i] {
			s.link[i][j] = true
		}
	}
}
func (s *Sim) Slow(i int, cpu, disk int64) { s.nodes[i].slow = cpu; s.nodes[i].slowDisk = disk }
func (s *Sim) Crash(i int) {
	n := s.nodes[i]
	n.down = true
	n.inbox = nil
}
func (s *Sim) Transfer(from, to int) {
	s.at(s.now, evInbox, from, item{kind: 3, target: uint64(to + 1)}, nil)
}
func (s *Sim) Campaign(i int) { s.at(s.now, evInbox, i, item{kind: 4}, nil) }

// Leader returns the node that leads with the highest term, or -1.
func (s *Sim) Leader() int {
	best, bt := -1, uint64(0)
	for i, n := range s.nodes {
		if n.down {
			continue
		}
		bs := n.rn.BasicStatus()
		if bs.RaftState == raft.StateLeader && bs.GetTerm() >= bt {
			best, bt = i, bs.GetTerm()
		}
	}
	return best
}

// ---- metrics --------------------------------------------------------------

type Metrics struct {
	SteadyP50, SteadyP99 int64 // writes submitted in [5 s, FaultAt)
	AfterP50, AfterP99   int64 // writes submitted in [FaultAt + 5 E, EndAt - 2 s]
	LongestGapUs         int64 // longest time with no commit in [FaultAt, EndAt]
	FirstCommitAfterUs   int64 // first commit of a write submitted after the fault, minus FaultAt
	LeaderChanges        int   // leader elections after the fault
	MaxChangesPer10E     int   // most elections in any 10 x election.ms window after FaultAt + 2 E
	LastLeader           uint64
	CommitsLastWindow    int // commits in the last 10 x election.ms
	Unfinished           int // writes submitted before EndAt - 2 s never committed
	LeaderSince          int64
}

func pct(xs []int64, p float64) int64 {
	if len(xs) == 0 {
		return -1
	}
	sort.Slice(xs, func(a, b int) bool { return xs[a] < xs[b] })
	k := int(p * float64(len(xs)-1))
	return xs[k]
}

func (s *Sim) Metrics() Metrics {
	E := s.P.ElectionMs * 1000
	var m Metrics
	var steady, after []int64
	for id, t0 := range s.submitted {
		tc, ok := s.committed[id]
		if !ok {
			if t0 < s.P.EndAt-2_000_000 {
				m.Unfinished++
			}
			continue
		}
		if t0 >= 5_000_000 && t0 < s.P.FaultAt {
			steady = append(steady, tc-t0)
		}
		if t0 >= s.P.FaultAt+5*E && t0 < s.P.EndAt-2_000_000 {
			after = append(after, tc-t0)
		}
		if t0 >= s.P.FaultAt {
			if d := tc - s.P.FaultAt; m.FirstCommitAfterUs == 0 || d < m.FirstCommitAfterUs {
				m.FirstCommitAfterUs = d
			}
		}
	}
	m.SteadyP50, m.SteadyP99 = pct(steady, 0.5), pct(steady, 0.99)
	m.AfterP50, m.AfterP99 = pct(after, 0.5), pct(after, 0.99)
	ct := append([]int64(nil), s.commitList...)
	sort.Slice(ct, func(a, b int) bool { return ct[a] < ct[b] })
	prev := s.P.FaultAt
	for _, t := range ct {
		if t < s.P.FaultAt {
			continue
		}
		if t-prev > m.LongestGapUs {
			m.LongestGapUs = t - prev
		}
		prev = t
		if t >= s.P.EndAt-10*E {
			m.CommitsLastWindow++
		}
	}
	if s.P.EndAt-prev > m.LongestGapUs {
		m.LongestGapUs = s.P.EndAt - prev
	}
	var after2 []int64
	for _, l := range s.Leaders {
		if l.At >= s.P.FaultAt {
			m.LeaderChanges++
		}
		if l.At >= s.P.FaultAt+2*E {
			after2 = append(after2, l.At)
		}
	}
	for a := range after2 {
		c := 0
		for b := a; b < len(after2) && after2[b] < after2[a]+10*E; b++ {
			c++
		}
		if c > m.MaxChangesPer10E {
			m.MaxChangesPer10E = c
		}
	}
	if len(s.Leaders) > 0 {
		last := s.Leaders[len(s.Leaders)-1]
		m.LastLeader = last.Node
		m.LeaderSince = last.At
	}
	return m
}
