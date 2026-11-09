// E-11 host in Go on etcd's raft (c51f010, from $SP/dl/raftsrc/raft): one process hosts one
// replica of each of N groups. Three such processes make N three-replica groups.
// One TCP link per peer, one ticker for all groups, one journal per process (one write + one
// fdatasync per loop round that has anything to persist), etcd's contract: persist, then send.
//
// mode=tick : every group ticks every tick.ms (HeartbeatTick 1, ElectionTick elect).
// mode=quiet: the draft's quiet groups (DESIGN-V5 "Quiet shards", CockroachDB's quiesced
//
//	ranges): a leader whose group had no proposal for 2 ticks and whose voters all have
//	its commit index sends "quiet at c" to its followers and stops ticking the group; a
//	follower at c stops ticking it too. A proposal, or any raft message other than a
//	response, wakes it. Each pair of processes exchanges one link ping every ping.ms
//	when no other frame went that way.
//
// Load: rate= writes/s over the whole cluster (each process proposes to the groups it leads, in
// proportion), hot= the fraction of groups that get writes. Payload 100 B: [origin id][f64 ms].
//
// Wire frame: u32 body length, u32 count, then count items of u32 group (|quietFlag), u32 len, bytes.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.etcd.io/raft/v3"
	pb "go.etcd.io/raft/v3/raftpb"
	"go.etcd.io/raft/v3/tracker"
	"google.golang.org/protobuf/proto"
)

const quietFlag = 0x80000000
const wakeFlag = 0x40000000

type group struct {
	rn       *raft.RawNode
	st       *raft.MemoryStorage
	quiet    bool
	active   bool
	idle     int
	proposed bool
	dirty    bool
}

type item struct {
	g    uint32
	data []byte
}

var (
	id, n, nPeers                             int
	mode                                      string
	tickMs, electTicks, pingMs                int
	rate, hot                                 float64
	size                                      int
	warm, dur                                 float64
	ports                                     []int
	dir                                       string
	fsyncOn                                   bool
	groups                                    []*group
	activeList                                []int
	dirtyList                                 []int
	peers                                     []net.Conn
	out                                       [][]byte
	outCount                                  []uint32
	lastSent                                  []time.Time
	journal                                   *os.File
	jbuf                                      []byte
	t0                                        time.Time
	measuring, started                        bool
	ws, we                                    time.Time
	frames, msgs, bytesOut, fsyncs, proposals uint64
	hist                                      [3200]uint64
	histN                                     uint64
	ledHot                                    []int
	made                                      float64
	genStart                                  time.Time
)

func hidx(us float64) int {
	if us < 0 {
		us = 0
	}
	v := uint32(us)
	if v < 256 {
		return int(v)
	}
	e := 31 - leadingZeros(v)
	sh := e - 7
	return 256 + int((e-8)*128) + int((v>>sh)-128)
}
func leadingZeros(v uint32) uint32 {
	n := uint32(0)
	for i := 31; i >= 0; i-- {
		if v&(1<<uint(i)) != 0 {
			return n
		}
		n++
	}
	return 32
}
func hval(i int) float64 {
	if i < 256 {
		return float64(i) + 0.5
	}
	e := uint32((i-256)/128) + 8
	m := uint32((i-256)%128) + 128
	sh := e - 7
	return float64(m<<sh) + float64(uint32(1)<<sh)/2
}
func pct(p float64) float64 {
	if histN == 0 {
		return -1
	}
	want := uint64(math.Ceil(p * float64(histN)))
	c := uint64(0)
	for i := 0; i < len(hist); i++ {
		c += hist[i]
		if c >= want {
			return hval(i) / 1000
		}
	}
	return -1
}

func arg(m map[string]string, k, d string) string {
	if v, ok := m[k]; ok {
		return v
	}
	return d
}

