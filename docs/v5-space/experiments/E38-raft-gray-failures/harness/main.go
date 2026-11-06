// main.go: E-38's scenarios on sim.go.
//
//	e38 -suite named      the named topologies (Cloudflare 2020, Jensen et al.'s three, one-way loss)
//	e38 -suite sweep3     every directed-link topology of 3 nodes (64), with and without a leader crash
//	e38 -suite sweep5     random directed-link topologies of 5 nodes
//	e38 -suite ablate     sweep3 with PreVote and CheckQuorum each on and off
//	e38 -suite transfer   leader transfer to each node under partial partitions
//	e38 -suite slow       one node 10x slower (CPU, fsync, both), as leader and as follower
//
// Every run prints one JSON line; -summary prints a table at the end.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"
)

type Result struct {
	Suite, Name    string
	N              int
	Seed           int64
	PreVote, CQ    bool
	Async          bool
	Topology       string // directed links that are down, "a>b"
	Crash          bool   // the leader also crashed at the fault
	StarMajority   bool   // some live node has two-way links to a majority (itself included)
	CliqueMajority bool   // a majority of live nodes all have two-way links to each other
	LeaderAtFault  int
	Metrics
	WritableIn2E    bool // longest commit gap after the fault <= 2 x election.ms and writes continue
	Flaps           bool // more than one election in some 10 x election.ms window (after the first 2 E)
	StillWriting    bool
	LeaderLostAfter int64 // for slow: when the slow leader stopped leading (-1 never)
}

func linksDown(s *Sim) string {
	var d []string
	for i := range s.link {
		for j := range s.link[i] {
			if i != j && !s.link[i][j] {
				d = append(d, fmt.Sprintf("%d>%d", i+1, j+1))
			}
		}
	}
	if len(d) == 0 {
		return "-"
	}
	return strings.Join(d, ",")
}

func majorities(link [][]bool, alive []bool) (star, clique bool) {
	n := len(link)
	maj := n/2 + 1
	for c := 0; c < n; c++ {
		if !alive[c] {
			continue
		}
		k := 1
		for j := 0; j < n; j++ {
			if j != c && alive[j] && link[c][j] && link[j][c] {
				k++
			}
		}
		if k >= maj {
			star = true
		}
	}
	// clique: any subset of size maj, all alive and pairwise two-way
	for mask := 0; mask < 1<<n; mask++ {
		var mem []int
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				mem = append(mem, i)
			}
		}
		if len(mem) < maj {
			continue
		}
		ok := true
		for _, a := range mem {
			if !alive[a] {
				ok = false
			}
			for _, b := range mem {
				if a != b && !(link[a][b] && link[b][a]) {
					ok = false
				}
			}
		}
		if ok {
			clique = true
		}
	}
	return
}

// prepare makes node 1 (index 0) the leader before the fault, by a
// transfer at 8 s if needed.
func prepare(s *Sim) {
	s.Do(8_000_000, func() {
		if l := s.Leader(); l > 0 {
			s.Transfer(l, 0)
		}
	})
}

func finish(s *Sim, r *Result, alive []bool) {
	r.Metrics = s.Metrics()
	E := s.P.ElectionMs * 1000
	r.StarMajority, r.CliqueMajority = majorities(s.link, alive)
	r.StillWriting = r.CommitsLastWindow > 0
	r.WritableIn2E = r.LongestGapUs <= 2*E && r.StillWriting
	r.Flaps = r.MaxChangesPer10E > 1
	r.N = s.P.N
	r.Seed = s.P.Seed
	r.PreVote, r.CQ, r.Async = s.P.PreVote, s.P.CheckQuorum, s.P.Async
}

// run one topology: at FaultAt the links in down[] go down (and the leader
// crashes if crash). It returns the result.
func runTopo(p Params, suite, name string, down [][2]int, crash bool) Result {
	s := NewSim(p)
	prepare(s)
	r := Result{Suite: suite, Name: name, Crash: crash, LeaderLostAfter: -1}
	alive := make([]bool, p.N)
	for i := range alive {
		alive[i] = true
	}
	s.Do(p.FaultAt, func() {
		r.LeaderAtFault = s.Leader() + 1
		for _, d := range down {
			s.SetLink(d[0], d[1], false)
		}
		if crash {
			s.Crash(0)
		}
	})
	if crash {
		alive[0] = false
	}
	s.Run()
	r.Topology = linksDown(s)
	finish(s, &r, alive)
	return r
}

