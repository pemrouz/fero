### The folds: final rows and digests (1,000,000 records)

"refused" counts records the fold did not take (a reject or a throw). The digest is SHA-256 (first 16 hex digits) of the rows in the engine's own order.

| data commit | SCHEDULE_VERSION | way in | rows at the end | refused | digest, Node 22 | Node 26: same digest, same per-record results |
|---|---|---|---|---|---|---|
| b831319 | 2 | lane-rec | 10,628 | 37,898 | 89eee70c667932b7 | yes |
| 46df5f9 | 3 | lane-rec | 10,628 | 37,898 | 89eee70c667932b7 | yes |
| ff85e6c | 3 | lane-rec | 10,628 | 37,898 | 89eee70c667932b7 | yes |
| dc65b8f | 4 | lane-rec | 10,628 | 37,898 | 89eee70c667932b7 | yes |
| 2b8b780 | 4 | lane-rec | 10,628 | 40,113 | 63ab146c4b3460c0 | yes |
| 63fea66 | 4 | lane-rec | 10,628 | 40,113 | 63ab146c4b3460c0 | yes |
| b831319 | 2 | lane-b256 | 10,628 | 37898 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| 46df5f9 | 3 | lane-b256 | 10,628 | 37898 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| ff85e6c | 3 | lane-b256 | 10,628 | 37898 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| dc65b8f | 4 | lane-b256 | 10,628 | 37898 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| 2b8b780 | 4 | lane-b256 | 10,628 | 40113 rejected, 0 calls threw | 63ab146c4b3460c0 | yes |
| 63fea66 | 4 | lane-b256 | 10,628 | 40113 rejected, 0 calls threw | 63ab146c4b3460c0 | yes |
| ff85e6c | 3 | seam | 12,067 | 2,861 | 6864978a16fc8959 | yes |
| dc65b8f | 4 | seam | 12,067 | 2,861 | 6864978a16fc8959 | yes |
| 2b8b780 | 4 | seam | 12,067 | 2,861 | 0b55cfd57b4588c8 | yes |
| 63fea66 | 4 | seam | 12,067 | 2,861 | 0b55cfd57b4588c8 | yes |
| 4479a92 | 1 | ingest-rec | 10,628 | 150,465 | fd632eec7a4e89a3 | yes |
| 6b615e2 | 2 | ingest-rec | 10,628 | 27,427 | 89eee70c667932b7 | yes |
| b831319 | 2 | ingest-rec | 10,628 | 27,427 | 89eee70c667932b7 | yes |
| 46df5f9 | 3 | ingest-rec | 10,628 | 27,427 | 89eee70c667932b7 | yes |
| ff85e6c | 3 | ingest-rec | 10,628 | 27,427 | 89eee70c667932b7 | yes |
| dc65b8f | 4 | ingest-rec | 10,628 | 27,427 | 89eee70c667932b7 | yes |
| 2b8b780 | 4 | ingest-rec | 10,628 | 29,642 | 63ab146c4b3460c0 | yes |
| 63fea66 | 4 | ingest-rec | 10,628 | 29,642 | 63ab146c4b3460c0 | yes |
| 4479a92 | 1 | ingest-b256 | 1,835 | 0 rejected, 3907 calls threw | 66caa90dcebd7f4f | yes |
| 6b615e2 | 2 | ingest-b256 | 10,628 | 27427 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| b831319 | 2 | ingest-b256 | 10,628 | 27427 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| 46df5f9 | 3 | ingest-b256 | 10,628 | 27427 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| ff85e6c | 3 | ingest-b256 | 10,628 | 27427 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| dc65b8f | 4 | ingest-b256 | 10,628 | 27427 rejected, 0 calls threw | 89eee70c667932b7 | yes |
| 2b8b780 | 4 | ingest-b256 | 10,628 | 29642 rejected, 0 calls threw | 63ab146c4b3460c0 | yes |
| 63fea66 | 4 | ingest-b256 | 10,628 | 29642 rejected, 0 calls threw | 63ab146c4b3460c0 | yes |

