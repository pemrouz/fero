// model.go — the sequential specification Porcupine checks each partition against (TEST-13).
//
// One partition of one resource is a set of rows. Every committed entry gets a version, and versions
// rise in log order within a partition (epoch:index, fixed width, so string order is log order).
// State: the newest version seen in the partition, and per row its version and (when known) value.
//
// Operations (built by run3.ts from the client history and the committed log):
//   w      set / remove / batch, maybe with ops (incr, push, merge, max, min) and conditions
//          (absent, present, version, equals; expired and fence are not modelled: either answer is
//          legal). ok: a version above every earlier one; each condition held; each op's answer is
//          what the op gives on the row as it was. Refused 'conflict' / 'absent-row' / 'absent-path':
//          the state really did refuse it.
//   touch  a write with no value: the row exists; its version moves if it carried a ttl or lease
//          (else it moves only if the row had a ttl, which the model does not know: both legal)
//   claim  the claimed rows exist and take the claim's version (an empty claim writes nothing)
//   e      a committed entry no client op accounts for (a ttl, max, where or session removal by the
//          writer, or a write whose client died before the answer): its records, at its version
//   r      a fresh (linearizable) read: the row's version, and its value when known
package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/anishathalye/porcupine"
)

type Cond struct {
	Absent  bool        `json:"absent,omitempty"`
	Present bool        `json:"present,omitempty"`
	Version *string     `json:"version,omitempty"`
	Equals  interface{} `json:"equals,omitempty"`
	HasEq   bool        `json:"-"`
	Expired bool        `json:"expired,omitempty"`
	Fence   interface{} `json:"fence,omitempty"`
}

func (c *Cond) UnmarshalJSON(b []byte) error {
	type plain Cond
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	_, p.HasEq = m["equals"]
	*c = Cond(p)
	return nil
}

type OpSpec struct {
	Op     string                 `json:"op"`
	N      *float64               `json:"n"`
	Min    *float64               `json:"min"`
	Max    *float64               `json:"max"`
	Items  []interface{}          `json:"items"`
	Fields map[string]interface{} `json:"fields"`
	X      interface{}            `json:"x"`
}

type WIn struct {
	K  []interface{} `json:"k"`
	V  interface{}   `json:"v"`
	Op *OpSpec       `json:"op"`
	Rm bool          `json:"rm"`
	If *Cond         `json:"if"`
}
type Rec struct {
	T int           `json:"t"`
	K []interface{} `json:"k"`
	V interface{}   `json:"v"`
}
type In struct {
	Ws   []WIn         `json:"ws"`
	Key  string        `json:"key"`
	TTL  bool          `json:"ttl"`
	If   *Cond         `json:"if"`
	Recs []Rec         `json:"recs"`
	Bump []string      `json:"bump"`
	K    []interface{} `json:"k"`
}
type Out struct {
	Ok     *bool       `json:"ok"`
	V      string      `json:"v"`
	Ans    interface{} `json:"ans"`
	HasAns bool        `json:"hasAns"`
	Code   string      `json:"code"`
	Rows   []string    `json:"rows"`
	Has    bool        `json:"has"`
	Val    interface{} `json:"val"`
}
type HOp struct {
	C    float64 `json:"c"`
	R    float64 `json:"r"`
	Kind string  `json:"kind"`
	In   In      `json:"in"`
	Out  Out     `json:"out"`
	Why  string  `json:"why"`
}
type Input struct {
	Kind string
	In   In
	Vals bool
}

// ── state ─────────────────────────────────────────────────────────────────────────────────────
type Row struct {
	V     string
	Val   interface{}
	Known bool
}
type State struct {
	Last string
	Rows map[string]Row
	key  string
}

