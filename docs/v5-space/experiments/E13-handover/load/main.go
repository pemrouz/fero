// E-13 load client: a steady put load on an etcd cluster through etcd's own Go client (v3.5.17),
// recording every logical write: when it was first tried, when it was acknowledged, and how many
// attempts it took. A write that fails is retried (same key, same value) until it is acknowledged,
// as a client that "retries by itself" (F-05) would. The driver writes "mark <name>" lines on stdin
// at each event (move-leader, kill -9); the client stamps them on the same monotonic clock.
//
// Output (stdout, at the end): one JSON object with the marks and, per logical write,
// [first try µs, ack µs, attempts, client index], µs since the client started. With -pin, each worker
// keeps to one endpoint (client index = endpoint index); without it, one client balances over all.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

func main() {
	eps := flag.String("endpoints", "127.0.0.1:32379", "comma-separated")
	rate := flag.Float64("rate", 2000, "logical writes per second, over all workers")
	workers := flag.Int("workers", 16, "concurrent writers")
	dur := flag.Duration("dur", 20*time.Second, "how long to write")
	val := flag.Int("val", 256, "value bytes")
	timeout := flag.Duration("timeout", 2*time.Second, "per-attempt timeout")
	pin := flag.Bool("pin", false, "pin worker w to endpoint w % len(endpoints) (one client per endpoint), so a member that cannot reach the leader stalls only its own workers")
	flag.Parse()

	epl := strings.Split(*eps, ",")
	clis := []*clientv3.Client{}
	if *pin {
		for _, e := range epl {
			c, err := clientv3.New(clientv3.Config{Endpoints: []string{e}, DialTimeout: 5 * time.Second})
			if err != nil {
				panic(err)
			}
			defer c.Close()
			clis = append(clis, c)
		}
	} else {
		c, err := clientv3.New(clientv3.Config{Endpoints: epl, DialTimeout: 5 * time.Second})
		if err != nil {
			panic(err)
		}
		defer c.Close()
		clis = append(clis, c)
	}
	t0 := time.Now()
	us := func() int64 { return time.Since(t0).Microseconds() }
	value := strings.Repeat("v", *val)

	type rec struct{ First, Ack int64; Tries, Ep int }
	var mu sync.Mutex
	recs := make([][]rec, *workers)
	marks := map[string]int64{}
	errs := map[string]int{}
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			f := strings.Fields(sc.Text())
			if len(f) == 2 && f[0] == "mark" {
				mu.Lock(); marks[f[1]] = us(); mu.Unlock()
			}
		}
	}()
	fmt.Fprintln(os.Stderr, "ready")
	period := time.Duration(float64(*workers) / *rate * 1e9)
	var wg sync.WaitGroup
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			cli := clis[w%len(clis)]
			next := t0.Add(time.Duration(w) * period / time.Duration(*workers))
			for k := 0; ; k++ {
				if d := time.Until(next); d > 0 {
					time.Sleep(d)
				}
				if time.Since(t0) > *dur {
					return
				}
				key := fmt.Sprintf("k%02d-%07d", w, k)
				first := us(); tries := 0
				for {
					tries++
					ctx, cancel := context.WithTimeout(context.Background(), *timeout)
					_, err := cli.Put(ctx, key, value)
					cancel()
					if err == nil {
						break
					}
					e := err.Error(); if len(e) > 60 { e = e[:60] }
					mu.Lock(); errs[e]++; mu.Unlock()
					time.Sleep(time.Millisecond)
				}
				recs[w] = append(recs[w], rec{first, us(), tries, w % len(clis)})
				next = next.Add(period)
				if time.Until(next) < -period { next = time.Now() } // fell behind: do not burst
			}
		}(w)
	}
	wg.Wait()
	all := [][4]int64{}
	for _, rs := range recs {
		for _, r := range rs {
			all = append(all, [4]int64{r.First, r.Ack, int64(r.Tries), int64(r.Ep)})
		}
	}
	mu.Lock()
	out, _ := json.Marshal(map[string]any{"marks": marks, "errors": errs, "writes": all})
	mu.Unlock()
	os.Stdout.Write(out)
	fmt.Println()
}