### data version against data version, Node 22

| pair | from | to | records after which the row differs | of those, where the two folds parted (roots) | rows still apart at the end | same row, but one side refused |
|---|---|---|---|---|---|---|
| lane-v2-v3 | b831319-lane-rec-n22 | 46df5f9-lane-rec-n22 | 0 | 0 | 0 | 0 |
| lane-v3-v3 | 46df5f9-lane-rec-n22 | ff85e6c-lane-rec-n22 | 0 | 0 | 0 | 0 |
| lane-v3-v4 | ff85e6c-lane-rec-n22 | dc65b8f-lane-rec-n22 | 0 | 0 | 0 | 0 |
| lane-v4-v4later | dc65b8f-lane-rec-n22 | 2b8b780-lane-rec-n22 | 47,994 | 15,815 | 578 | 2,090 |
| lane-v4later-head | 2b8b780-lane-rec-n22 | 63fea66-lane-rec-n22 | 0 | 0 | 0 | 0 |
| ingest-v1-v2 | 4479a92-ingest-rec-n22 | 6b615e2-ingest-rec-n22 | 174,154 | 54,875 | 1,937 | 41,489 |
| ingest-v2-v2 | 6b615e2-ingest-rec-n22 | b831319-ingest-rec-n22 | 0 | 0 | 0 | 0 |
| ingest-v2-v3 | b831319-ingest-rec-n22 | 46df5f9-ingest-rec-n22 | 0 | 0 | 0 | 0 |
| ingest-v3-v4 | ff85e6c-ingest-rec-n22 | dc65b8f-ingest-rec-n22 | 0 | 0 | 0 | 0 |
| ingest-v4-v4later | dc65b8f-ingest-rec-n22 | 2b8b780-ingest-rec-n22 | 47,784 | 15,812 | 578 | 2,090 |
| ingest-v4later-head | 2b8b780-ingest-rec-n22 | 63fea66-ingest-rec-n22 | 0 | 0 | 0 | 0 |
| seam-v3-v4 | ff85e6c-seam-n22 | dc65b8f-seam-n22 | 0 | 0 | 0 | 0 |
| seam-v4-v4later | dc65b8f-seam-n22 | 2b8b780-seam-n22 | 47,966 | 15,818 | 580 | 0 |
| seam-v4later-head | 2b8b780-seam-n22 | 63fea66-seam-n22 | 0 | 0 | 0 | 0 |

### three ways in at HEAD (the same data commit)

| pair | from | to | records after which the row differs | of those, where the two folds parted (roots) | rows still apart at the end | same row, but one side refused |
|---|---|---|---|---|---|---|
| head-lane-vs-seam | 63fea66-lane-rec-n22 | 63fea66-seam-n22 | 22,569 | 15,348 | 1,512 | 19,052 |
| head-lane-vs-ingest | 63fea66-lane-rec-n22 | 63fea66-ingest-rec-n22 | 0 | 0 | 0 | 0 |

### Node 22 against Node 26

18 pairs (every commit, every per-record way in): 0 differ.

### Batch boundaries: one record a call against 256 a call

| data commit | way in | same final rows | same at all 20 checkpoints |
|---|---|---|---|
| b831319 | lane | yes | yes |
| 46df5f9 | lane | yes | yes |
| ff85e6c | lane | yes | yes |
| dc65b8f | lane | yes | yes |
| 2b8b780 | lane | yes | yes |
| 63fea66 | lane | yes | yes |
| 4479a92 | ingest | **no** (10,628 rows against 1,835) | **no** |
| 6b615e2 | ingest | yes | yes |
| b831319 | ingest | yes | yes |
| 46df5f9 | ingest | yes | yes |
| ff85e6c | ingest | yes | yes |
| dc65b8f | ingest | yes | yes |
| 2b8b780 | ingest | yes | yes |
| 63fea66 | ingest | yes | yes |