func main() {
	a := map[string]string{}
	for _, s := range os.Args[1:] {
		kv := strings.SplitN(s, "=", 2)
		a[kv[0]] = kv[1]
	}
	id, _ = strconv.Atoi(arg(a, "id", "1"))
	n, _ = strconv.Atoi(arg(a, "n", "10"))
	mode = arg(a, "mode", "tick")
	tickMs, _ = strconv.Atoi(arg(a, "tick", "100"))
	electTicks, _ = strconv.Atoi(arg(a, "elect", "10"))
	pingMs, _ = strconv.Atoi(arg(a, "ping", "500"))
	rate, _ = strconv.ParseFloat(arg(a, "rate", "0"), 64)
	hot, _ = strconv.ParseFloat(arg(a, "hot", "1"), 64)
	size, _ = strconv.Atoi(arg(a, "size", "100"))
	warm, _ = strconv.ParseFloat(arg(a, "warm", "3000"), 64)
	dur, _ = strconv.ParseFloat(arg(a, "dur", "10000"), 64)
	dir = arg(a, "dir", "/tmp")
	fsyncOn = arg(a, "fsync", "1") == "1"
	for _, p := range strings.Split(arg(a, "ports", "17001,17002,17003"), ",") {
		v, _ := strconv.Atoi(p)
		ports = append(ports, v)
	}
	nPeers = len(ports)
	tStart := time.Now()
	os.MkdirAll(dir, 0o755)
	var err error
	journal, err = os.OpenFile(fmt.Sprintf("%s/journal-%d", dir, id), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		panic(err)
	}

	// groups: every replica starts from the same snapshot naming voters 1..3 (as etcd's harness does)
	voters := []uint64{}
	for i := 1; i <= nPeers; i++ {
		voters = append(voters, uint64(i))
	}
	groups = make([]*group, n)
	for g := 0; g < n; g++ {
		st := raft.NewMemoryStorage()
		st.ApplySnapshot(&pb.Snapshot{Metadata: &pb.SnapshotMetadata{Index: proto.Uint64(1), Term: proto.Uint64(1), ConfState: &pb.ConfState{Voters: voters}}})
		rn, err := raft.NewRawNode(&raft.Config{ID: uint64(id), ElectionTick: electTicks, HeartbeatTick: 1, Storage: st, Applied: 1,
			MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discard{}})
		if err != nil {
			panic(err)
		}
		groups[g] = &group{rn: rn, st: st, active: true}
		activeList = append(activeList, g)
	}

	// links: listen; connect to every peer with a higher id; accept the lower ones
	in := make(chan []item, 4096)
	peers = make([]net.Conn, nPeers)
	out = make([][]byte, nPeers)
	outCount = make([]uint32, nPeers)
	lastSent = make([]time.Time, nPeers)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", ports[id-1]))
	if err != nil {
		panic(err)
	}
	acc := make(chan net.Conn, nPeers)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			acc <- c
		}
	}()
	for p := id + 1; p <= nPeers; p++ {
		var c net.Conn
		for {
			c, err = net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", ports[p-1]))
			if err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		c.(*net.TCPConn).SetNoDelay(true)
		var hello [4]byte
		binary.LittleEndian.PutUint32(hello[:], uint32(id))
		c.Write(hello[:])
		peers[p-1] = c
	}
	for k := 1; k < id; k++ {
		c := <-acc
		c.(*net.TCPConn).SetNoDelay(true)
		var hello [4]byte
		io.ReadFull(c, hello[:])
		peers[binary.LittleEndian.Uint32(hello[:])-1] = c
	}
	for p, c := range peers {
		if c == nil {
			continue
		}
		go reader(c, in)
		lastSent[p] = time.Now()
	}

	// campaign the groups this process should lead
	for g := 0; g < n; g++ {
		if g%nPeers == id-1 {
			groups[g].rn.Campaign()
			markDirty(g)
		}
	}

	ctl := make(chan string, 4)
	go func() {
		r := bufio.NewReader(os.Stdin)
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				return
			}
			ctl <- strings.TrimSpace(l)
		}
	}()

	tick := time.NewTicker(time.Duration(tickMs) * time.Millisecond)
	gen := time.NewTicker(time.Millisecond)
	if rate == 0 {
		gen.Stop()
	}
	readyCheck := time.NewTicker(200 * time.Millisecond)
	var wsC, weC <-chan time.Time
	var readyMs float64
	ready := false
	var cpu0 float64
	var cpuW float64
	var pre map[string]float64
	for {
		select {
		case f := <-in:
			handleItems(f)
		case <-tick.C:
			doTick()
		case <-gen.C:
			doGen()
		case <-readyCheck.C:
			if !ready && allLed() {
				ready = true
				readyMs = float64(time.Since(tStart).Microseconds()) / 1000
				fmt.Println("ready")
				readyCheck.Stop()
			}
		case <-wsC:
		case <-weC:
		case l := <-ctl:
			if strings.HasPrefix(l, "go") {
				t0 = time.Now()
				ws = t0.Add(time.Duration(warm * float64(time.Millisecond)))
				we = ws.Add(time.Duration(dur * float64(time.Millisecond)))
				started = true
				genStart = time.Now()
				made = 0
				refreshLed()
				wsC = time.After(time.Duration(warm * float64(time.Millisecond)))
				weC = time.After(time.Duration((warm + dur) * float64(time.Millisecond)))
			}
		}
	drain:
		for {
			select {
			case f := <-in:
				handleItems(f)
			default:
				break drain
			}
		}
		processReady()
		if started {
			now := time.Now()
			if !measuring && !now.Before(ws) && cpu0 == 0 {
				measuring = true
				cpu0 = cpuSeconds()
				pre = netCounters()
			}
			if measuring && !now.Before(we) {
				measuring = false
				cpuW = cpuSeconds() - cpu0
				_ = pre
				report(cpuW, readyMs)
				// keep serving the peers for a moment so they finish their windows cleanly
				end := time.Now().Add(1500 * time.Millisecond)
				for time.Now().Before(end) {
					select {
					case f := <-in:
						handleItems(f)
					case <-tick.C:
						doTick()
					case <-time.After(10 * time.Millisecond):
					}
					processReady()
				}
				os.Exit(0)
			}
		}
	}
}

