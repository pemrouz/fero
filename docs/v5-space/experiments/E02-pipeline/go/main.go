// E-02: the minimal replication pipeline in Go (goroutines on the Go runtime, GOMAXPROCS default).
// Same protocol, journal format, batching and commit rule as ts/pipeline.ts (see there).
// Goroutines per process: the kernel (leader: generate, frame, send, commit; follower: read,
// check, hand to disk), one disk goroutine (writev + fdatasync, group commit) and one ack
// reader per follower link (leader).
package main

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"math"
	"net"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const HDR, RH = 20, 12

type Opts struct {
	role, dir, mode, emu          string
	id, size, groups, capBytes    int
	port                          int
	peers                         []int
	rate, start, warm, dur, drain float64
	seg                           int64
}

func parse() Opts {
	o := Opts{role: "leader", dir: ".", mode: "persisted", size: 100, groups: 1, warm: 2000, dur: 8000, drain: 1000, capBytes: 32 << 20}
	for _, a := range os.Args[1:] {
		k, v, _ := strings.Cut(a, "=")
		atoi := func() int {
			n, err := strconv.Atoi(v)
			if err != nil {
				panic(a)
			}
			return n
		}
		atof := func() float64 {
			f, err := strconv.ParseFloat(v, 64)
			if err != nil {
				panic(a)
			}
			return f
		}
		switch k {
		case "role":
			o.role = v
		case "id":
			o.id = atoi()
		case "port":
			o.port = atoi()
		case "peers":
			for _, p := range strings.Split(v, ",") {
				if p != "" {
					n, _ := strconv.Atoi(p)
					o.peers = append(o.peers, n)
				}
			}
		case "dir":
			o.dir = v
		case "mode":
			o.mode = v
		case "size":
			o.size = atoi()
		case "groups":
			o.groups = atoi()
		case "rate":
			o.rate = atof()
		case "start":
			o.start = atof()
		case "warm":
			o.warm = atof()
		case "dur":
			o.dur = atof()
		case "drain":
			o.drain = atof()
		case "seg":
			o.seg = int64(atoi())
		case "emu":
			o.emu = v
		case "capBytes":
			o.capBytes = atoi()
		case "workers", "addon":
		default:
			panic("unknown option " + k)
		}
	}
	return o
}

type Win struct{ start, ws, we, end time.Time }

func window(o Opts) Win {
	now := time.Now()
	nowMs := float64(now.UnixNano()) / 1e6
	at := func(ms float64) time.Time { return now.Add(time.Duration((ms - nowMs) * 1e6)) }
	return Win{at(o.start), at(o.start + o.warm), at(o.start + o.warm + o.dur), at(o.start + o.warm + o.dur + o.drain)}
}

func cpuUs() int64 {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return ru.Utime.Sec*1e6 + ru.Utime.Usec + ru.Stime.Sec*1e6 + ru.Stime.Usec
}

func rd(b []byte, off int) uint32 { return binary.LittleEndian.Uint32(b[off:]) }

func sampler(path string) func() int64 {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var t []float64
	for _, l := range strings.Split(string(data), "\n") {
		if l == "" || l[0] == '#' {
			continue
		}
		f, _ := strconv.ParseFloat(l, 64)
		t = append(t, f)
	}
	s := uint32(0x9e3779b9) ^ uint32(os.Getpid())*2654435761
	if s == 0 {
		s = 1
	}
	return func() int64 {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		return int64(math.Round(t[int(float64(s)/4294967296.0*float64(len(t)))]))
	}
}

type item struct {
	seq uint32
	b   []byte
}