### Where the folds part: the roots, by what the record met

At most 3,000 roots per pair were explained (the first 3,000 in stream order). What the record writes, and the sort of value at the leaf, are left off so that like cases count together.

**head-lane-vs-seam** (3,000 roots explained)

| roots | what the record met; then how each side answered | example: the row before; the record; the row after on each side |
|---|---|---|
| 2,646 | update deep; row absent // lane-rec: refused / seam: taken | record 0: before `(no row)`; record `{"type":n0.0,"key":["k3768","n"],"value":n3ff00000.0}`; lane-rec: reject: data: deep write at [..] — key .. is not live, `(no row)`; seam: applied, `{"n":n3ff00000.0}` |
| 183 | insert deep; under object; leaf present // lane-rec: refused / seam: taken | record 315: before `{"n":n4089d000.0,"s":"0","tags":[n4071c000.0,{"1":{"0":{"1":n40532000.0,"2":"u868"},"é":b2a,"c":n40664000.0}},...`; record `{"type":n3ff00000.0,"key":["k19602","tags"],"value":n3ff00000.0}`; lane-rec: reject: data: lane() nested insert — write the containing ar, `{"n":n4089d000.0,"s":"0","tags":[n4071c000.0,{"1":{"0":{"1":n40532000.0,"2":"u868"},"é":b2a,"c":n40664000.0}},...`; seam: applied, `{"n":n4089d000.0,"s":"0","tags":n3ff00000.0,"meta":{"1":[{"0":n40632c00.0,"b":n40816000.0,"s":n408de800.0},n40...` |
| 164 | insert deep; under object; leaf absent // lane-rec: refused / seam: taken | record 102: before `{"n":n407b5000.0,"s":"null"}`; record `{"type":n3ff00000.0,"key":["k16498","tags"],"value":n3ff00000.0}`; lane-rec: reject: data: lane() nested insert — write the containing ar, `{"n":n407b5000.0,"s":"null"}`; seam: applied, `{"n":n407b5000.0,"s":"null","tags":n3ff00000.0}` |
| 4 | insert deep; under number; leaf none // lane-rec: refused / seam: taken | record 60,250: before `n40200000.0`; record `{"type":n3ff00000.0,"key":["k11452","tags"],"value":n3ff00000.0}`; lane-rec: reject: data: lane() nested insert — write the containing ar, `n40200000.0`; seam: applied, `{"tags":n3ff00000.0}` |
| 2 | insert deep; under array; leaf absent, a name, not an index // lane-rec: refused / seam: taken | record 5,283: before `[]`; record `{"type":n3ff00000.0,"key":["k6570","tags"],"value":n3ff00000.0}`; lane-rec: reject: data: lane() nested insert — write the containing ar, `[]`; seam: applied, `[]+{"tags":n3ff00000.0,}` |
| 1 | insert deep; under undefined; leaf none // lane-rec: refused / seam: taken | record 108,286: before `U`; record `{"type":n3ff00000.0,"key":["k18511","tags"],"value":n3ff00000.0}`; lane-rec: reject: data: lane() nested insert — write the containing ar, `U`; seam: applied, `{"tags":n3ff00000.0}` |

**ingest-v1-v2** (3,000 roots explained)

