// Loopback TCP ping-pong in Go, Nagle off (Go's default). One message in flight.
// go run rtt.go server <port> | client <port> <bytes> <seconds>
package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"sort"
	"strconv"
	"time"
)

func main() {
	mode, port := os.Args[1], os.Args[2]
	addr := "127.0.0.1:" + port
	if mode == "server" {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			panic(err)
		}
		for {
			c, err := ln.Accept()
			if err != nil {
				panic(err)
			}
			go func(c net.Conn) {
				c.(*net.TCPConn).SetNoDelay(true)
				buf := make([]byte, 65536)
				for {
					n, err := c.Read(buf)
					if err != nil {
						return
					}
					if _, err := c.Write(buf[:n]); err != nil {
						return
					}
				}
			}(c)
		}
	}
	size, _ := strconv.Atoi(os.Args[3])
	secs, _ := strconv.Atoi(os.Args[4])
	c, err := net.Dial("tcp", addr)
	if err != nil {
		panic(err)
	}
	c.(*net.TCPConn).SetNoDelay(true)
	msg := make([]byte, size)
	in := make([]byte, size)
	lat := make([]float64, 0, 4000000)
	warmEnd := time.Now().Add(time.Second)
	end := warmEnd.Add(time.Duration(secs) * time.Second)
	for {
		t0 := time.Now()
		if t0.After(end) {
			break
		}
		if _, err := c.Write(msg); err != nil {
			panic(err)
		}
		if _, err := io.ReadFull(c, in); err != nil {
			panic(err)
		}
		if t0.After(warmEnd) {
			lat = append(lat, float64(time.Since(t0).Nanoseconds())/1e3)
		}
	}
	sort.Float64s(lat)
	n := len(lat)
	q := func(p float64) float64 { return lat[min(n-1, int(p*float64(n)))] }
	fmt.Printf("{\"impl\":\"go\",\"go\":\"%s\",\"bytes\":%d,\"n\":%d,\"rtt_per_s\":%d,\"p50_us\":%.1f,\"p99_us\":%.1f,\"p999_us\":%.1f,\"max_us\":%.1f}\n",
		runtime.Version(), size, n, n/secs, q(0.5), q(0.99), q(0.999), lat[n-1])
}