type discard struct{}

func (discard) Debug(v ...interface{})                   {}
func (discard) Debugf(format string, v ...interface{})   {}
func (discard) Error(v ...interface{})                   {}
func (discard) Errorf(format string, v ...interface{})   {}
func (discard) Info(v ...interface{})                    {}
func (discard) Infof(format string, v ...interface{})    {}
func (discard) Warning(v ...interface{})                 {}
func (discard) Warningf(format string, v ...interface{}) {}
func (discard) Fatal(v ...interface{})                   { panic(fmt.Sprint(v...)) }
func (discard) Fatalf(format string, v ...interface{})   { panic(fmt.Sprintf(format, v...)) }
func (discard) Panic(v ...interface{})                   { panic(fmt.Sprint(v...)) }
func (discard) Panicf(format string, v ...interface{})   { panic(fmt.Sprintf(format, v...)) }

func reader(c net.Conn, in chan []item) {
	r := bufio.NewReaderSize(c, 1<<20)
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		body := make([]byte, binary.LittleEndian.Uint32(hdr[:]))
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		cnt := binary.LittleEndian.Uint32(body[0:4])
		items := make([]item, 0, cnt)
		off := 4
		for i := uint32(0); i < cnt; i++ {
			g := binary.LittleEndian.Uint32(body[off:])
			l := int(binary.LittleEndian.Uint32(body[off+4:]))
			items = append(items, item{g: g, data: body[off+8 : off+8+l]})
			off += 8 + l
		}
		in <- items
	}
}

func markDirty(g int) {
	gr := groups[g]
	if !gr.dirty {
		gr.dirty = true
		dirtyList = append(dirtyList, g)
	}
}

func wake(g int) {
	gr := groups[g]
	if gr.quiet {
		gr.quiet = false
		gr.idle = 0
		if !gr.active {
			gr.active = true
			activeList = append(activeList, g)
		}
	}
}

func handleItems(items []item) {
	for _, it := range items {
		if it.g&quietFlag != 0 {
			g := int(it.g &^ quietFlag)
			c := binary.LittleEndian.Uint64(it.data)
			if groups[g].rn.BasicStatus().HardState.GetCommit() >= c {
				groups[g].quiet = true
			} else {
				// behind the leader's quiet point: ask it to wake (CockroachDB's lagging-follower rule)
				lead := groups[g].rn.BasicStatus().Lead
				if lead != 0 {
					queueItem(int(lead)-1, uint32(g)|wakeFlag, nil)
				}
			}
			continue
		}
		if it.g&wakeFlag != 0 {
			g := int(it.g &^ wakeFlag)
			wake(g)
			markDirty(g)
			continue
		}
		g := int(it.g)
		m := &pb.Message{}
		if err := proto.Unmarshal(it.data, m); err != nil {
			panic(err)
		}
		t := m.GetType()
		if t != pb.MessageType_MsgHeartbeatResp && t != pb.MessageType_MsgAppResp {
			wake(g)
		}
		groups[g].rn.Step(m)
		markDirty(g)
	}
}