| roots | what the record met; then how each side answered | example: the row before; the record; the row after on each side |
|---|---|---|
| 2,242 | remove deep; under object; leaf present // 4479a92: refused / 6b615e2: taken | record 20: before `{"n":n40837800.0,"s":"42","tags":["a\u0000b",F]}`; record `{"type":n40000000.0,"key":["k9417","n"]}`; 4479a92: threw: data: ingest() nested-field removal is not supported , `{"n":n40837800.0,"s":"42","tags":["a\u0000b",F]}`; 6b615e2: applied, `{"s":"42","tags":["a\u0000b",F]}` |
| 756 | remove deep; under object > object; leaf present // 4479a92: refused / 6b615e2: taken | record 40: before `{"n":n40856000.0,"s":"0","tags":[],"meta":{"1":{"c":n408e5800.0,"b":F,"tags":n405cc000.0,"x.y":{"2":"hello wor...`; record `{"type":n40000000.0,"key":["k11055","meta","meta"]}`; 4479a92: threw: data: ingest() nested-field removal is not supported , `{"n":n40856000.0,"s":"0","tags":[],"meta":{"1":{"c":n408e5800.0,"b":F,"tags":n405cc000.0,"x.y":{"2":"hello wor...`; 6b615e2: applied, `{"n":n40856000.0,"s":"0","tags":[],"meta":{"1":{"c":n408e5800.0,"b":F,"tags":n405cc000.0,"x.y":{"2":"hello wor...` |
| 2 | remove deep; under object > bytes; leaf none // 4479a92: refused / 6b615e2: taken | record 45,822: before `{"n":n407f1000.0,"s":"null","tags":bc81c362e66,"a":{"s":n3e7ad7f2.9abcaf48}}`; record `{"type":n40000000.0,"key":["k829","tags","0"]}`; 4479a92: threw: data: ingest() nested-field removal is not supported , `{"n":n407f1000.0,"s":"null","tags":bc81c362e66,"a":{"s":n3e7ad7f2.9abcaf48}}`; 6b615e2: applied, `{"n":n407f1000.0,"s":"null","tags":{"1":n403c0000.0,"2":n404b0000.0,"3":n40470000.0,"4":n40598000.0},"a":{"s":...` |

**ingest-v4-v4later** (3,000 roots explained)

| roots | what the record met; then how each side answered | example: the row before; the record; the row after on each side |
|---|---|---|
| 2,594 | update deep; under object > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 26: before `{"10":n406bbc00.0,"n":n40777000.0,"s":"null","tags":[],"a":N}`; record `{"type":n0.0,"key":["k9417","s","10"],"value":n407e6000.0}`; dc65b8f: applied, `{"10":n406bbc00.0,"n":n40777000.0,"s":{"0":"n","1":"u","2":"l","3":"l","10":n407e6000.0},"tags":[],"a":N}`; 2b8b780: applied, `{"10":n406bbc00.0,"n":n40777000.0,"s":{"10":n407e6000.0},"tags":[],"a":N}` |
| 216 | update deep; under object > array > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 56: before `{"n":n407ca000.0,"s":"42","tags":["u95360","true"],"meta":{"10":n40533800.0,"tags":n40717000.0,"b":{"b":n408a9...`; record `{"type":n0.0,"key":["k17987","tags","0","a"],"value":{"0":n4061c000.0,"tags":n408a5800.0,"meta":n407ff000.0,"s...`; dc65b8f: applied, `{"n":n407ca000.0,"s":"42","tags":[{"0":"u","1":"9","2":"5","3":"3","4":"6","5":"0","a":{"0":n4061c000.0,"tags"...`; 2b8b780: applied, `{"n":n407ca000.0,"s":"42","tags":[{"a":{"0":n4061c000.0,"tags":n408a5800.0,"meta":n407ff000.0,"s":{}}},"true"]...` |
| 141 | update deep; under object > object > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 2,844: before `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":"日本語","meta":{"2":n4084c000.0}},"a":N,"b":U}`; record `{"type":n0.0,"key":["k6502","meta","b","10"],"value":{"x.y":{"0":"0","a":n444b1ae4.d6e2ef50},"tags":U}}`; dc65b8f: applied, `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":{"0":"日","1":"本","2":"語","10":{"x.y":{"0":"0","a":n444b...`; 2b8b780: applied, `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":{"10":{"x.y":{"0":"0","a":n444b1ae4.d6e2ef50},"tags":U}...` |
| 49 | update deep; under object > string > absent; leaf none // dc65b8f: taken / 2b8b780: taken | record 7,274: before `{"n":n404f8000.0,"s":"42","tags":"a\u0000b","meta":{"2":[{"2":n408df000.0,"s":U,"n":n433fffff.ffffffff,"é":T},...`; record `{"type":n0.0,"key":["k7216","tags","0","a"],"value":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}}`; dc65b8f: applied, `{"n":n404f8000.0,"s":"42","tags":{"0":{"0":"a","a":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}},"1":"\u0000","...`; 2b8b780: applied, `{"n":n404f8000.0,"s":"42","tags":{"0":{"a":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}}},"meta":{"2":[{"2":n40...` |

