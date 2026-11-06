// respbench: a port of redis-benchmark's load loop (N clients, each with one connection, a fixed
// pipeline depth, random keys in a key space, a fixed value size), written for one row that
// redis-benchmark cannot drive: SET followed by WAIT (Redis's way to wait until replicas have a
// write). It also runs plain SET, GET and INCR, so it can be checked against redis-benchmark on the
// same server. Latency = from the write of a pipeline batch to the read of each reply (as in
// redis-benchmark). Only the Go standard library. Output: one JSON line.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"net"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"
)

func bulk(b []byte, s string) []byte {
	b = append(b, '$')
	b = strconv.AppendInt(b, int64(len(s)), 10)
	b = append(b, '\r', '\n')
	b = append(b, s...)
	return append(b, '\r', '\n')
}

func cmd(b []byte, args ...string) []byte {
	b = append(b, '*')
	b = strconv.AppendInt(b, int64(len(args)), 10)
	b = append(b, '\r', '\n')
	for _, a := range args {
		b = bulk(b, a)
	}
	return b
}

// readReply reads one RESP reply (simple, error, integer, bulk; no arrays needed here).
func readReply(r *bufio.Reader) (bool, error) {
	line, err := r.ReadSlice('\n')
	if err != nil {
		return false, err
	}
	switch line[0] {
	case '+', ':':
		return true, nil
	case '-':
		return false, nil
	case '$':
		n, _ := strconv.Atoi(string(line[1 : len(line)-2]))
		if n < 0 {
			return true, nil
		}
		if _, err := r.Discard(n + 2); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, fmt.Errorf("unexpected reply %q", line)
}

func pct(s []time.Duration, p float64) float64 {
	if len(s) == 0 {
		return 0
	}
	return float64(s[int(p*float64(len(s)-1))].Nanoseconds()) / 1e6
}

func main() {
	addr := flag.String("addr", "127.0.0.1:6379", "server")
	clients := flag.Int("clients", 200, "connections")
	pipe := flag.Int("pipeline", 1, "requests in flight per connection")
	size := flag.Int("size", 100, "value bytes")
	keys := flag.Int("keyspace", 100000, "random keys 0..keyspace-1")
	op := flag.String("op", "set", "set | get | incr")
	wait := flag.Int("wait", 0, "if > 0, send WAIT <n> <timeout> after every SET; the request ends at WAIT's reply")
	waitTO := flag.Int("wait-timeout", 0, "WAIT timeout in ms (0 = block until n replicas acknowledge)")
	dur := flag.Duration("duration", 20*time.Second, "measured time")
	warm := flag.Duration("warmup", 2*time.Second, "warm-up, not measured")
	flag.Parse()

	val := make([]byte, *size)
	for i := range val {
		val[i] = 'x'
	}
	vs := string(val)
	start := time.Now()
	from, end := start.Add(*warm), start.Add(*warm+*dur)
	var mu sync.Mutex
	var all []time.Duration
	var bad, ops int
	var wg sync.WaitGroup
	for c := 0; c < *clients; c++ {
		wg.Add(1)
		go func(c int) {
			defer wg.Done()
			conn, err := net.Dial("tcp", *addr)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			conn.(*net.TCPConn).SetNoDelay(true)
			r := bufio.NewReaderSize(conn, 1<<16)
			rng := rand.New(rand.NewSource(int64(c) + 1))
			lat := make([]time.Duration, 0, 1<<16)
			buf := make([]byte, 0, 1<<16)
			nbad := 0
			per := 1
			if *wait > 0 && *op == "set" {
				per = 2
			}
			for {
				t0 := time.Now()
				if t0.After(end) {
					break
				}
				buf = buf[:0]
				for i := 0; i < *pipe; i++ {
					k := fmt.Sprintf("key:%012d", rng.Intn(*keys))
					switch *op {
					case "set":
						buf = cmd(buf, "SET", k, vs)
						if per == 2 {
							buf = cmd(buf, "WAIT", strconv.Itoa(*wait), strconv.Itoa(*waitTO))
						}
					case "get":
						buf = cmd(buf, "GET", k)
					case "incr":
						buf = cmd(buf, "INCR", "counter:"+k[4:])
					}
				}
				if _, err := conn.Write(buf); err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(1)
				}
				for i := 0; i < *pipe; i++ {
					ok := true
					for j := 0; j < per; j++ {
						good, err := readReply(r)
						if err != nil {
							fmt.Fprintln(os.Stderr, err)
							os.Exit(1)
						}
						ok = ok && good
					}
					t := time.Now()
					if !ok {
						nbad++
					}
					if t0.After(from) && t.Before(end) {
						lat = append(lat, t.Sub(t0))
					}
				}
			}
			conn.Close()
			mu.Lock()
			all = append(all, lat...)
			bad += nbad
			ops += len(lat)
			mu.Unlock()
		}(c)
	}
	wg.Wait()
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })
	out := map[string]any{"op": *op, "wait": *wait, "clients": *clients, "pipeline": *pipe, "size": *size,
		"seconds": dur.Seconds(), "requests": ops, "ops_s": float64(ops) / dur.Seconds(), "error_replies": bad,
		"p50": pct(all, .5), "p95": pct(all, .95), "p99": pct(all, .99), "p999": pct(all, .999), "max": pct(all, 1)}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