func doTick() {
	now := time.Now()
	keep := activeList[:0]
	for _, g := range activeList {
		gr := groups[g]
		if gr.quiet {
			gr.active = false
			continue
		}
		if mode == "quiet" {
			bs := gr.rn.BasicStatus()
			if bs.RaftState == raft.StateLeader {
				matched := true
				gr.rn.WithProgress(func(pid uint64, typ raft.ProgressType, pr tracker.Progress) {
					if pr.Match != bs.HardState.GetCommit() {
						matched = false
					}
				})
				if matched && !gr.proposed && !gr.dirty {
					gr.idle++
				} else {
					gr.idle = 0
				}
				gr.proposed = false
				if gr.idle >= 2 {
					gr.quiet = true
					gr.active = false
					var cb [8]byte
					binary.LittleEndian.PutUint64(cb[:], bs.HardState.GetCommit())
					for p := 1; p <= nPeers; p++ {
						if p != id {
							queueItem(p-1, uint32(g)|quietFlag, cb[:])
						}
					}
					continue
				}
			}
		}
		gr.rn.Tick()
		markDirty(g)
		keep = append(keep, g)
	}
	activeList = keep
	// link pings: one empty frame per peer when nothing else went that way for ping.ms
	for p := 0; p < nPeers; p++ {
		if p != id-1 && outCount[p] == 0 && now.Sub(lastSent[p]) >= time.Duration(pingMs)*time.Millisecond {
			flushPeer(p, true)
		}
	}
}

func refreshLed() {
	ledHot = ledHot[:0]
	hotN := int(math.Max(1, math.Ceil(float64(n)*hot)))
	for g := 0; g < hotN; g++ {
		if groups[g].rn.BasicStatus().RaftState == raft.StateLeader {
			ledHot = append(ledHot, g)
		}
	}
}

var rng uint32 = 0x9e3779b9

func doGen() {
	if !started || len(ledHot) == 0 || time.Now().After(we) {
		return
	}
	hotN := math.Max(1, math.Ceil(float64(n)*hot))
	myRate := rate * float64(len(ledHot)) / hotN
	el := float64(time.Since(genStart).Microseconds()) / 1000
	due := math.Floor(el * myRate / 1000)
	for made < due {
		rng ^= rng << 13
		rng ^= rng >> 17
		rng ^= rng << 5
		g := ledHot[int(float64(rng)/4294967296*float64(len(ledHot)))]
		arrival := float64(genStart.UnixNano())/1e6 + made*1000/myRate
		data := make([]byte, size)
		data[0] = byte(id)
		binary.LittleEndian.PutUint64(data[1:9], math.Float64bits(arrival))
		gr := groups[g]
		wake(g)
		gr.proposed = true
		if gr.rn.Propose(data) == nil && measuring {
			proposals++
		}
		markDirty(g)
		made++
	}
}

func queueItem(p int, g uint32, data []byte) {
	var h [8]byte
	binary.LittleEndian.PutUint32(h[0:4], g)
	binary.LittleEndian.PutUint32(h[4:8], uint32(len(data)))
	if len(out[p]) == 0 {
		out[p] = append(out[p], 0, 0, 0, 0, 0, 0, 0, 0) // frame length + count, filled at flush
	}
	out[p] = append(out[p], h[:]...)
	out[p] = append(out[p], data...)
	outCount[p]++
}

func flushPeer(p int, ping bool) {
	b := out[p]
	if ping {
		b = []byte{4, 0, 0, 0, 0, 0, 0, 0}
	} else {
		binary.LittleEndian.PutUint32(b[0:4], uint32(len(b)-4))
		binary.LittleEndian.PutUint32(b[4:8], outCount[p])
	}
	if _, err := peers[p].Write(b); err != nil {
		panic(err)
	}
	if measuring {
		frames++
		msgs += uint64(outCount[p])
		bytesOut += uint64(len(b))
	}
	lastSent[p] = time.Now()
	out[p] = out[p][:0]
	outCount[p] = 0
}