**lane-v4-v4later** (3,000 roots explained)

| roots | what the record met; then how each side answered | example: the row before; the record; the row after on each side |
|---|---|---|
| 2,594 | update deep; under object > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 26: before `{"10":n406bbc00.0,"n":n40777000.0,"s":"null","tags":[],"a":N}`; record `{"type":n0.0,"key":["k9417","s","10"],"value":n407e6000.0}`; dc65b8f: applied, `{"10":n406bbc00.0,"n":n40777000.0,"s":{"0":"n","1":"u","2":"l","3":"l","10":n407e6000.0},"tags":[],"a":N}`; 2b8b780: applied, `{"10":n406bbc00.0,"n":n40777000.0,"s":{"10":n407e6000.0},"tags":[],"a":N}` |
| 216 | update deep; under object > array > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 56: before `{"n":n407ca000.0,"s":"42","tags":["u95360","true"],"meta":{"10":n40533800.0,"tags":n40717000.0,"b":{"b":n408a9...`; record `{"type":n0.0,"key":["k17987","tags","0","a"],"value":{"0":n4061c000.0,"tags":n408a5800.0,"meta":n407ff000.0,"s...`; dc65b8f: applied, `{"n":n407ca000.0,"s":"42","tags":[{"0":"u","1":"9","2":"5","3":"3","4":"6","5":"0","a":{"0":n4061c000.0,"tags"...`; 2b8b780: applied, `{"n":n407ca000.0,"s":"42","tags":[{"a":{"0":n4061c000.0,"tags":n408a5800.0,"meta":n407ff000.0,"s":{}}},"true"]...` |
| 141 | update deep; under object > object > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 2,844: before `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":"日本語","meta":{"2":n4084c000.0}},"a":N,"b":U}`; record `{"type":n0.0,"key":["k6502","meta","b","10"],"value":{"x.y":{"0":"0","a":n444b1ae4.d6e2ef50},"tags":U}}`; dc65b8f: applied, `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":{"0":"日","1":"本","2":"語","10":{"x.y":{"0":"0","a":n444b...`; 2b8b780: applied, `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":{"10":{"x.y":{"0":"0","a":n444b1ae4.d6e2ef50},"tags":U}...` |
| 49 | update deep; under object > string > absent; leaf none // dc65b8f: taken / 2b8b780: taken | record 7,274: before `{"n":n404f8000.0,"s":"42","tags":"a\u0000b","meta":{"2":[{"2":n408df000.0,"s":U,"n":n433fffff.ffffffff,"é":T},...`; record `{"type":n0.0,"key":["k7216","tags","0","a"],"value":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}}`; dc65b8f: applied, `{"n":n404f8000.0,"s":"42","tags":{"0":{"0":"a","a":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}},"1":"\u0000","...`; 2b8b780: applied, `{"n":n404f8000.0,"s":"42","tags":{"0":{"a":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}}},"meta":{"2":[{"2":n40...` |

**seam-v4-v4later** (3,000 roots explained)