func named(p Params) []Result {
	var out []Result
	cut := func(a, b int) [][2]int { return [][2]int{{a, b}, {b, a}} }
	cat := func(xs ...[][2]int) [][2]int {
		var r [][2]int
		for _, x := range xs {
			r = append(r, x...)
		}
		return r
	}
	p3 := p
	p3.N = 3
	// 0 is the leader, 1 and 2 followers.
	out = append(out,
		runTopo(p3, "named", "baseline", nil, false),
		runTopo(p3, "named", "leader-crash", nil, true),
		runTopo(p3, "named", "cloudflare-2020: leader-follower link down (chain 2-1-3)", cut(0, 1), false),
		runTopo(p3, "named", "follower-follower link down", cut(1, 2), false),
		runTopo(p3, "named", "leader isolated", cat(cut(0, 1), cut(0, 2)), false),
		runTopo(p3, "named", "one-way: leader cannot send", [][2]int{{0, 1}, {0, 2}}, false),
		runTopo(p3, "named", "one-way: leader cannot receive", [][2]int{{1, 0}, {2, 0}}, false),
		runTopo(p3, "named", "one-way: leader to 2 lost", [][2]int{{0, 1}}, false),
		runTopo(p3, "named", "one-way: 2 to leader lost", [][2]int{{1, 0}}, false),
		runTopo(p3, "named", "one-way: leader to 2 and 3 to leader lost", [][2]int{{0, 1}, {2, 0}}, false),
	)
	p5 := p
	p5.N = 5
	// Jensen, Howard and Mortier (HAOC'21), as we read their three cases:
	// quorum-loss: the leader keeps a two-way link to one follower only,
	// which reaches everyone.
	out = append(out, runTopo(p5, "named", "jensen quorum-loss: leader reaches only 2", cat(cut(0, 2), cut(0, 3), cut(0, 4)), false))
	// constrained election: the leader dies and the most up-to-date
	// followers reach few others. 2 and 3 stay up to date; 4 and 5 hear no
	// appends (one-way loss from the leader), then the leader crashes and
	// 2 and 3 can only reach each other and one of 4, 5.
	{
		s := NewSim(p5)
		prepare(s)
		r := Result{Suite: "named", Name: "jensen constrained-election: leader dies, up-to-date 2,3 reach only each other and 4", LeaderLostAfter: -1}
		s.Do(p5.FaultAt-3_000_000, func() { s.SetLink(0, 3, false); s.SetLink(0, 4, false) })
		s.Do(p5.FaultAt, func() {
			r.LeaderAtFault = s.Leader() + 1
			s.Crash(0)
			s.Cut(1, 4)
			s.Cut(2, 4)
		})
		s.Run()
		r.Topology = linksDown(s)
		alive := []bool{false, true, true, true, true}
		finish(s, &r, alive)
		out = append(out, r)
	}
	// PreVote+CheckQuorum chained: 1-2-3 with 4,5 on 2 only? We take the
	// 5-node chain where the leader's side and the far side meet at 3.
	out = append(out, runTopo(p5, "named", "chain: leader reaches 2,3; 4,5 reach 3 only", cat(cut(0, 3), cut(0, 4), cut(1, 3), cut(1, 4)), false))
	out = append(out, runTopo(p5, "named", "cloudflare-2020 in 5: leader-follower link down", cut(0, 1), false))
	return out
}

func sweep(p Params, suite string, n int, topos [][][2]int, crash bool) []Result {
	var out []Result
	for k, d := range topos {
		q := p
		q.N = n
		out = append(out, runTopo(q, suite, fmt.Sprintf("topo%d", k), d, crash))
	}
	return out
}

func allTopos3() [][][2]int {
	var pairs [][2]int
	for i := 0; i < 3; i++ {
		for j := 0; j < 3; j++ {
			if i != j {
				pairs = append(pairs, [2]int{i, j})
			}
		}
	}
	var out [][][2]int
	for mask := 0; mask < 1<<len(pairs); mask++ {
		var d [][2]int
		for b, pr := range pairs {
			if mask&(1<<b) != 0 {
				d = append(d, pr)
			}
		}
		out = append(out, d)
	}
	return out
}

func randomTopos(n, count int, seed int64) [][][2]int {
	rng := rand.New(rand.NewSource(seed))
	var out [][][2]int
	for len(out) < count {
		var d [][2]int
		pdown := 0.1 + 0.4*rng.Float64()
		for i := 0; i < n; i++ {
			for j := 0; j < n; j++ {
				if i != j && rng.Float64() < pdown {
					d = append(d, [2]int{i, j})
				}
			}
		}
		out = append(out, d)
	}
	return out
}