// disk goroutine: group commit. done(seq) runs after the batch is written (and synced).
func spawnDisk(o Opts, path string, done func(uint32), flushes *atomic.Int64) chan item {
	ch := make(chan item, 1<<16)
	go func() {
		runtime.LockOSThread()
		flags := os.O_WRONLY
		if o.seg == 0 {
			flags |= os.O_CREATE | os.O_TRUNC
		}
		f, err := os.OpenFile(path, flags, 0644)
		if err != nil {
			panic(err)
		}
		fd := int(f.Fd())
		sample := sampler(o.emu)
		if sample != nil {
			syscall.RawSyscall(syscall.SYS_PRCTL, 29 /* PR_SET_TIMERSLACK */, 1000, 0)
		}
		var pos int64
		var bufs [][]byte
		for it := range ch {
			bufs = append(bufs[:0], it.b)
			seq := it.seq
		drain:
			for {
				select {
				case x := <-ch:
					bufs = append(bufs, x.b)
					seq = x.seq
				default:
					break drain
				}
			}
			total := 0
			for _, b := range bufs {
				total += len(b)
			}
			if o.seg > 0 && pos+int64(total) > o.seg {
				pos = 0
			}
			for i := 0; i < len(bufs); i += 1024 {
				part := bufs[i:min(i+1024, len(bufs))]
				iov := make([]syscall.Iovec, len(part))
				want := 0
				for j, b := range part {
					iov[j].Base = &b[0]
					iov[j].SetLen(len(b))
					want += len(b)
				}
				var n uintptr
				var e syscall.Errno
				if o.seg > 0 {
					n, _, e = syscall.Syscall6(syscall.SYS_PWRITEV, uintptr(fd), uintptr(unsafe.Pointer(&iov[0])), uintptr(len(iov)), uintptr(pos), 0, 0)
				} else {
					n, _, e = syscall.Syscall(syscall.SYS_WRITEV, uintptr(fd), uintptr(unsafe.Pointer(&iov[0])), uintptr(len(iov)))
				}
				if e != 0 || int(n) != want {
					panic(fmt.Sprintf("short write %d of %d: %v", n, want, e))
				}
				pos += int64(n)
			}
			if o.mode != "memory" {
				if err := syscall.Fdatasync(fd); err != nil {
					panic(err)
				}
				if sample != nil {
					us := sample()
					ts := syscall.NsecToTimespec(us * 1000)
					syscall.Nanosleep(&ts, nil)
				}
			}
			flushes.Add(1)
			runtime.KeepAlive(f) // f's finalizer would close fd: we use the raw fd above
			done(seq)
		}
	}()
	return ch
}

type ev struct {
	kind int
	i    int
	seq  uint32
} // kind 0 = ack from follower i, 1 = durable

type batch struct {
	b []byte
	t time.Time
	w bool
}

func weightedPct(lat [][2]float64, ps []float64) []float64 {
	sort.Slice(lat, func(i, j int) bool { return lat[i][0] < lat[j][0] })
	tot := 0.0
	for _, x := range lat {
		tot += x[1]
	}
	out := make([]float64, len(ps))
	for k, p := range ps {
		acc, target := 0.0, p*tot
		out[k] = math.NaN()
		for _, x := range lat {
			acc += x[1]
			if acc >= target {
				out[k] = x[0]
				break
			}
		}
		if math.IsNaN(out[k]) && len(lat) > 0 {
			out[k] = lat[len(lat)-1][0]
		}
	}
	return out
}