| roots | what the record met; then how each side answered | example: the row before; the record; the row after on each side |
|---|---|---|
| 2,595 | update deep; under object > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 26: before `{"10":n406bbc00.0,"n":n40777000.0,"s":"null","tags":[],"a":N}`; record `{"type":n0.0,"key":["k9417","s","10"],"value":n407e6000.0}`; dc65b8f: applied, `{"10":n406bbc00.0,"n":n40777000.0,"s":{"0":"n","1":"u","2":"l","3":"l","10":n407e6000.0},"tags":[],"a":N}`; 2b8b780: applied, `{"10":n406bbc00.0,"n":n40777000.0,"s":{"10":n407e6000.0},"tags":[],"a":N}` |
| 214 | update deep; under object > array > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 56: before `{"n":n407ca000.0,"s":"42","tags":["u95360","true"],"meta":{"10":n40533800.0,"tags":n40717000.0,"b":{"b":n408a9...`; record `{"type":n0.0,"key":["k17987","tags","0","a"],"value":{"0":n4061c000.0,"tags":n408a5800.0,"meta":n407ff000.0,"s...`; dc65b8f: applied, `{"n":n407ca000.0,"s":"42","tags":[{"0":"u","1":"9","2":"5","3":"3","4":"6","5":"0","a":{"0":n4061c000.0,"tags"...`; 2b8b780: applied, `{"n":n407ca000.0,"s":"42","tags":[{"a":{"0":n4061c000.0,"tags":n408a5800.0,"meta":n407ff000.0,"s":{}}},"true"]...` |
| 142 | update deep; under object > object > string; leaf none // dc65b8f: taken / 2b8b780: taken | record 2,844: before `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":"日本語","meta":{"2":n4084c000.0}},"a":N,"b":U}`; record `{"type":n0.0,"key":["k6502","meta","b","10"],"value":{"x.y":{"0":"0","a":n444b1ae4.d6e2ef50},"tags":U}}`; dc65b8f: applied, `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":{"0":"日","1":"本","2":"語","10":{"x.y":{"0":"0","a":n444b...`; 2b8b780: applied, `{"10":n4085f800.0,"s":"0","tags":[],"meta":{"10":U,"b":{"10":{"x.y":{"0":"0","a":n444b1ae4.d6e2ef50},"tags":U}...` |
| 49 | update deep; under object > string > absent; leaf none // dc65b8f: taken / 2b8b780: taken | record 7,274: before `{"n":n404f8000.0,"s":"42","tags":"a\u0000b","meta":{"2":[{"2":n408df000.0,"s":U,"n":n433fffff.ffffffff,"é":T},...`; record `{"type":n0.0,"key":["k7216","tags","0","a"],"value":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}}`; dc65b8f: applied, `{"n":n404f8000.0,"s":"42","tags":{"0":{"0":"a","a":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}},"1":"\u0000","...`; 2b8b780: applied, `{"n":n404f8000.0,"s":"42","tags":{"0":{"a":{"2":nc0658c00.0,"meta":{},"a":n4073d000.0}}},"meta":{"2":[{"2":n40...` |


### Views: Node 22 against Node 26, and a view that watched every record against one built at the end

