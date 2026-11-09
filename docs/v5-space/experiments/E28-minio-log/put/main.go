// E-28 (timing part): conditional PUT latency on a local MinIO, as an object-store log would commit.
// Go standard library only: it signs S3 requests itself (AWS Signature V4, payload sent as UNSIGNED-PAYLOAD,
// as S3 clients do over TLS), so nothing is downloaded.
//
// Modes:
//   create   PUT a new key with If-None-Match: *            (an append: one object per commit, fails if it exists)
//   cas      PUT one key with If-Match: <its current ETag>    (a manifest swap: leadership and the log head by CAS)
//   plain    PUT a new key, unconditional                     (the protocol's floor, for comparison)
// Each op is timed from the first byte of the request to the full response. Every op must answer 200; a 412
// (precondition failed) or any other code counts as an error and is reported.
//
// Usage: e28put -endpoint http://127.0.0.1:19100 -bucket b -mode create -size 1024 -dur 10s -conc 1
// Output: one JSON line with the latency percentiles (µs), ops/s, and the count of errors by status.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	endpoint = flag.String("endpoint", "http://127.0.0.1:19100", "")
	bucket   = flag.String("bucket", "e28", "")
	mode     = flag.String("mode", "create", "create | cas | plain")
	size     = flag.Int("size", 1024, "object bytes")
	dur      = flag.Duration("dur", 10*time.Second, "")
	conc     = flag.Int("conc", 1, "concurrent writers (cas: each writer has its own key)")
	ak       = flag.String("ak", "e28user", "")
	sk       = flag.String("sk", "e28secret123", "")
	prefix   = flag.String("prefix", "run", "key prefix")
	mkbucket = flag.Bool("mkbucket", false, "create the bucket and exit")
)

func hmacSHA(key []byte, s string) []byte { h := hmac.New(sha256.New, key); h.Write([]byte(s)); return h.Sum(nil) }

// sign adds SigV4 headers for an S3 request with an unsigned payload.
func sign(req *http.Request) {
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
	names := []string{"host"}
	for k := range req.Header {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-amz-") || lk == "if-match" || lk == "if-none-match" {
			names = append(names, lk)
		}
	}
	sort.Strings(names)
	var ch strings.Builder
	for _, n := range names {
		v := req.Host
		if n != "host" {
			v = strings.TrimSpace(req.Header.Get(n))
		}
		ch.WriteString(n + ":" + v + "\n")
	}
	signed := strings.Join(names, ";")
	canon := req.Method + "\n" + req.URL.EscapedPath() + "\n" + req.URL.RawQuery + "\n" + ch.String() + "\n" + signed + "\nUNSIGNED-PAYLOAD"
	scope := day + "/us-east-1/s3/aws4_request"
	h := sha256.Sum256([]byte(canon))
	sts := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(h[:])
	k := hmacSHA(hmacSHA(hmacSHA(hmacSHA([]byte("AWS4"+*sk), day), "us-east-1"), "s3"), "aws4_request")
	sig := hex.EncodeToString(hmacSHA(k, sts))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+*ak+"/"+scope+", SignedHeaders="+signed+", Signature="+sig)
}

func put(c *http.Client, key string, body []byte, hdr map[string]string) (int, string, error) {
	req, _ := http.NewRequest("PUT", *endpoint+"/"+*bucket+"/"+key, bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	sign(req)
	resp, err := c.Do(req)
	if err != nil {
		return 0, "", err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, resp.Header.Get("ETag"), nil
}

func main() {
	flag.Parse()
	tr := &http.Transport{MaxIdleConnsPerHost: 256, DisableCompression: true, Proxy: nil}
	c := &http.Client{Transport: tr, Timeout: 30 * time.Second}
	if *mkbucket {
		req, _ := http.NewRequest("PUT", *endpoint+"/"+*bucket, nil)
		sign(req)
		resp, err := c.Do(req)
		if err != nil {
			panic(err)
		}
		fmt.Println("mkbucket", resp.StatusCode)
		return
	}
	body := bytes.Repeat([]byte("x"), *size)
	var mu sync.Mutex
	lat := []int64{}
	errs := map[string]int{}
	ok := 0
	start := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < *conc; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			etag := ""
			key := fmt.Sprintf("%s/cas-%d", *prefix, w)
			if *mode == "cas" { // seed the manifest
				code, e, err := put(c, key, body, nil)
				if err != nil || code != 200 {
					panic(fmt.Sprint("seed ", code, err))
				}
				etag = e
			}
			mine := []int64{}
			for i := 0; time.Since(start) < *dur; i++ {
				hdr := map[string]string{}
				k := key
				switch *mode {
				case "create":
					hdr["If-None-Match"] = "*"
					k = fmt.Sprintf("%s/w%d/%09d", *prefix, w, i)
				case "plain":
					k = fmt.Sprintf("%s/w%d/%09d", *prefix, w, i)
				case "cas":
					hdr["If-Match"] = etag
				}
				t0 := time.Now()
				code, e, err := put(c, k, body, hdr)
				d := time.Since(t0).Microseconds()
				if err != nil || code != 200 {
					s := fmt.Sprint(code)
					if err != nil {
						s = err.Error()
						if len(s) > 60 {
							s = s[:60]
						}
					}
					mu.Lock(); errs[s]++; mu.Unlock()
					if *mode == "cas" { // re-read the ETag the hard way: unconditional put resets the chain
						if code2, e2, err2 := put(c, key, body, nil); err2 == nil && code2 == 200 {
							etag = e2
						}
					}
					continue
				}
				etag = e
				mine = append(mine, d)
			}
			mu.Lock(); lat = append(lat, mine...); ok += len(mine); mu.Unlock()
		}(w)
	}
	wg.Wait()
	el := time.Since(start).Seconds()
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	p := func(q float64) int64 {
		if len(lat) == 0 {
			return -1
		}
		i := int(q * float64(len(lat)))
		if i >= len(lat) {
			i = len(lat) - 1
		}
		return lat[i]
	}
	out := map[string]any{"mode": *mode, "size": *size, "conc": *conc, "ops": ok, "ops_s": float64(ok) / el,
		"p50_us": p(0.5), "p90_us": p(0.9), "p99_us": p(0.99), "p999_us": p(0.999), "max_us": p(1), "errors": errs}
	json.NewEncoder(os.Stdout).Encode(out)
}