func processReady() {
	for pass := 0; pass < 4 && len(dirtyList) > 0; pass++ {
		list := dirtyList
		dirtyList = nil
		type rdy struct {
			g  int
			rd raft.Ready
		}
		var rds []rdy
		jbuf = jbuf[:0]
		for _, g := range list {
			gr := groups[g]
			gr.dirty = false
			if !gr.rn.HasReady() {
				continue
			}
			rd := gr.rn.Ready()
			rds = append(rds, rdy{g, rd})
			// persist into the in-memory log and the journal buffer
			if !raft.IsEmptyHardState(rd.HardState) {
				gr.st.SetHardState(rd.HardState)
				var hb [28]byte
				binary.LittleEndian.PutUint32(hb[0:], uint32(g))
				binary.LittleEndian.PutUint64(hb[4:], rd.HardState.GetTerm())
				binary.LittleEndian.PutUint64(hb[12:], rd.HardState.GetVote())
				binary.LittleEndian.PutUint64(hb[20:], rd.HardState.GetCommit())
				jbuf = append(jbuf, hb[:]...)
			}
			if len(rd.Entries) > 0 {
				gr.st.Append(rd.Entries)
				for _, e := range rd.Entries {
					var eh [24]byte
					binary.LittleEndian.PutUint32(eh[0:], uint32(g))
					binary.LittleEndian.PutUint64(eh[4:], e.GetTerm())
					binary.LittleEndian.PutUint64(eh[12:], e.GetIndex())
					binary.LittleEndian.PutUint32(eh[20:], uint32(len(e.GetData())))
					jbuf = append(jbuf, eh[:]...)
					jbuf = append(jbuf, e.GetData()...)
				}
			}
		}
		if len(jbuf) > 0 {
			if _, err := journal.Write(jbuf); err != nil {
				panic(err)
			}
			if fsyncOn {
				syscall.Fdatasync(int(journal.Fd()))
				if measuring {
					fsyncs++
				}
			}
		}
		// send
		for _, r := range rds {
			for _, m := range r.rd.Messages {
				b, err := proto.Marshal(m)
				if err != nil {
					panic(err)
				}
				queueItem(int(m.GetTo())-1, uint32(r.g), b)
			}
		}
		for p := 0; p < nPeers; p++ {
			if outCount[p] > 0 {
				flushPeer(p, false)
			}
		}
		// apply
		now := float64(time.Now().UnixNano()) / 1e6
		for _, r := range rds {
			for _, e := range r.rd.CommittedEntries {
				d := e.GetData()
				if e.GetType() == pb.EntryType_EntryNormal && len(d) >= 9 && int(d[0]) == id {
					at := math.Float64frombits(binary.LittleEndian.Uint64(d[1:9]))
					if measuring && at >= float64(ws.UnixNano())/1e6 {
						hist[hidx((now-at)*1000)]++
						histN++
					}
				}
			}
			groups[r.g].rn.Advance(r.rd)
			if groups[r.g].rn.HasReady() {
				markDirty(r.g)
			}
		}
	}
}

func allLed() bool {
	for _, gr := range groups {
		if gr.rn.BasicStatus().Lead == 0 {
			return false
		}
	}
	return true
}

func cpuSeconds() float64 {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6 + float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
}

func netCounters() map[string]float64 { return nil }

func rssKB() int {
	b, _ := os.ReadFile("/proc/self/status")
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "VmRSS:") {
			f := strings.Fields(l)
			v, _ := strconv.Atoi(f[1])
			return v
		}
	}
	return 0
}

func report(cpuW float64, readyMs float64) {
	win := dur / 1000
	leaders, active := 0, 0
	for _, gr := range groups {
		if gr.rn.BasicStatus().RaftState == raft.StateLeader {
			leaders++
		}
		if !gr.quiet {
			active++
		}
	}
	rss := rssKB()
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	la, _ := os.ReadFile("/proc/loadavg")
	res := map[string]interface{}{
		"impl": "go", "id": id, "n": n, "mode": mode, "tick": tickMs, "elect": electTicks, "rate": rate, "hot": hot,
		"leaders": leaders, "awake_end": active, "ready_ms": readyMs,
		"cores": cpuW / win, "frames_s": float64(frames) / win, "msgs_s": float64(msgs) / win, "bytes_s": float64(bytesOut) / win,
		"fsyncs_s": float64(fsyncs) / win, "proposals_s": float64(proposals) / win, "commits_s": float64(histN) / win,
		"p50": pct(0.5), "p99": pct(0.99), "p999": pct(0.999), "max": pct(1),
		"rss_kb": rss, "heap_kb": ms.HeapInuse / 1024, "loadavg": strings.TrimSpace(string(la)),
	}
	j, _ := json.Marshal(res)
	fmt.Println(string(j))
}
