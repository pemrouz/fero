// Porcupine (v1.3.1) check of a Maelstrom lin-kv history, key by key, as a second checker beside
// Knossos. The model is a compare-and-set register that starts empty (nil), as Knossos's cas-register:
// read must see the current value; write sets it; cas sets `to` only if the value equals `from`.
// An operation whose outcome is unknown (info) may take effect or not, so the model is
// nondeterministic: it returns every possible next state.
// Usage: go run . <ops.jsonl> [timeout seconds per key]
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/anishathalye/porcupine"
)

type op struct {
	Key    int    `json:"key"`
	F      string `json:"f"`
	Type   string `json:"type"`
	Value  *int   `json:"value"`
	From   int    `json:"from"`
	To     int    `json:"to"`
	Call   int64  `json:"call"`
	Ret    int64  `json:"ret"`
	Client int    `json:"client"`
}

const empty = -1 // the key does not exist yet

func val(p *int) int {
	if p == nil {
		return empty
	}
	return *p
}

var model = porcupine.NondeterministicModel{
	Init: func() []interface{} { return []interface{}{empty} },
	Step: func(state, input, output interface{}) []interface{} {
		s := state.(int)
		o := input.(op)
		switch o.F {
		case "read":
			if val(o.Value) == s {
				return []interface{}{s}
			}
			return nil
		case "write":
			if o.Type == "info" {
				return []interface{}{s, val(o.Value)}
			}
			return []interface{}{val(o.Value)}
		case "cas":
			if o.Type == "info" {
				if s == o.From {
					return []interface{}{s, o.To}
				}
				return []interface{}{s}
			}
			if s == o.From {
				return []interface{}{o.To}
			}
			return nil
		}
		return nil
	},
	DescribeOperation: func(input, output interface{}) string {
		o := input.(op)
		switch o.F {
		case "cas":
			return fmt.Sprintf("%s cas %d->%d", o.Type, o.From, o.To)
		default:
			return fmt.Sprintf("%s %s %d", o.Type, o.F, val(o.Value))
		}
	},
}

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	limit := 60 * time.Second
	if len(os.Args) > 2 {
		n, _ := strconv.Atoi(os.Args[2])
		limit = time.Duration(n) * time.Second
	}
	byKey := map[int][]porcupine.Operation{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var o op
		if err := json.Unmarshal(sc.Bytes(), &o); err != nil {
			panic(err)
		}
		byKey[o.Key] = append(byKey[o.Key], porcupine.Operation{ClientId: o.Client, Input: o, Call: o.Call, Output: nil, Return: o.Ret})
	}
	keys := []int{}
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	m := model.ToModel()
	bad, unknown := []int{}, []int{}
	for _, k := range keys {
		t0 := time.Now()
		res := porcupine.CheckOperationsTimeout(m, byKey[k], limit)
		verdict := map[porcupine.CheckResult]string{porcupine.Ok: "ok", porcupine.Illegal: "ILLEGAL", porcupine.Unknown: "unknown (timeout)"}[res]
		fmt.Printf("key %d: %d ops, %s, %.3f s\n", k, len(byKey[k]), verdict, time.Since(t0).Seconds())
		if res == porcupine.Illegal {
			bad = append(bad, k)
		} else if res == porcupine.Unknown {
			unknown = append(unknown, k)
		}
	}
	fmt.Printf("summary: %d keys, not linearizable %v, unknown %v\n", len(keys), bad, unknown)
}