| data commit | view | Node 22 = Node 26 | live = rebuilt (content) | live = rebuilt (order too) |
|---|---|---|---|---|
| ff85e6c | length | yes | yes | yes |
| ff85e6c | sum(n) raw field | yes | yes | yes |
| ff85e6c | sum of finite n | yes | yes | yes |
| ff85e6c | sum of n/10 | yes | yes | yes |
| ff85e6c | avg of n/10 | yes | yes | yes |
| ff85e6c | max of finite n | yes | yes | yes |
| ff85e6c | filter n>500 | yes | yes | no |
| ff85e6c | group by s | yes | yes | no |
| ff85e6c | az by s (code units) | yes | **no** | no |
| ff85e6c | az by s (localeCompare) | yes | **no** | no |
| ff85e6c | top 10 by n | yes | **no** | no |
| dc65b8f | length | yes | yes | yes |
| dc65b8f | sum(n) raw field | yes | yes | yes |
| dc65b8f | sum of finite n | yes | yes | yes |
| dc65b8f | sum of n/10 | yes | yes | yes |
| dc65b8f | avg of n/10 | yes | yes | yes |
| dc65b8f | max of finite n | yes | yes | yes |
| dc65b8f | filter n>500 | yes | yes | no |
| dc65b8f | group by s | yes | yes | no |
| dc65b8f | az by s (code units) | yes | **no** | no |
| dc65b8f | az by s (localeCompare) | yes | **no** | no |
| dc65b8f | top 10 by n | yes | **no** | no |
| 63fea66 | length | yes | yes | yes |
| 63fea66 | sum(n) raw field | yes | yes | yes |
| 63fea66 | sum of finite n | yes | yes | yes |
| 63fea66 | sum of n/10 | yes | yes | yes |
| 63fea66 | avg of n/10 | yes | yes | yes |
| 63fea66 | max of finite n | yes | yes | yes |
| 63fea66 | filter n>500 | yes | yes | no |
| 63fea66 | group by s | yes | yes | no |
| 63fea66 | az by s (code units) | yes | **no** | no |
| 63fea66 | az by s (localeCompare) | yes | **no** | no |
| 63fea66 | top 10 by n | yes | **no** | no |

ff85e6c, Node 22: sum(n) raw field live NaN (7ff80000.0), rebuilt NaN (7ff80000.0); sum of n/10 live 5.393079404586948e+307 (7fd33333.33333333), rebuilt 5.393079404586948e+307 (7fd33333.33333333); avg of n/10 live 8.900939766606615e+303 (7f09f589.e1ef1dce), rebuilt 8.900939766606615e+303 (7f09f589.e1ef1dce); same sort-field sequence live and rebuilt: {'az by s (code units)': True, 'az by s (localeCompare)': True, 'top 10 by n': True}

dc65b8f, Node 22: sum(n) raw field live NaN (7ff80000.0), rebuilt NaN (7ff80000.0); sum of n/10 live 5.393079404586948e+307 (7fd33333.33333333), rebuilt 5.393079404586948e+307 (7fd33333.33333333); avg of n/10 live 8.900939766606615e+303 (7f09f589.e1ef1dce), rebuilt 8.900939766606615e+303 (7f09f589.e1ef1dce); same sort-field sequence live and rebuilt: {'az by s (code units)': True, 'az by s (localeCompare)': True, 'top 10 by n': True}

63fea66, Node 22: sum(n) raw field live NaN (7ff80000.0), rebuilt NaN (7ff80000.0); sum of n/10 live 5.393079404586948e+307 (7fd33333.33333333), rebuilt 5.393079404586948e+307 (7fd33333.33333333); avg of n/10 live 8.900939766606615e+303 (7f09f589.e1ef1dce), rebuilt 8.900939766606615e+303 (7f09f589.e1ef1dce); same sort-field sequence live and rebuilt: {'az by s (code units)': True, 'az by s (localeCompare)': True, 'top 10 by n': True}

### One record that sets an array's length

| Node | length set to | bytes of that record | one later write under the array | a write beside it | the row encoded for the wire |
|---|---|---|---|---|---|
| v22.22.0 | 1,000 | 39 | 0.032 ms | 0.041 ms | 1,041 bytes in 2.111 ms |
| v22.22.0 | 100,000 | 40 | 0.509 ms | 0.033 ms | 100,042 bytes in 14.831 ms |
| v22.22.0 | 10,000,000 | 41 | 73.651 ms | 0.041 ms | 10,000,043 bytes in 279.295 ms |
| v22.22.0 | 100,000,000 | 41 | 4085.733 ms | 0.008 ms | not tried |
| v26.13.0 | 1,000 | 39 | 0.019 ms | 0.026 ms | 1,041 bytes in 1.213 ms |
| v26.13.0 | 100,000 | 40 | 0.526 ms | 0.032 ms | 100,042 bytes in 10.367 ms |
| v26.13.0 | 10,000,000 | 41 | 69.321 ms | 0.034 ms | 10,000,043 bytes in 300.845 ms |
| v26.13.0 | 100,000,000 | 41 | 4346.789 ms | 0.01 ms | not tried |