func transfer(p Params) []Result {
	var out []Result
	for _, n := range []int{3, 5} {
		q := p
		q.N = n
		topos := map[string][][2]int{
			"none":                     nil,
			"target cut from leader":   {{0, 1}, {1, 0}},
			"target cut from others":   {},
			"target one-way to leader": {{0, 1}},
		}
		for j := 2; j < n; j++ {
			topos["target cut from others"] = append(topos["target cut from others"], [2]int{1, j}, [2]int{j, 1})
		}
		names := make([]string, 0, len(topos))
		for k := range topos {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, name := range names {
			d := topos[name]
			s := NewSim(q)
			prepare(s)
			r := Result{Suite: "transfer", Name: "transfer to 2, " + name, LeaderLostAfter: -1}
			s.Do(q.FaultAt, func() {
				r.LeaderAtFault = s.Leader() + 1
				for _, x := range d {
					s.SetLink(x[0], x[1], false)
				}
			})
			s.Do(q.FaultAt+1_000_000, func() {
				if l := s.Leader(); l >= 0 {
					s.Transfer(l, 1)
				}
			})
			s.Run()
			r.Topology = linksDown(s)
			alive := make([]bool, n)
			for i := range alive {
				alive[i] = true
			}
			finish(s, &r, alive)
			out = append(out, r)
		}
	}
	return out
}

func slow(p Params) []Result {
	var out []Result
	for _, n := range []int{3, 5} {
		for _, async := range []bool{true, false} {
			for _, rate := range []int{200, 2000} {
				for _, who := range []string{"leader", "follower"} {
					for _, kind := range []string{"cpu", "fsync", "both"} {
						q := p
						q.N = n
						q.Async = async
						q.Rate = rate
						s := NewSim(q)
						prepare(s)
						target := 0
						if who == "follower" {
							target = 1
						}
						cpu, disk := int64(1), int64(1)
						if kind != "fsync" {
							cpu = 10
						}
						if kind != "cpu" {
							disk = 10
						}
						r := Result{Suite: "slow", Name: fmt.Sprintf("%s 10x %s %d/s", who, kind, rate), LeaderLostAfter: -1}
						s.Do(q.FaultAt, func() {
							r.LeaderAtFault = s.Leader() + 1
							s.Slow(target, cpu, disk)
						})
						s.Run()
						for _, l := range s.Leaders {
							if l.At >= q.FaultAt && l.Node != 1 {
								r.LeaderLostAfter = l.At - q.FaultAt
								break
							}
						}
						r.Topology = "-"
						alive := make([]bool, n)
						for i := range alive {
							alive[i] = true
						}
						finish(s, &r, alive)
						out = append(out, r)
					}
				}
			}
		}
	}
	return out
}

func main() {
	suite := flag.String("suite", "named", "named|sweep3|sweep5|ablate|transfer|slow")
	seeds := flag.Int("seeds", 3, "seeds per case")
	end := flag.Int64("end", 75, "simulated seconds")
	elect := flag.Int64("election", 1000, "election.ms")
	count := flag.Int("count", 200, "random topologies for sweep5")
	flag.Parse()
	enc := json.NewEncoder(os.Stdout)
	for seed := int64(1); seed <= int64(*seeds); seed++ {
		p := DefaultParams()
		p.Seed = seed
		p.EndAt = *end * 1_000_000
		p.ElectionMs = *elect
		var rs []Result
		switch *suite {
		case "named":
			rs = named(p)
			q := p
			q.FeroTimers = true
			for _, r := range named(q) {
				r.Suite = "named, fero timers"
				rs = append(rs, r)
			}
			q.CQDiv4 = true
			for _, r := range named(q) {
				r.Suite = "named, fero timers, CheckQuorum every E/4"
				rs = append(rs, r)
			}
		case "sweep3":
			rs = append(sweep(p, "sweep3", 3, allTopos3(), false), sweep(p, "sweep3-crash", 3, allTopos3(), true)...)
		case "sweep5":
			t := randomTopos(5, *count, 1000+seed)
			rs = append(sweep(p, "sweep5", 5, t, false), sweep(p, "sweep5-crash", 5, t, true)...)
		case "ablate":
			for _, pv := range []bool{false, true} {
				for _, cq := range []bool{false, true} {
					q := p
					q.PreVote, q.CheckQuorum = pv, cq
					rs = append(rs, sweep(q, fmt.Sprintf("ablate pv=%v cq=%v", pv, cq), 3, allTopos3(), false)...)
					rs = append(rs, sweep(q, fmt.Sprintf("ablate-crash pv=%v cq=%v", pv, cq), 3, allTopos3(), true)...)
				}
			}
		case "transfer":
			rs = transfer(p)
		case "slow":
			rs = slow(p)
		}
		for _, r := range rs {
			_ = enc.Encode(r)
		}
	}
}