func (s *State) Key() string {
	if s.key != "" {
		return s.key
	}
	ks := make([]string, 0, len(s.Rows))
	for k := range s.Rows {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	var b strings.Builder
	b.WriteString(s.Last)
	for _, k := range ks {
		r := s.Rows[k]
		v, _ := json.Marshal(r.Val)
		fmt.Fprintf(&b, "|%q=%s:%t:%s", k, r.V, r.Known, v)
	}
	s.key = b.String()
	return s.key
}
func (s *State) clone() *State {
	rows := make(map[string]Row, len(s.Rows))
	for k, v := range s.Rows {
		rows[k] = v
	}
	return &State{Last: s.Last, Rows: rows}
}

// ── JSON paths (as l2.ts leafAt / applyPlain) ──────────────────────────────────────────────────
func pkey(x interface{}) string {
	switch v := x.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return fmt.Sprint(x)
}
func leaf(v interface{}, path []interface{}) (interface{}, bool) {
	x := v
	for _, p := range path {
		switch c := x.(type) {
		case map[string]interface{}:
			y, ok := c[pkey(p)]
			if !ok {
				return nil, false
			}
			x = y
		case []interface{}:
			i, err := strconv.Atoi(pkey(p))
			if err != nil || i < 0 || i >= len(c) {
				return nil, false
			}
			x = c[i]
		default:
			return nil, false
		}
	}
	return x, true
}
func setIn(v interface{}, path []interface{}, val interface{}, remove bool) interface{} {
	if len(path) == 0 {
		if remove {
			return nil
		}
		return val
	}
	h := pkey(path[0])
	switch c := v.(type) {
	case []interface{}:
		n := append([]interface{}(nil), c...)
		i, err := strconv.Atoi(h)
		if err == nil && i >= 0 {
			for len(n) <= i {
				n = append(n, nil)
			}
			if len(path) == 1 {
				if remove {
					n[i] = nil
				} else {
					n[i] = val
				}
			} else {
				n[i] = setIn(n[i], path[1:], val, remove)
			}
		}
		return n
	default:
		m := map[string]interface{}{}
		if cm, ok := v.(map[string]interface{}); ok {
			for k, x := range cm {
				m[k] = x
			}
		}
		if len(path) == 1 {
			if remove {
				delete(m, h)
			} else {
				m[h] = val
			}
		} else {
			m[h] = setIn(m[h], path[1:], val, remove)
		}
		return m
	}
}
func norm(v interface{}) interface{} {
	b, _ := json.Marshal(v)
	var x interface{}
	_ = json.Unmarshal(b, &x)
	return x
}
func deq(a, b interface{}) bool { return reflect.DeepEqual(norm(a), norm(b)) }

// computeOp as l2.ts computeOp; ok=false means the op is refused ('conflict')
func computeOp(cur interface{}, has bool, s *OpSpec) (interface{}, bool) {
	switch s.Op {
	case "incr":
		c := 0.0
		if has && cur != nil {
			f, ok := cur.(float64)
			if !ok {
				return nil, false
			}
			c = f
		} else if has && cur == nil {
			return nil, false
		}
		next := c + *s.N
		if s.Min != nil && next < *s.Min {
			return nil, false
		}
		if s.Max != nil && next > *s.Max {
			return nil, false
		}
		return next, true
	case "push":
		var base []interface{}
		if has {
			a, ok := cur.([]interface{})
			if !ok {
				return nil, false
			}
			base = a
		}
		return append(append([]interface{}(nil), base...), s.Items...), true
	case "merge":
		m := map[string]interface{}{}
		if has {
			cm, ok := cur.(map[string]interface{})
			if !ok {
				return nil, false
			}
			for k, v := range cm {
				m[k] = v
			}
		}
		for k, v := range s.Fields {
			m[k] = v
		}
		return m, true
	case "max", "min":
		if !has {
			return s.X, true
		}
		gt := false
		switch x := s.X.(type) {
		case float64:
			c, ok := cur.(float64)
			if !ok {
				return s.X, true
			}
			gt = x > c
			if s.Op == "min" {
				gt = x < c
			}
		case string:
			c, ok := cur.(string)
			if !ok {
				return s.X, true
			}
			gt = x > c
			if s.Op == "min" {
				gt = x < c
			}
		}
		if gt {
			return s.X, true
		}
		return cur, true
	}
	return nil, false
}

const (
	pass = iota
	fail
	unknown
)

func evalCond(c *Cond, row Row, present bool, path []interface{}, vals bool) int {
	if c == nil {
		return pass
	}
	res := pass
	if c.Absent && present {
		return fail
	}
	if c.Present && !present {
		return fail
	}
	if c.Version != nil {
		v := ""
		if present {
			v = row.V
		}
		if v != *c.Version {
			return fail
		}
	}
	if c.HasEq {
		if !present || !row.Known || !vals {
			res = unknown
		} else {
			x, _ := leaf(row.Val, path)
			if !deq(x, c.Equals) {
				return fail
			}
		}
	}
	if c.Expired {
		res = unknown
	}
	return res
}

// ── the step ──────────────────────────────────────────────────────────────────────────────────
func step(st interface{}, input interface{}, output interface{}) []interface{} {
	s := st.(*State)
	in := input.(Input)
	out := output.(Out)
	ok := []interface{}{}
	switch in.Kind {
	case "r":
		rk := pkey(in.In.K[0])
		row, present := s.Rows[rk]
		if !present {
			if out.V == "" && !out.Has {
				return []interface{}{s}
			}
			return ok
		}
		if out.V != row.V {
			return ok
		}
		if in.Vals && row.Known {
			x, has := leaf(row.Val, in.In.K[1:])
			if has != out.Has || (has && !deq(x, out.Val)) {
				return ok
			}
		}
		return []interface{}{s}
	case "e":
		if out.V <= s.Last {
			return ok
		}
		n := s.clone()
		n.Last = out.V
		for _, r := range in.In.Recs {
			rk := pkey(r.K[0])
			row, present := n.Rows[rk]
			if r.T == 2 && len(r.K) == 1 {
				delete(n.Rows, rk)
				continue
			}
			if len(r.K) == 1 {
				row = Row{Val: r.V, Known: in.Vals}
			} else {
				if !present {
					return ok
				}
				row.Val = setIn(row.Val, r.K[1:], r.V, r.T == 2)
			}
			row.V = out.V
			n.Rows[rk] = row
		}
		for _, k := range in.In.Bump {
			if row, present := n.Rows[k]; present {
				row.V = out.V
				n.Rows[k] = row
			}
		}
		return []interface{}{n}
	case "claim":
		if out.V == "" {
			return []interface{}{s}
		}
		if out.V <= s.Last {
			return ok
		}
		n := s.clone()
		n.Last = out.V
		for _, k := range out.Rows {
			row, present := n.Rows[k]
			if !present {
				return ok
			}
			row.V = out.V
			n.Rows[k] = row
		}
		return []interface{}{n}
	case "touch":
		row, present := s.Rows[in.In.Key]
		if out.Code != "" {
			switch out.Code {
			case "absent-row":
				if !present {
					return []interface{}{s}
				}
			case "conflict":
				if !present {
					return ok
				}
				if evalCond(in.In.If, row, present, nil, in.Vals) != pass {
					return []interface{}{s}
				}
			}
			return ok
		}
		if !present || out.V <= s.Last {
			return ok
		}
		if evalCond(in.In.If, row, present, nil, in.Vals) == fail {
			return ok
		}
		n := s.clone()
		n.Last = out.V
		bumped := n.clone()
		r2 := row
		r2.V = out.V
		bumped.Rows[in.In.Key] = r2
		if in.In.TTL {
			return []interface{}{bumped}
		}
		return []interface{}{bumped, n}
	case "w":
		if out.Ok != nil && !*out.Ok {
			return refused(s, in, out)
		}
		if out.V <= s.Last {
			return ok
		}
		n := s.clone()
		n.Last = out.V
		for i, w := range in.In.Ws {
			rk := pkey(w.K[0])
			row, present := n.Rows[rk]
			path := w.K[1:]
			if len(w.K) > 1 && !present && !w.Rm {
				return ok // the writer would have refused 'absent-row'
			}
			if evalCond(w.If, row, present, path, in.Vals) == fail {
				return ok
			}
			var ans interface{}
			hasAns := false
			if out.HasAns {
				if len(in.In.Ws) == 1 {
					ans, hasAns = out.Ans, true
				} else if a, isArr := out.Ans.([]interface{}); isArr && i < len(a) {
					ans, hasAns = a[i], true
				}
			}
			switch {
			case w.Op != nil:
				var newv interface{}
				known := in.Vals && (row.Known || !present)
				if known {
					cur, has := leaf(row.Val, path)
					if !present {
						cur, has = nil, false
					}
					exp, okc := computeOp(cur, has, w.Op)
					if !okc {
						return ok // the writer would have refused it
					}
					if hasAns && !deq(exp, ans) {
						return ok // the answer is not what the op gives on this state
					}
					newv = exp
				} else if hasAns {
					newv = ans
				}
				if len(path) == 0 {
					row = Row{Val: newv, Known: known || (hasAns && in.Vals && len(path) == 0)}
				} else {
					row.Val = setIn(row.Val, path, newv, false)
					row.Known = row.Known && known
				}
			case w.Rm:
				if len(path) == 0 {
					delete(n.Rows, rk)
					continue
				}
				if present {
					row.Val = setIn(row.Val, path, nil, true)
				}
			default:
				if len(path) == 0 {
					row = Row{Val: w.V, Known: in.Vals}
				} else {
					row.Val = setIn(row.Val, path, w.V, false)
				}
			}
			row.V = out.V
			n.Rows[rk] = row
		}
		return []interface{}{n}
	}
	return ok
}

// a refused write: legal when the state really refuses it, and it changes nothing
func refused(s *State, in Input, out Out) []interface{} {
	rows := map[string]Row{}
	for k, v := range s.Rows {
		rows[k] = v
	}
	can := false
	for _, w := range in.In.Ws {
		rk := pkey(w.K[0])
		row, present := rows[rk]
		path := w.K[1:]
		switch out.Code {
		case "absent-row":
			if len(w.K) > 1 && !present && !w.Rm {
				can = true
			}
		case "absent-path":
			if len(w.K) > 2 && !w.Rm {
				if !present || !row.Known || !in.Vals {
					can = true
				} else if p, has := leaf(row.Val, w.K[1:len(w.K)-1]); !has {
					can = true
				} else if _, isObj := p.(map[string]interface{}); !isObj {
					if _, isArr := p.([]interface{}); !isArr {
						can = true
					}
				}
			}
		case "conflict":
			if r := evalCond(w.If, row, present, path, in.Vals); r != pass {
				can = true
			}
			if w.Op != nil {
				if !in.Vals || (present && !row.Known) {
					can = true
				} else {
					cur, has := leaf(row.Val, path)
					if !present {
						cur, has = nil, false
					}
					if _, okc := computeOp(cur, has, w.Op); !okc {
						can = true
					}
				}
			}
		}
		if can {
			break
		}
		// later writes of a batch see this one applied (the writer's overlay)
		if w.Op == nil && len(path) == 0 {
			if w.Rm {
				delete(rows, rk)
			} else {
				rows[rk] = Row{V: row.V, Val: w.V, Known: in.Vals}
			}
		} else if present {
			row.Known = false
			rows[rk] = row
		}
	}
	if can {
		return []interface{}{s}
	}
	return []interface{}{}
}

func describe(input interface{}, output interface{}) string {
	in := input.(Input)
	o := output.(Out)
	b, _ := json.Marshal(in.In)
	ob, _ := json.Marshal(o)
	return fmt.Sprintf("%s %s -> %s", in.Kind, b, ob)
}

var Model = porcupine.NondeterministicModel{
	Init: func() []interface{} { return []interface{}{&State{Rows: map[string]Row{}}} },
	Step: step,
	Equal: func(a, b interface{}) bool {
		return a.(*State).Key() == b.(*State).Key()
	},
	Hash: func(a interface{}) uint64 {
		h := fnv.New64a()
		h.Write([]byte(a.(*State).Key()))
		return h.Sum64()
	},
	DescribeOperation: describe,
	DescribeState: func(a interface{}) string {
		k := a.(*State).Key()
		if len(k) > 400 {
			return k[:400] + "..."
		}
		return k
	},
}