### Names that are also names on Object.prototype

| data commit | Node | case | rows in the engine | rows in the public snapshot | Object.prototype changed | row a afterwards |
|---|---|---|---|---|---|---|
| b831319 | v22.22.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| b831319 | v22.22.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| b831319 | v22.22.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| b831319 | v22.22.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |
| 46df5f9 | v22.22.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| 46df5f9 | v22.22.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| 46df5f9 | v22.22.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| 46df5f9 | v22.22.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |
| ff85e6c | v22.22.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| ff85e6c | v22.22.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| ff85e6c | v22.22.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| ff85e6c | v22.22.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |
| dc65b8f | v22.22.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| dc65b8f | v22.22.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| dc65b8f | v22.22.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| dc65b8f | v22.22.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |
| 2b8b780 | v22.22.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| 2b8b780 | v22.22.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| 2b8b780 | v22.22.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| 2b8b780 | v22.22.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |
| 63fea66 | v22.22.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| 63fea66 | v22.22.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| 63fea66 | v22.22.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| 63fea66 | v22.22.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |
| 63fea66 | v26.13.0 | row key __proto__ | __proto__, a | a | no | own keys ['x']; reads .polluted = None; plain prototype: True |
| 63fea66 | v26.13.0 | field path __proto__ | a | a | no | own keys ['x']; reads .polluted = yes; plain prototype: False |
| 63fea66 | v26.13.0 | field path constructor.prototype | a | a | no | own keys ['x', 'constructor']; reads .polluted = None; plain prototype: True |
| 63fea66 | v26.13.0 | row keys constructor, toString | constructor, toString | constructor, toString | no |  |

### JavaScript behaviours: Node 22 against Node 26

67 probes, 14 differ (6 of them are the version strings themselves).

| probe | Node 22 | Node 26 |
|---|---|---|
| version.node | `22.22.0` | `26.13.0` |
| version.v8 | `12.4.254.21-node.33` | `14.6.202.34-node.40` |
| version.icu | `77.1` | `78.3` |
| version.unicode | `16.0` | `17.0` |
| version.cldr | `47.0` | `48.0` |
| version.tz | `2025b` | `2026e` |
| math.pow | `3ff6a09e667f3bcd 3ee4f8b588e368f0 40caea4e6126bb96 3fdb8d809c615f41 424dd7a73d040917 4023ffffffffffff` | `3ff6a09e667f3bcd 3ee4f8b588e368f1 40caea4e6126bb95 3fdb8d809c615f41 424dd7a73d040917 4023ffffffffffff` |
| math.new | `["undefined","undefined"]` | `["undefined","function"]` |
| regexp.props | `["011","001","001","011","101","101","000","000","101"]` | `["011","001","001","011","101","101","011","001","101"]` |
| regexp.flags | `["v","d","s","y","undefined"]` | `["v","d","s","y","function"]` |
| date.zoneOffsets2027 | `Africa/Casablanca=GMT+01:00,GMT+01:00,GMT+01:00,GMT+01:00` | `Africa/Casablanca=GMT+00:00,GMT+00:00,GMT+00:00,GMT+00:00` |
| temporal | `undefined` | `object` |
| error.messages | `RangeError: Incorrect locale information provided` | `RangeError: Invalid language tag: xx-invalid-locale-tag-zzzz` |
| builtins | `Float16Array:undefined; Promise.try:undefined; Uint8Array.fromBase64:undefined; Uint8Array.prototype.toHex:undefined; Error.isError:undefined; Atomics.pause:undefined` | `Float16Array:function; Promise.try:function; Uint8Array.fromBase64:function; Uint8Array.prototype.toHex:function; Error.isError:function; Atomics.pause:function` |