func leader(o Opts) {
	win := window(o)
	evs := make(chan ev, 1<<16)
	var socks []net.Conn
	if o.mode == "persisted" || o.mode == "memory" {
		for i, p := range o.peers {
			var c net.Conn
			for {
				var err error
				c, err = net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(p))
				if err == nil {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			c.(*net.TCPConn).SetNoDelay(true)
			socks = append(socks, c)
			go func(i int, c net.Conn) {
				b := make([]byte, 4)
				for {
					if _, err := io.ReadFull(c, b); err != nil {
						return
					}
					evs <- ev{0, i, binary.LittleEndian.Uint32(b)}
				}
			}(i, c)
		}
	}
	var flushes atomic.Int64
	var disk chan item
	if o.mode != "none" {
		disk = spawnDisk(o, fmt.Sprintf("%s/j.%d.0", o.dir, o.id), func(s uint32) { evs <- ev{1, 0, s} }, &flushes)
	}
	if time.Now().After(win.start) {
		fmt.Fprintln(os.Stderr, "leader: not connected before start")
	}
	payload := make([]byte, o.size)
	for i := range payload {
		payload[i] = 0x5a
	}
	rec := RH + o.size
	capR := uint64(o.capBytes / rec)
	chunk := max(capR/16, 1)
	G := o.groups
	last := make([]uint32, G)
	cidx := make([]uint32, G)
	var seq, committed, durable uint32
	acked := [2]uint32{}
	var batches []batch
	bhead := 0
	var generated, committedRecs, committedWin, genWin uint64
	var lat [][2]float64
	var cpu0, cpu1 int64
	got0, got1 := false, false
	lateMax, late5, ticks := 0.0, 0, 0
	time.Sleep(time.Until(win.start))
	nextTick := win.start
	var prev time.Time
	timer := time.NewTimer(0)
	for {
		now := time.Now()
		if !got0 && !now.Before(win.ws) {
			cpu0 = cpuUs()
			got0 = true
		}
		if !got1 && !now.Before(win.we) {
			cpu1 = cpuUs()
			got1 = true
		}
		if !now.Before(win.end) {
			break
		}
		if !now.Before(nextTick) {
			if !prev.IsZero() {
				l := float64(now.Sub(prev).Microseconds())/1e3 - 1
				if l > lateMax {
					lateMax = l
				}
				if l > 5 {
					late5++
				}
			}
			prev = now
			ticks++
			nextTick = nextTick.Add(time.Millisecond)
			if !nextTick.After(now) {
				nextTick = now.Add(time.Millisecond)
			}
			if now.Before(win.we) {
				var n uint64
				if o.rate > 0 {
					due := uint64(now.Sub(win.start).Seconds() * o.rate)
					if due > generated {
						n = due - generated
					}
				} else if capR > generated-committedRecs {
					n = min(capR-(generated-committedRecs), chunk) // max: about 16 batches in flight
				}
				if n > 0 {
					b := make([]byte, HDR, HDR+int(n)*rec)
					var h [RH]byte
					for i := uint64(0); i < n; i++ {
						g := int((generated + i) % uint64(G))
						last[g]++
						binary.LittleEndian.PutUint32(h[0:], uint32(g))
						binary.LittleEndian.PutUint32(h[4:], last[g])
						binary.LittleEndian.PutUint32(h[8:], uint32(o.size))
						b = append(b, h[:]...)
						b = append(b, payload...)
					}
					generated += n
					inWin := !now.Before(win.ws) && now.Before(win.we)
					if inWin {
						genWin += n
					}
					seq++
					binary.LittleEndian.PutUint32(b[0:], uint32(len(b)-4))
					binary.LittleEndian.PutUint32(b[8:], seq)
					binary.LittleEndian.PutUint32(b[12:], committed)
					binary.LittleEndian.PutUint32(b[16:], uint32(n))
					binary.LittleEndian.PutUint32(b[4:], crc32.ChecksumIEEE(b[8:]))
					for _, s := range socks {
						if _, err := s.Write(b); err != nil {
							panic(err)
						}
					}
					batches = append(batches, batch{b, now, inWin})
					if disk != nil {
						disk <- item{seq, b}
					}
					if o.mode == "none" || o.mode == "memory" {
						durable = seq
					}
				}
			}
		}
		// wait for an event until the next tick, then drain what is queued
		timer.Reset(time.Until(nextTick))
		select {
		case e := <-evs:
			handle := func(e ev) {
				if e.kind == 0 {
					if e.seq > acked[e.i] {
						acked[e.i] = e.seq
					}
				} else if o.mode != "memory" {
					durable = e.seq
				}
			}
			handle(e)
		more:
			for {
				select {
				case e := <-evs:
					handle(e)
				default:
					break more
				}
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
		}
		var c uint32
		if o.mode == "none" || o.mode == "ldr" {
			c = durable
		} else {
			c = max(min(durable, acked[0]), min(max(durable, acked[0]), acked[1]))
		}
		if c > committed {
			t := time.Now()
			tw := !t.Before(win.ws) && t.Before(win.we)
			for s := committed; s < c; s++ {
				bt := batches[bhead]
				batches[bhead] = batch{}
				bhead++
				count := uint64(rd(bt.b, 16))
				off := HDR
				for r := uint64(0); r < count; r++ {
					cidx[rd(bt.b, off)] = rd(bt.b, off+4)
					off += RH + int(rd(bt.b, off+8))
				}
				committedRecs += count
				if tw {
					committedWin += count
				}
				if bt.w {
					lat = append(lat, [2]float64{float64(t.Sub(bt.t).Nanoseconds()) / 1e6, float64(count)})
				}
			}
			if bhead > 4096 {
				batches = append([]batch(nil), batches[bhead:]...)
				bhead = 0
			}
			committed = c
		}
	}
	p := weightedPct(lat, []float64{0.5, 0.9, 0.99, 0.999, 1})
	latN := 0.0
	for _, x := range lat {
		latN += x[1]
	}
	cpu := cpu1 - cpu0
	secs := o.dur / 1e3
	fl := flushes.Load()
	rpf := 0.0
	if fl > 0 {
		rpf = float64(generated) / float64(fl)
	}
	per := 0.0
	if committedWin > 0 {
		per = float64(cpu) / float64(committedWin)
	}
	fmt.Printf("{\"role\":\"leader\",\"impl\":\"go\",\"go\":\"%s\",\"mode\":\"%s\",\"size\":%d,\"groups\":%d,\"rate\":%g,\"gen_win\":%d,\"committed_win\":%d,\"tput\":%d,\"cpu_ms\":%d,\"cpu_us_per_append\":%.3f,\"cores_used\":%.3f,\"lat_ms\":{\"p50\":%.3f,\"p90\":%.3f,\"p99\":%.3f,\"p999\":%.3f,\"max\":%.3f},\"lat_n\":%d,\"missing\":%d,\"flushes\":%d,\"recs_per_flush\":%.1f,\"ticks\":%d,\"tick_late_max_ms\":%.2f,\"ticks_late_over_5ms\":%d,\"cidx0\":%d}\n",
		runtime.Version(), o.mode, o.size, o.groups, o.rate, genWin, committedWin, uint64(float64(committedWin)/secs), cpu/1000, per,
		float64(cpu)/1e6/secs, p[0], p[1], p[2], p[3], p[4], int64(latN), int64(genWin)-int64(latN), fl, rpf, ticks, lateMax, late5, cidx[0])
	os.Exit(0)
}

func follower(o Opts) {
	win := window(o)
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(o.port))
	if err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stderr, "follower %d ready\n", o.id)
	var received, flushes atomic.Int64
	go func() {
		time.Sleep(time.Until(win.ws))
		c0 := cpuUs()
		time.Sleep(time.Until(win.we))
		c1 := cpuUs()
		time.Sleep(time.Until(win.end.Add(300 * time.Millisecond)))
		r := received.Load()
		cpu := c1 - c0
		per := 0.0
		if r > 0 {
			per = float64(cpu) / float64(r)
		}
		fmt.Printf("{\"role\":\"follower\",\"id\":%d,\"impl\":\"go\",\"received_win\":%d,\"cpu_ms\":%d,\"cpu_us_per_append\":%.3f,\"cores_used\":%.3f,\"flushes\":%d}\n",
			o.id, r, cpu/1000, per, float64(cpu)/1e6/(o.dur/1e3), flushes.Load())
		os.Exit(0)
	}()
	c, err := ln.Accept()
	if err != nil {
		panic(err)
	}
	c.(*net.TCPConn).SetNoDelay(true)
	ackb := make([]byte, 4)
	disk := spawnDisk(o, fmt.Sprintf("%s/j.%d.0", o.dir, o.id), func(s uint32) { binary.LittleEndian.PutUint32(ackb, s); c.Write(ackb) }, &flushes)
	last := make([]uint32, o.groups)
	buf := make([]byte, 4<<20)
	fill := 0
	for {
		if len(buf)-fill < 256*1024 {
			nb := make([]byte, len(buf)*2)
			copy(nb, buf[:fill])
			buf = nb
		}
		n, err := c.Read(buf[fill:])
		if err != nil {
			break
		}
		fill += n
		off, recs := 0, 0
		var seq uint32
		for fill-off >= 4 {
			l := int(rd(buf, off))
			if fill-off-4 < l {
				break
			}
			seq = rd(buf, off+8)
			count := int(rd(buf, off+16))
			r := off + HDR
			for k := 0; k < count; k++ {
				g, idx := rd(buf, r), rd(buf, r+4)
				if idx != last[g]+1 {
					panic(fmt.Sprintf("gap in group %d: %d after %d", g, idx, last[g]))
				}
				last[g] = idx
				r += RH + int(rd(buf, r+8))
			}
			recs += count
			off += 4 + l
		}
		t := time.Now()
		if !t.Before(win.ws) && t.Before(win.we) {
			received.Add(int64(recs))
		}
		if off > 0 {
			done := make([]byte, off)
			copy(done, buf[:off])
			disk <- item{seq, done}
			copy(buf, buf[off:fill])
			fill -= off
		}
	}
	time.Sleep(5 * time.Second)
}

func main() {
	o := parse()
	if o.role == "leader" {
		leader(o)
	} else {
		follower(o)
	}
}
