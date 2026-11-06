// lockbench: a short Go loop over etcd's concurrency.Mutex (QUESTIONS.md E-09e: "locks via stm or a
// short Go loop over concurrency.Mutex"). Each client holds one session (one lease) and loops:
// Lock, Unlock. It records the acquire time (Lock returns) and the whole cycle (Lock + Unlock).
// With -locks 0 every client takes its own lock name (no contention: the "acquire <= C" case);
// with -locks N the clients share N names (contention).
// Output: one JSON line on stdout.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

func pct(s []time.Duration, p float64) float64 {
	if len(s) == 0 {
		return 0
	}
	i := int(p * float64(len(s)-1))
	return float64(s[i].Microseconds()) / 1000.0
}

func main() {
	eps := flag.String("endpoints", "127.0.0.1:2379", "comma-separated endpoints")
	clients := flag.Int("clients", 1, "concurrent clients (each with its own session)")
	conns := flag.Int("conns", 1, "gRPC connections shared by the clients")
	locks := flag.Int("locks", 0, "distinct lock names; 0 = one per client (no contention)")
	dur := flag.Duration("duration", 20*time.Second, "measured time")
	warm := flag.Duration("warmup", 2*time.Second, "warm-up time, not measured")
	flag.Parse()

	ctx := context.Background()
	cs := make([]*clientv3.Client, *conns)
	for i := range cs {
		c, err := clientv3.New(clientv3.Config{Endpoints: strings.Split(*eps, ","), DialTimeout: 5 * time.Second})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		cs[i] = c
	}
	var mu sync.Mutex
	var acq, cyc []time.Duration
	var wg sync.WaitGroup
	start := time.Now()
	measFrom := start.Add(*warm)
	end := measFrom.Add(*dur)
	errs := 0
	for i := 0; i < *clients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, err := concurrency.NewSession(cs[i%len(cs)], concurrency.WithTTL(10))
			if err != nil {
				mu.Lock()
				errs++
				mu.Unlock()
				return
			}
			defer s.Close()
			name := fmt.Sprintf("/lockbench/%d", i)
			if *locks > 0 {
				name = fmt.Sprintf("/lockbench/%d", i%*locks)
			}
			m := concurrency.NewMutex(s, name)
			var a, c []time.Duration
			for {
				t0 := time.Now()
				if t0.After(end) {
					break
				}
				if err := m.Lock(ctx); err != nil {
					mu.Lock()
					errs++
					mu.Unlock()
					continue
				}
				t1 := time.Now()
				if err := m.Unlock(ctx); err != nil {
					mu.Lock()
					errs++
					mu.Unlock()
					continue
				}
				t2 := time.Now()
				if t0.After(measFrom) && t2.Before(end) {
					a = append(a, t1.Sub(t0))
					c = append(c, t2.Sub(t0))
				}
			}
			mu.Lock()
			acq = append(acq, a...)
			cyc = append(cyc, c...)
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	sort.Slice(acq, func(i, j int) bool { return acq[i] < acq[j] })
	sort.Slice(cyc, func(i, j int) bool { return cyc[i] < cyc[j] })
	out := map[string]any{
		"clients": *clients, "conns": *conns, "locks": *locks, "seconds": dur.Seconds(),
		"cycles": len(cyc), "cycles_per_s": float64(len(cyc)) / dur.Seconds(), "errors": errs,
		"acquire_ms": map[string]float64{"p50": pct(acq, .5), "p90": pct(acq, .9), "p99": pct(acq, .99), "p999": pct(acq, .999), "max": pct(acq, 1)},
		"cycle_ms":   map[string]float64{"p50": pct(cyc, .5), "p90": pct(cyc, .9), "p99": pct(cyc, .99), "p999": pct(cyc, .999), "max": pct(cyc, 1)},
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
	for _, c := range cs {
		c.Close()
	}
}
