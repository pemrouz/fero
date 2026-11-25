# fero v5: the shapes in bytes

**A draft. Nothing here is fixed yet, and nothing is built.**

This page lists every shape that two programs must agree on byte for byte: what sits on disk, what goes over a link, and what crosses the line between Rust and JavaScript. Rules live in [ledger.json](ledger.json), each with the slice that turns it on; the slices are in [slices.json](slices.json). The system on one screen is [SYSTEM.md](SYSTEM.md). The design record (DECISIONS, LAYERS, BUILD, API and the experiments E-01 to E-67) is linked from SYSTEM.md; this page names its sections in the margins.

## 0. How to read this page

**The three states of a shape** (BUILD 2.4, 3.6).

| State | Meaning | When |
|---|---|---|
| **draft** | Open. Any field may change with no card | Now. Every shape on this page |
| **fixed for the build** | A change needs an owner's card. The format version rises, the golden byte file is made again, and no reader of the old form stays in the code | From the end of slice 1, but for a short list of open fields. No open field is left at the end of slice 3 |
| **fixed for users** | Bytes change only by adding | From the first public release |

Each shape below says which slice first builds it. A shape that slice 1 does not build stays a draft until its own slice.

**The state of one field.** Each table has a last column with one letter.

| Letter | Meaning |
|---|---|
| **S** | Settled. The record names this field, its meaning and its encoding |
| **P** | Draft pick. The record names the field and its meaning. Its size or encoding is this page's pick, the simplest that fits |
| **N** | Draft pick, new here. The record does not name the field. This page adds it because the shape cannot be read without it |
| **O** | OPEN. The record does not settle it. The number points at a question in section 12 |

**How claims are marked.** *(checked)* means read in the record, with the place named. *(reasoned)* means argued here from the record. *(a guess)* means neither. No number on this page is measured here.

**One caution.** The record settles what most fields mean. It settles almost no sizes: it was written about rules, and the bytes were left for this page *(checked: BUILD 1.1, READY section 3)*. So most rows are P, and each P is a proposal for slice 1 to test. The thin path is the test of the shapes *(checked: BUILD 3.1)*.

**The count today** *(counted by a script over the field tables of sections 1 to 10; a row with two letters counts as its least settled one)*: 228 rows. 41 are S, 106 are P, 34 are N, and 47 are O. So 181 rows have a value to build against, and 47 wait on one of the 30 questions of section 12.

## 1. The basic encodings

Every shape is built from these. They are one draft pick together (question 1).

| Name | Bytes | Meaning | State |
|---|---|---|---|
| `u8`, `u16`, `u32`, `u64` | 1, 2, 4, 8 | A whole number, least significant byte first | P |
| `varint` | 1 to 10 | A whole number below 2^64, seven bits a byte, low bits first, the top bit of each byte says "more". Only the shortest form is legal | P |
| `bytes` | `varint` length, then the bytes | A run of bytes | P |
| `text` | as `bytes` | UTF-8. A leading U+FEFF is text, never dropped | P |
| `crc` | `u32` | CRC-32/IEEE over the bytes the shape names (V5-9 pick 2; V5-23 item 3 names the algorithm, not one library's function) | S |
| `id16` | 16 | A random 128-bit id | P |

Why "only the shortest form": a client's record bytes become part of a batch only after a strict decode shows them canonical *(checked: LAYERS 1.4, build note PA-5)*. One legal form per value makes that check a plain decode.

**Limits** *(checked: LAYERS 1.4; API 8)*. A Raft batch is at most 1 MB. A catch-up frame is at most 4 MB, sent in chunks of 64 KB or less. A frame that carries many groups is cut at 1 MB. A record is at most 1 MB. A row is at most 64 MB. A value nests at most 60 deep. All S. How a record of nearly 1 MB fits a batch of 1 MB is question 27.

## 2. Names: who and what

| Name | Bytes | Meaning | State |
|---|---|---|---|
| project | `text` | The project a process serves. Named in `HELLO` and in the boot record | S (field), P (encoding) |
| resource name | `text` | The name given to `fero(name)` | S (field), P (encoding) |
| resource id | `id16` | Made once when the resource is founded. A founder first holds a candidate id, then the adopted one | P, question 5 |
| group number | `u16` | A group inside one resource. The home group is 0 | P, question 6 |
| group name | resource id, then group number: 18 bytes | Names one group on a journal row and in a Raft message | P, question 6 |
| group incarnation | `varint` | Rises when a group is made again. Names old segments and snapshots in the store | S (field), P (encoding) |
| slot | `u16`, 0 to 4,095 | A fixed hash bucket of partitions. A partition's slot comes from its hash, so a position never says it | S (count, A-16 in LAYERS 0.1), P (encoding) |
| member id | `id16` | One server process's dir. It is the disk incarnation: a new or wiped disk can never repeat one | S (128 bits, DESIGN-V5 4.1), question 5 for its use as the member's name |
| peer id | `u64` | The id the ported Raft uses for a voter or learner, as etcd's does | O, question 5 |
| session id | `u64` | One client process's life. A restarted process takes a new one | O, question 5 |
| call id | `varint` | A session's count of its attempts. It only rises | S (field), P (encoding) |
| attempt id | session id, then call id | Names one write attempt, so a retry is never applied twice | S |

Rules that depend on these: `client-sessions`, `caller-keys`, `disk-incarnation`, `raft-config`, `genesis-conditional-create`, `slot-table`, `restore-mark` (later).

## 3. Positions, versions and cursors

A position is a place in one slot's order. It never names a group, so a slot move breaks no cursor, version or fence *(checked: DESIGN-V5 section 2)*.

### 3.1 A position, in bytes

Shape state: **draft**. Built in slice 1.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | epoch | `varint` | The slot's epoch. It rises at a slot move and at a restore. A position from an older epoch never looks newer | S (field), P (encoding) |
| 2 | sequence | `varint` | The slot's own count, stamped by the leader in log-end order. It has gaps where other partitions of the slot wrote | S (one varint, DESIGN-V5 4.3) |

Where a slot must be said (a cursor, a `DELTA`), a `u16` slot goes first.

### 3.2 A version, as a number and as text

Shape state: **draft**. Built in slice 1. The text is seen by users, so it is the first shape to become fixed for users.

| # | Field | Form | Meaning | State |
|---|---|---|---|---|
| 1 | the number | below 2^63: the epoch in the high bits, the sequence in the low bits | Keeps one partition's order under plain `<`, across failovers, moves and restores. `fero.version.toNumber(v)` gives it | S (below 2^63, order), O question 7 for the split. Draft pick: 16 bits of epoch, 47 of sequence |
| 2 | length character | 1 character | How many digits follow, as one digit of the same alphabet. It makes shorter text sort first | S (API 3.10; E-56) |
| 3 | digits | 1 to 13 characters, base 32, most significant first | The number. Example: `38S9` | S (Crockford's base 32: digits and capitals without I, L, O, U; CONNECT 3) |

The same text is used everywhere: an answer's version, a commit's version, a diff entry, `if: { version }`, a lock token and `from` *(checked: API 3.10)*. A mark packs as sequence × 256 + w and so needs sequences below 2^45; past that it takes a pair form *(checked: LAYERS 3.2)*. The draft split leaves room for both.

### 3.3 A cursor

Shape state: **draft**. Built in slice 1.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | format | `u8` | The cursor layout's version | N |
| 2 | resource id | `id16` | A cursor of another resource is refused `bad-cursor` | S (field) |
| 3 | incarnation | `varint` | The resource's incarnation. A cursor from before a restore is refused `bad-cursor` | S (field), P (encoding) |
| 4 | count | `varint` | How many slots follow, at most 4,096 | P |
| 5 | per slot: slot | `u16` | Which slot | P |
| 6 | per slot: position | as 3.1 | The reader's place in that slot | S (field) |

As text, a cursor is these bytes in base64url: 28 to 35 characters for one partition *(checked: API 3.10, E-56)*, 4 to 13 KB for a whole resource *(reasoned there)*. Slots in a run could be packed tighter; that is question 29.

Rules that depend on section 3: `slot-sequence`, `fence-tokens`, `subscribe`, `restore-mark` (later), `srchi-marks`, `slot-move`, `lock-rows`.

## 4. A value

Shape state: **draft**. Built in slice 1. **The whole shape is OPEN (question 2).**

The record puts off one choice: the value as JSON with a tagged escape (V5-9, PA-1b). It also says to decide in or out before the shapes are fixed *(checked: READY section 3)*. The draft pick is the simpler thing to state today: one binary form with a tag byte, the kind v4 ran *(checked: v4's codec)*. It needs no escape rule and no second parser.

| Tag | Name | Bytes after the tag | State |
|---|---|---|---|
| 1 | null | none | P |
| 2 | undefined | none | P |
| 3 | false | none | P |
| 4 | true | none | P |
| 5 | int | `varint`, zigzag, for whole numbers within ±2^31 that are not -0 | P |
| 6 | float | 8 bytes, IEEE 754, so NaN and -0 arrive unchanged | P |
| 7 | text | `text` | P |
| 8 | object | `varint` count, then each key as `text` and its value | P |
| 9 | array | `varint` count, then each value | P |
| 10 | bytes | `bytes` | P |

A value that would not arrive unchanged (a bigint, a function, a `Date`, a `Map`, deeper than 60) is refused `unencodable` before it is sent *(checked: API 8)*. Whether object keys keep their written order is part of question 2.

Rules that depend on it: `fold-version`, and every rule that compares a value at the leader (the `equals` guard, V5-15).

## 5. A record and a batch

### 5.1 A change (fero's Rec)

Shape state: **draft**. Built in slice 1.

A change is `data`'s change record without the `move` type: `{ type, key, value, at }` *(checked: API 6)*. A client sends changes in this exact encoding. A leader copies the bytes into the log once a strict decode shows them canonical; if not, it encodes them again *(checked: LAYERS 1.4)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | type | 2 bits of the record's kind byte (5.2 field 2) | 0 update, 1 insert, 2 remove | S (three types), P (codes) |
| 2 | key | `varint` count, then each step: a `u8` tag (1 text, 2 number), then `text` or a `varint` | The path: the row's key, then the steps inside the row | S (field), P (encoding) |
| 3 | at | one step, as in the key; present when a flag says so | For an ordered insert, the place. For a new row, the row's key | S (field), P (encoding) |
| 4 | value | as section 4; absent on a remove | The new value | S (field), O question 2 |

### 5.2 A record in the log

Shape state: **draft**. Built in slice 1. Open fields close with their models, by the end of slice 3.

A record's offset is never stored: it is the batch's base offset plus the record's index *(checked: DESIGN-V5 4.3)*. Its term and its writer time are the batch's.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | length | `varint` | Bytes of the rest of this record, so a reader can skip it | N |
| 2 | kind | `u8` | Bits 0 to 1: the change's type. Bits 2 to 4: the record kind (section 11.3). Bit 5: has `at`. Bit 6: has a mark. Bit 7: has more flags (field 3) | P |
| 3 | more flags | `u8`, only when bit 7 is set | Kept for an expiry time and `while: 'session'` (slice 4), and for an answer stage (built second). Zero bits must be zero | O, question 21 |
| 4 | slot sequence | `varint` | The slot's next sequence, read from the log end | S |
| 5 | session id | `u64` | Whose attempt this is | S (field), O question 5 |
| 6 | call id | `varint` | Which attempt of that session | S (field), P (encoding) |
| 7 | write number | `varint` | The writer's count of its writes to this partition, so writes sent together commit in the order made. A later one that arrives first is refused `gap` | O, question 9 |
| 8 | mark: reader | `text`, when bit 6 is set | The deriver's or consumer's name | S (field), O question 30 |
| 9 | mark: source slot | `u16`, when bit 6 is set | The slot of the source record this write came from | S (field), P (encoding) |
| 10 | mark: place | `varint`, when bit 6 is set | The source record's sequence × 256 + the write's number within that record. At most 256 outputs of one record to one slot | S (LAYERS 3.2) |
| 11 | the change | as 5.1 | What changed. Absent for a refusal outcome and a bare mark | S |

Three things are not in a record, on purpose *(reasoned)*. The slot: it is the hash of the key's partition. The epoch: question 8. The guard (`if`): it is judged at the leader and only the result is logged.

**Record kinds in slice 1**: a data change; a refusal outcome (the refusal of a resent attempt, logged with no data so a late copy gets the same answer); a bare mark. The other kinds are listed in 11.3 and take their fields in their own slices.

Rules that depend on it: `slot-sequence`, `client-sessions`, `srchi-marks`, `writer-judging`, `writer-time`, `raft-log`, `fold-all`, `subscribe`, `presence-rows`, `fence-tokens`.

### 5.3 A batch

Shape state: **draft**. Built in slice 1.

A batch is the records one leader appends together. It is encoded once. The same bytes go to the journal, to each follower and, where bytes can route, to subscribers *(checked: LAYERS 1.4, "encode once")*. One checksum covers all of it, made where the batch is made and checked once per receiver. It is per batch, never per record *(checked: LAYERS 1.3; V5-9)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | length | `u32` | Bytes of the whole batch, the checksum included. At most 1 MB | N |
| 2 | group | 18, as section 2 | Which group's log this is | S (field, under the checksum), P (encoding) |
| 3 | term | `u64` | Which leader wrote it. A deposed leader cannot commit | S (field), P (size) |
| 4 | index | `u64` | The Raft index of this batch as one Raft entry | O, question 4 |
| 5 | base offset | `u64` | The offset of the first record. Record i has offset base + i | S (field), P (size) |
| 6 | writer time | `u64`, milliseconds since 1970 | The time of every record in the batch. It never goes back, across a handover too | S (field), P (size and unit) |
| 7 | entry kind | `u8` | 0 records, 1 a member change. An empty batch of kind 0 is a new leader's first entry | N |
| 8 | count | `u32` | How many records follow. Fixed size, so it can be filled in last | P |
| 9 | records | as 5.2, or one member change | The content | S |
| 10 | checksum | `crc` over fields 1 to 9 | Finds damage. A copy with a bad batch marks it, grants no vote and repairs from a peer | S (V5-9 pick 2) |

A member change's body is the ported Raft's own (etcd's ConfChangeV2: voters and learners to add or drop). Its bytes are OPEN until slice 0's port lands (question 11).

Rules that depend on it: `batch-checksum`, `journal`, `raft-log`, `raft-commit`, `raft-config`, `par-repair`, `disk-incarnation`, `writer-time`, `bulk-rate-cap`.

## 6. The journal and the dir

### 6.1 The dir's files

Shape state: **draft**. The journal, the lock file and the boot record are built in slice 1. Group segments and local snapshots come in slice 2. The store's objects come later still.

Every file name carries the lease epoch of the process that wrote it. A holder writes only files of its own epoch. Files roll by a new file and an unlink, never by cutting in place *(checked: `dir-lease.14`, `dir-lease.18`)*.

| File | Name (draft pick) | Holds | State |
|---|---|---|---|
| lock | `lock` | The holder: pid, host, start time. Put in place in one atomic step | S (fields), O question 16 for the encoding |
| boot record | `boot-<epoch>` | 6.2 | S (fields), P (name) |
| journal segment | `journal-<epoch>-<first chain number>` | Journal rows, 6.4 | S (epoch in the name), P (the rest) |
| retired folder | `retired-<epoch>/` | The old holder's files, read-only, never past the end the boot record names | S |
| resource id | `resource-<name hash>-<epoch>` | Per resource: nothing, a candidate id, an adopted id, or the id of a copy held | S (content), O question 16 |
| group segment | not named yet | A group's entries with indexes by offset, slot and partition | O, question 3 |
| reserve segment | not named yet | At least 1 MiB kept for removes, votes, member changes, handovers and retention marks | S (size, E-29), O question 3 |
| local snapshot | not named yet | Section 9 | slice 2 |
| recorder tape | `tape-<epoch>-<first event number>` | Section 10 | P |

### 6.2 The file header and the boot record

Every binary file starts with the same header *(N: one rule, "a version on every file", READY section 3)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | magic | 4: `F5 46 45 52` | Says "a fero v5 file" | N |
| 2 | file kind | `u8` | Section 11.4 | N |
| 3 | format version | `u16` | The layout's version. A reader refuses a version it cannot read | S (a version on every file), P (size) |
| 4 | reserved | `u8` | Zero | N |
| 5 | lease epoch | `u64` | The holder that wrote the file | S (field), P (size) |
| 6 | member id | `id16` | The disk incarnation. A file of another dir is refused | S (field) |
| 7 | checksum | `crc` over fields 1 to 6 | | N |

The boot record is the header, then:

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | project | `text` | A dir of another project is refused `wrong-project` | S (field) |
| 2 | retired folder's epoch | `u64`, 0 for none | The folder the new holder renamed before it read it | S (field), P (encoding) |
| 3 | end | `u64` | The journal byte offset in the retired folder that this holder reads to, and never past | S (field), P (encoding) |
| 4 | peer id | `u64` | This copy's Raft id | O, question 5 |
| 5 | checksum | `crc` over fields 1 to 4 | | N |

### 6.3 One journal row

Shape state: **draft**. Built in slice 1.

One journal per process holds every group's rows. Writes go through one stream in order. An fsync covers only bytes written before it began. Recovery walks the chain and stops at the first row that lacks the next number; it never skips a bad row to carry on *(checked: `journal.1`, `journal.2`, `journal.3`)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | kind | `u8` | 1 a batch, 2 a term and vote, 3 a cut (section 11.5) | S (three kinds), P (codes) |
| 2 | reserved | 3 bytes | Zero | N |
| 3 | body length | `u32` | Bytes of the body | N |
| 4 | chain number | `u64` | One more than the row before it, for the whole journal | S (field), P (size) |
| 5 | group | 18, as section 2 | Which group the row belongs to | S (field), P (encoding) |
| 6 | reserved | 2 bytes | Zero. It brings the header to 40 bytes | N |
| 7 | header checksum | `crc` | Over fields 1 to 6. For kinds 2 and 3 it also covers the body | S (its own small checksum), O question 14 for size and reach |
| 8 | body | by kind | A batch (5.3) with its own checksum; or 6.4; or 6.5 | S |

So every byte that boot, repair or the disk check trusts sits under a checksum *(checked: `batch-checksum`)*.

### 6.4 The body of a term and vote row

A term or a vote is never used before its own fsync *(checked: DESIGN-V5 4.1)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | term | `u64` | The group's current term on this copy | S (field), P (size) |
| 2 | vote | `u64`, 0 for none | The peer id this copy voted for in that term | S (field), P (size) |
| 3 | commit | `u64` | The commit index, as etcd's stored state keeps it | O, question 14 |

### 6.5 The body of a cut row

A follower writes a cut before the entries that replace its tail. Boot replays cuts in order *(checked: `journal.7`, `journal.8`)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | last offset kept | `u64` | Everything after it in this group's log is gone | S (field), P (size) |
| 2 | last index kept | `u64` | The same place as a Raft index | O, question 4 |

### 6.6 A journal segment

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | file header | 6.2 | | N |
| 2 | first chain number | `u64` | The chain number of the first row. The name carries it too, and the next segment's name says where this one ends | S (end from the next name, `journal.4`), P (encoding) |
| 3 | from the reserve | `u8` | 1 when the segment was opened from the reserve, so data cannot ride in behind the row that opened it | S (`journal.14`, on in slice 2), P (encoding) |
| 4 | rows | 6.3, one after another | A torn or short row at the very end is cut at boot | S |

Segments are made ahead of use *(checked: LAYERS 1.2)*. Their size is question 15.

Rules that depend on section 6: `journal`, `batch-checksum`, `dir-lease`, `disk-incarnation`, `par-repair`, `raft-term-vote`, `raft-log`, `input-recorder`, `genesis-conditional-create`, `cluster-version`.

## 7. The wire

### 7.1 A frame

Shape state: **draft**. Built in slice 1, on plain TCP. TLS is timed from slice 1 and turned on with the door in slice 7. WebSocket comes with the browser client (question 28).

One link joins a pair of machines and serves every group and resource they share. A frame is sent at the end of the round that made it, and one frame carries the messages of every group the two share *(checked: DESIGN-V5 4.1; LAYERS 1.4)*. So a frame is a header and then one or more messages.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | magic | `u8`: `0xF5` | Says "a fero v5 frame" | N |
| 2 | protocol version | `u8` | The sender's protocol version, on every frame | S (`cluster-version.1`), P (size) |
| 3 | reserved | `u16` | Zero | N |
| 4 | body length | `u32` | Bytes of all the messages. A frame over its cap ends the link | P |
| 5 | header checksum | `crc` | Over fields 1 to 4 and over each message's bytes that no batch checksum covers | S (the frame header has its own checksum), O question 10 for its reach |
| 6 | messages | 7.2, one after another | | S |

### 7.2 A message

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | verb | `u8` | Section 11.1 | S (20 verbs), P (codes) |
| 2 | flags | `u8` | By verb. A bit a verb does not name must be zero | P |
| 3 | length | `u32` | Bytes of the body. Fixed size, so it can be filled in last | P |
| 4 | body | by verb | Sections 7.3 to 7.6 | |

A receiver that meets a verb it does not know ends the link *(reasoned: fail closed, as v4's codec does)*. Raft verbs are taken only on links from members that passed the door; on a client link they end it *(checked: DESIGN-V5 4.1)*.

### 7.3 The link family (L0)

**`HELLO`**, once per link. It names no resource *(checked: LAYERS 7)*. Slice 1.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | project | `text` | A peer of another project is refused `wrong-project` | S |
| 2 | protocol version | `u8` | The sender's version, as in every frame header | S |
| 3 | lowest version | `u8` | The oldest protocol the sender can still speak, for a roll | N |
| 4 | role | `u8` | 1 a member, 2 a client | N |
| 5 | member id | `id16`; zero from a client | Who is calling | N, question 5 |

**`PING`**, when no other frame went that way for `ping.ms`. Any frame is a sign of life. Slice 1.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | clock | `u64`, milliseconds since 1970 | The sender's clock, for writer time | S (field), P (size and unit) |
| 2 | says of itself | flags: bit 0 draining, bit 1 retiring | What the sender says of itself | S (field), P (encoding) |

**`DOOR`** carries the handshake: a nonce each way and a proof that cannot be replayed *(checked: `cluster-credentials`)*. **`DIAG`** serves the debugger. Both are built in slice 7. Their fields are O (question 28).

Rules that depend on it: `link-pings`, `writer-time`, `cluster-version`, `cluster-credentials`, `soft-directory`.

### 7.4 The Raft family (L1)

Every Raft message starts with the same fields. They are the ported Raft's message, which is etcd's *(checked: BUILD 3.3, P1)*. The field list is etcd's; the bytes are this page's.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | group | 18, as section 2 | Which group | S (every Raft verb carries its group), P (encoding) |
| 2 | from | `u64` | The sender's peer id | S (etcd), question 5 |
| 3 | to | `u64` | The receiver's peer id | S (etcd), question 5 |
| 4 | term | `u64` | The sender's term | S (etcd), P (size) |

Then, by verb:

| Verb | Slice | Fields after the common four | State |
|---|---|---|---|
| `VOTE` | 1 | last log term `u64`; last log index `u64`. Flag bit 0: this is a pre-vote. Flag bit 1: sent for a leader transfer | S (pre-vote is a `VOTE` with a flag), P (bytes) |
| `VOTED` | 1 | Flag bit 0: answers a pre-vote. Flag bit 1: refused | S (etcd), P (bytes) |
| `APPEND` | 1 | previous log term `u64`; previous log index `u64`; commit `u64`; a `varint` count of batches; the batches, each exactly as 5.3. Flag bit 0: a heartbeat, with no batch. Flag bit 1: a batch here holds a `replicated` write (built second) | S (carries a batch with its one checksum; the `replicated` flag, LAYERS 7), O question 11 for the heartbeat |
| `APPENDED` | 1 | index `u64`; hint index `u64`; hint term `u64`. Flag bit 0: refused. Flag bit 1: answers a heartbeat. Flag bit 2: an early report, "handed to the operating system" (built second) | S (etcd), O question 11 for the early report |
| `SNAPSHOT` | 2 | The snapshot's last index and term, the members at that index, then the snapshot's bytes in chunks (section 9) | O, question 22 |
| `TIMEOUT-NOW` | 2 | None. It serves hand-overs, the hand-back and lead hints | S (LAYERS 7), P |
| `QUIET` | 2 | index `u64`: "quiet at i" | O, question 11 |
| `REPAIR` | 2 | offset `u64` of the bad batch | O, question 11 |
| `REPAIRED` | 2 | the batch, exactly as 5.3 | O, question 11 |

An `APPEND` is written as a small header and then the batch's own bytes, untouched *(checked: LAYERS 1.4)*.

Rules that depend on it: `raft-log`, `raft-term-vote`, `raft-commit`, `raft-config`, `raft-prevote-checkquorum`, `raft-leader-transfer`, `raft-readindex`, `raft-snapshot`, `learners`, `quiet-groups`, `handback`, `par-repair`, `ack-stages` (later), `bulk-rate-cap`.

### 7.5 The ask family (L2 to L4)

**`ASK`** carries everything that asks a member to do something: a write, a call, an `alter`, a recover, a hint *(checked: LAYERS 7)*. Slice 1 builds the write and one call.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | ask number | `varint` | This link's count of its asks. The answer names it. An answer is taken only on the link its ask went out on | S (rule), N (field) |
| 2 | ask kind | `u8` | 1 a write, 2 a call, 3 an `alter`, 4 a recover, 5 a hint | S (the kinds), P (codes) |
| 3 | resource id | `id16`; zero on a client's first contact | Which resource | S (field), P (encoding) |
| 4 | resource check | when flag bit 0 is set: resource name `text`, protocol version `u8`, home group incarnation `varint` | Rides the first `ASK` or `SUB` for a resource on a link, and its answer | S (a reading of LAYERS 7, not modelled), O question 26 |
| 5 | session id | `u64` | Whose attempt | S (field), question 5 |
| 6 | call id | `varint` | Which attempt | S |
| 7 | floor | `varint` | The session's lowest call id not yet answered. Sent with every copy | S (`stream-numbers.9`) |
| 8 | copy number | `varint` | 0 for a first send, then 1, 2, … The client takes only the answer to its latest copy | S (field), P (0 means "not sent before") |
| 9 | time left | `varint`, milliseconds | The attempt's budget. Every hop takes off the time it held it | S (field), P (encoding) |
| 10 | write number | `varint` | As 5.2 field 7 | O, question 9 |
| 11 | stage wanted | `u8` | Section 11.6. Built second; 0 in the first step | S (field), P (encoding) |
| 12 | path | as a key, 5.1 field 2; a count of 0 for a root call | For a call, the lens's path. The leader refuses a path the method did not declare, `bad-path` | S (field), P (encoding) |
| 13 | count | `varint` | How many writes follow. They share one partition, or the ask is refused `cross-partition` | P |
| 14 | per write: the change | as 5.1, with a kind byte as 5.2 field 2 | What to change | S |
| 15 | per write: guard | `u8` kind, then its operand: 0 none; 1 `version`, a position; 2 `equals`, a value; 3 `absent`; 4 `present` | Judged at the leader. A failed guard answers `conflict` | S (the four guards, V5-15), P (codes) |
| 16 | per write: op | not drafted | The one conditional op of slice 1, and the others later | O, question 20 |
| 17 | per write: mark | as 5.2 fields 8 to 10, when the kind byte says so | A deriver's "this came from source record e" | S |
| 18 | call: method and argument | `text`, then a value | For ask kind 2 | S (field), P (encoding) |

A room write, a deriver's bump and the admin asks take their fields in their own slices (O).

**`ANSWER`**.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | ask number | `varint` | Which ask this answers | S (rule), N (field) |
| 2 | stage | `u8` | Section 11.6: received, replicated, or the committed result | S (LAYERS 7), P (codes) |
| 3 | code | `u8` | 0 for done, else a refusal code of section 11.7 | S (names), O question 19 |
| 4 | version | a position, 3.1; when done | The row's version at this write | S (`ack.version`, V5-13), P (encoding) |
| 5 | skipped | flag bit 0 | A marked write at or below its mark: handled before, not applied | S (V5-20 item 17), P (encoding) |
| 6 | retry after | `varint` milliseconds; with `no-leader`, `moved`, `retry` and the "not now" codes | When to try again | S (field), P (encoding) |
| 7 | where | `text`, an address; with `moved` | The server to ask instead | S (field), P (encoding) |
| 8 | current | a position; with `conflict` and `fenced` | The version or token the leader holds | S (field), P (encoding) |
| 9 | reason | `text`; with `rule`, `invalid`, `schema`, `threw` | The author's own words | S (field), P (encoding) |
| 10 | result | a value; for a call | What the method returned | S (field), question 2 |
| 11 | method table version | `varint` | A newer number tells the client to fetch the table again | S (a reading of LAYERS 7), O question 26 |
| 12 | resource check answer | when flag bit 1 is set: resource id, protocol version, home group incarnation, the method table | Answers field 4 of the ask | O, question 26 |

Rules that depend on it: `client-sessions`, `caller-keys`, `writer-judging`, `slot-table`, `route-smart`, `route-forward`, `srchi-marks`, `fence-tokens`, `ack-stages` (later), `cluster-version`, `soft-directory`, `restore-mark` (later).

### 7.6 The flow family (L3)

Slice 1 builds one selector: a whole resource, with resume from the ring. Fan-out sends committed bytes from the log to links inside Rust, many records per socket write *(checked: BUILD 2.2, 3.4)*.

**`SUB`**.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | sub number | `varint` | This link's count of its subscriptions. Later frames name it | N |
| 2 | resource id | `id16` | Which resource. The resource check rides here too, as 7.5 field 4 | S (field) |
| 3 | selector kind | `u8` | Section 11.8: the whole resource, a partition, and later kinds | S (the kinds), P (codes) |
| 4 | mode | `u8` | 1 `state`: a picture, then changes. 2 `log`: records from a place | S (a mode), P (codes) |
| 5 | group number | `u16` | Which group's part of the resource this link serves | N, question 6 |
| 6 | cursor | as 3.3 fields 4 to 6 | Where the reader is. Empty for "from now" | S |
| 7 | selector body | by kind: a partition's key; later, a view's method and argument, a page, a scan's pin | | S (partition), O for the later kinds |

**`SNAP`**, a picture: the rows at one place. It names its format and holds rows as key, version and bytes, never a dump of one engine's objects (V5-21 item 1). The subscriber clears its view, puts in the rows, then sets its cursor *(checked: `subscribe.11`, `subscribe.12`, `subscribe.13`)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | sub number | `varint` | | N |
| 2 | format | `u16` | Section 11.9. 1 is "rows as key, version and bytes" | S (a picture names its format), P (size) |
| 3 | part | flags: bit 0 first, bit 1 last | A picture too big for one frame comes in parts, between a first and a last | S (begin and end markers, DESIGN-V5 4.1), P (encoding) |
| 4 | cursor | as 3.3 fields 4 to 6; in the last part | The picture's place, one position per slot it covers | S |
| 5 | count | `varint` | Rows in this part | P |
| 6 | per row: key | as 5.1 field 2, one step | The row's key | S |
| 7 | per row: version | a position | The row's version | S |
| 8 | per row: bytes | `bytes`, holding a value | The row | S (field), question 2 |

**`DELTA`**, the changes of commits.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | sub number | `varint` | | N |
| 2 | slots touched | `varint` count, then per slot: slot `u16`, epoch `varint`, last sequence `varint` | The position of each slot this frame touched | S (field, V5-13), P (encoding), question 8 |
| 3 | count | `varint` | Records that follow | P |
| 4 | records | as 5.2, the log's own bytes | Each with its slot sequence, so each record's version | S (records with slot sequences), O question 17 |

**`END`**, either way. From a server it ends a subscription. From a subscriber it is the unsubscribe *(a reading of LAYERS 7)*.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | sub number | `varint` | | N |
| 2 | code | `u8` | Section 11.7: `moved`, `expired`, `retry`, `end`, and for views `redeployed`, `view-too-big` | S (names), question 19 |
| 3 | where | `text`; with `moved` | The server that serves it now | S (field), P (encoding) |
| 4 | earliest | a cursor; with `expired` | The oldest place still kept | S (field), P (encoding) |

**`CREDIT`** paces a link. It is built in slice 4. In slice 1 a slow link is cut with a code (question 18). Fields: sub number, credits as a `varint` (O).

Rules that depend on it: `subscribe`, `slot-sequence`, `slot-move`, `admission-credits`, `fold-version`, `restore-mark` (later), `meta-directory`, `client-sessions` (a writer's read of `#sessions`).

## 8. Records in the home log

Shape state: **draft**. Slice 1 builds the least of it: two groups fixed at founding and a fixed slot table. The rest opens in slices 2 and 3, and the slot move's carried set is on BUILD's list of fields that stay open past slice 1.

A resource's home log holds the records that say how the resource is laid out. Each is a record of a system kind (11.3), with these bodies.

| Record | Fields | Slice | State |
|---|---|---|---|
| settings | The first open's options as a value; the allowed code hashes; the write gate, open or read-only | 1 (options), 2 (the rest) | S (fields), O question 13 for the bytes |
| slot table | Runs of: first slot `u16`, run length `varint`, group number `u16`, then the slot's version: epoch, move name, writer incarnation, step. Nothing at all while every slot is in the home group | 1 (fixed), 3 (moves) | S (run-length coded; 56 to 196 B, E-36), O question 13 |
| group record | Per group: its members (peer id, member id, address), its leader as a hint, its incarnation | 1 | S (fields), P (bytes) |
| version | The protocol version the resource's entries and frames use | 2 | S (field), P (`u8`) |
| fold version | `data`'s schedule version and fero's L2 version in force from this offset | 2 | S (field, OPS-12), O question 13 |
| move entries | `exporting`, `importing`, `fenced(N)`, the copy and `END(N)`, `open`, `cancel`, `abort`, `unfenced`; the carried set | 3 | O, question 13 |

Rules that depend on it: `slot-table`, `slot-move`, `move-policy`, `meta-members`, `meta-catalog`, `meta-directory`, `cluster-version`, `fold-version`, `genesis-conditional-create`.

## 9. A snapshot

Shape state: **draft**. A picture on the wire (7.6) is built in slice 1. A local snapshot file is built in slice 2. A layer in the store comes later. All three name their format and hold rows the same way (V5-21 item 1).

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | file header | 6.2 | For a file | N |
| 2 | format | `u16` | Section 11.9 | S (field), P (size) |
| 3 | group | 18 | Whose rows | S (field), P (encoding) |
| 4 | last index and term | `u64`, `u64` | The log place the snapshot stands at, for Raft | S (etcd), P (bytes) |
| 5 | members | the member change body of 5.3 | The group's voters and learners at that place | S (etcd), O question 11 |
| 6 | cursor | as 3.3 fields 4 to 6 | One position per slot held | S |
| 7 | rows | in blocks: `varint` count, then per row its key, version and bytes as 7.6 fields 6 to 8, then a `crc` per block | The folded rows | S (key, version, bytes), N (blocks) |
| 8 | L2's tables | not drafted | What sits beside the rows: each session's outcomes and floor, the marks, the highest fence tokens, the last writer time | S (they ride a snapshot), O question 22 |

Rules that depend on it: `raft-snapshot`, `subscribe`, `client-sessions`, `srchi-marks`, `fence-tokens`, `tier`, `fold-version`, `forks` (later).

## 10. Across the line: the calls, the recorder and health

Rust holds the journal, Raft, the links and the fan-out. JavaScript judges writes and folds rows. Bytes cross in batches, into buffers the caller owns, and JavaScript is woken once per round, never once per record *(checked: BUILD 2.2)*.

### 10.1 The calls

Shape state: **draft**. Built in slice 1. The list is short and lives in one checked file; adding a call fails the build until a layer page names it.

| # | Call | Goes in | Comes out | State |
|---|---|---|---|---|
| 1 | hand in | A buffer of judged writes (10.2) | How many were taken | S (the call, BUILD 2.2), O question 24 |
| 2 | take | A buffer the caller owns | Items filled in (10.3), and how many bytes | S (the call), O question 24 |
| 3 | open or close a subscription | A `SUB` or `END` body (7.6) and the link | A sub number, or a code | S (the call), P |
| 4 | read health | A buffer the caller owns | Health rows (10.5) | S (the call), O question 25 |
| 5 | drain the recorder | A buffer the caller owns | Tape events (10.4) | S (the call), P |

### 10.2 A judged write, going down

JavaScript judges a write and stamps the slot's next sequence. Rust adds the term, the base offset and the checksum *(reasoned from SYSTEM.md's walk-through)*. Rust hands up the peers' clock readings from the pings with each round; JavaScript takes the median and stamps writer time, as the ledger has it (`writer-time.2`, `writer-time.3`; question 24).

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | group | 18 | Which group's log takes it | P |
| 2 | link and ask number | `u32`, `varint` | Where the answer goes | N |
| 3 | answer | as 7.5's `ANSWER` fields 3 to 11 | What to send once the record commits, or at once for a first send's refusal | N |
| 4 | records | as 5.2 | The records to append. None for a refusal that is not logged | S |

### 10.3 Items coming up

Each item is a `u8` kind, a `u32` length and a body.

| Kind | Body | State |
|---|---|---|
| 1 committed batches | group, then batches as 5.3, in offset order | S (committed batches in offset order; batches of 256 records, BUILD 3.3 P4), O question 24 |
| 2 an ask to judge | link, then an `ASK` body (7.5) | P |
| 3 leadership | group, gained or lost, term. On a loss, waiting answers become `unknown` | S (the event, LAYERS 2.4), P |
| 4 a picture to install | group, then a snapshot (section 9) | S (the event), slice 2 |
| 5 a served-view `SUB` to allow | link, then a `SUB` body | slice 5 |
| 6 the clocks | each peer's clock reading from the pings, `u64` milliseconds, for the round; L2 makes writer time from them | N, question 24 |

### 10.4 The recorder's tape

Shape state: **draft**. Built in slice 1, in the simulator first.

Every kernel input is recorded whole, in order, before the kernel steps on it. An input is a whole frame, never a socket chunk. Bulk bytes are recorded as a pointer into the journal, which holds them in arrival order, and the journal keeps what the tape's window points at *(checked: `input-recorder`; E-42)*. A recorded run replays in the simulator.

A tape file is a file header (6.2), then events.

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | kind | `u8` | Section 11.10 | S (the inputs, LAYERS 1.4), P (codes) |
| 2 | length | `varint` | Bytes of the body | N |
| 3 | body | by kind, below | | |

| Kind | Body | State |
|---|---|---|
| frame received | link `u32`, then the frame's bytes; for a frame that carries batches, the batches are left out and field "journal pointer" stands in | S |
| journal pointer | first chain number `u64`, count `varint` | S (by reference), P (encoding) |
| tick | the steady clock in nanoseconds `u64`; the wall clock in milliseconds `u64` | S (a tick is an input), P (encoding) |
| fsync done | the journal byte offset the fsync started from: the durable mark | S |
| store call done | call number `varint`, result code `u8` | S (the input), slice 2 or later |
| boot replay | the last chain number read `u64` | S (the input), P |
| bad batch found | group, offset `u64` | S (the input), P |
| writes handed in | a journal pointer to the batches they became | P |
| link up, link down | link `u32`; for up, the peer's `HELLO` body | N |

Whether the tape carries its own checksums, and how long its window is, is question 23. The kernel's effects are not on the tape: a replay makes them again and compares.

### 10.5 Health

Shape state: **draft**. Slice 1 builds the least of it; health is whole in slice 2 (OPS-02).

What users see is settled *(checked: API 6)*: `cluster.value` with `writable`, `me`, `members`, `groups`, `links` and `health`, where a health row is `{ kind, severity, since, message, fix }` and severity is `info`, `warn` or `down`. The text of `message` and `fix` is made in JavaScript. Rust hands up plain numbers.

One raw row, as Rust fills it:

| # | Field | Bytes | Meaning | State |
|---|---|---|---|---|
| 1 | row kind | `u8` | 1 a group, 2 a link, 3 the journal, 4 a wait | N |
| 2 | length | `varint` | Bytes of the rest | N |
| 3 | group row | group; role `u8` (leader, follower, candidate, learner); term; leader's peer id; commit offset; last offset; live voters `u8` of voters `u8`; per peer, its lag in records | Who writes, how many copies are live, lag | S (the facts, OPS-02), O question 25 |
| 4 | link row | link `u32`; up `u8`; milliseconds since last heard; bytes queued | Is the peer there, is the link slow | O, question 25 |
| 5 | journal row | durable mark; bytes written; free disk bytes; condemned `u8` | Is the disk keeping up, is it full, did an fsync fail | O, question 25 |
| 6 | wait row | what waits `u8`; reason code `u8` (11.7); since, milliseconds | Every wait with its reason | S (OPS-02), O question 25 |

Rules that depend on section 10: `input-recorder`, `journal`, `writer-judging`, `fold-all`, `subscribe`, `link-pings`, `slow-leader-self` (later), `healing-self`.

## 11. The one list of names and codes

Every number here is a draft pick (P). Every name is from the record unless marked. Numbers are never reused. A new name takes the next free number in its block.

### 11.1 Verbs

| Code | Verb | Family | Layer | First slice |
|---|---|---|---|---|
| `0x01` | `HELLO` | link | L0 | 1 |
| `0x02` | `DOOR` | link | L0 | 7 |
| `0x03` | `PING` | link | L0 | 1 |
| `0x04` | `DIAG` | link | L0 | 7 |
| `0x10` | `VOTE` | Raft | L1 | 1 |
| `0x11` | `VOTED` | Raft | L1 | 1 |
| `0x12` | `APPEND` | Raft | L1 | 1 |
| `0x13` | `APPENDED` | Raft | L1 | 1 |
| `0x14` | `SNAPSHOT` | Raft | L1 | 2 |
| `0x15` | `TIMEOUT-NOW` | Raft | L1 | 2 |
| `0x16` | `QUIET` | Raft | L1 | 2 |
| `0x17` | `REPAIR` | Raft | L1 | 2 |
| `0x18` | `REPAIRED` | Raft | L1 | 2 |
| `0x20` | `ASK` | ask | L2 to L4 | 1 |
| `0x21` | `ANSWER` | ask | L2 to L4 | 1 |
| `0x30` | `SUB` | flow | L3 | 1 |
| `0x31` | `SNAP` | flow | L3 | 1 |
| `0x32` | `DELTA` | flow | L3 | 1 |
| `0x33` | `END` | flow | L3 | 1 |
| `0x34` | `CREDIT` | flow | L3 | 4 |

20 verbs *(checked: LAYERS 7)*. Up to four more are open: a follower's early report, and the directory's announce, take back and look up (questions 11, 12). `SYNC` and `PAGE` ride the flow family and are not verbs of their own; they come in slice 5.

### 11.2 Value tags

Section 4. 1 null, 2 undefined, 3 false, 4 true, 5 int, 6 float, 7 text, 8 object, 9 array, 10 bytes. 0 is never a value.

### 11.3 Record kinds

| Code | Kind | First slice |
|---|---|---|
| 0 | a data change | 1 |
| 1 | a refusal outcome, with no data | 1 |
| 2 | a bare mark | 1 |
| 3 | an expiry: a remove the writer makes when writer time passes a row's end | 4 |
| 4 | a system record of the home log (section 8); its first body byte says which | 1 |
| 5 to 7 | not used | |

Change types: 0 update, 1 insert, 2 remove.

### 11.4 File kinds

1 boot record, 2 journal segment, 3 recorder tape, 4 local snapshot, 5 group segment, 6 resource id.

### 11.5 Journal row kinds

1 a batch, 2 a term and vote, 3 a cut.

### 11.6 Answer stages

| Code | Stage | Meaning | Built |
|---|---|---|---|
| 0 | committed | On disk at a majority. The only stage in the first step | slice 1 |
| 1 | `received` | The leader has appended the write | second |
| 2 | `replicated` | A majority holds it in memory | second |

A stage is a progress report. It changes nothing the servers do (V5-11). Only a plain write may take an early stage.

### 11.7 Refusal codes

The names and their groups are settled *(checked: API section 8)*. The numbers are draft picks, in blocks by what the caller should do. Whether the wire carries the number or the name, and which codes never travel, is question 19.

| Block | What to do | Codes, in number order |
|---|---|---|
| 1 to 49 | Fix the call | 1 `invalid-key`, 2 `unencodable`, 3 `bad-key`, 4 `bad-path`, 5 `bad-shape`, 6 `bad-name`, 7 `bad-arg`, 8 `field-ttl`, 9 `bad-target`, 10 `bad-position`, 11 `too-large`, 12 `room-too-large`, 13 `cross-partition`, 14 `no-rows`, 15 `absent-row`, 16 `absent-path`, 17 `sparse-hole`, 18 `schema`, 19 `invalid`, 20 `methods-only`, 21 `forbidden`, 22 `no-such-method`, 23 `derived`, 24 `too-many-outputs`, 25 `stale-client`, 26 `no-undo` |
| 50 to 69 | An expected answer: branch on it | 50 `conflict`, 51 `fenced`, 52 `rule`, 53 `rule-threw`, 54 `rule-timeout`, 55 `call-diverged`, 56 `threw`, 57 `locked`, 58 `limited`, 59 `no-answerer` |
| 70 to 89 | Not now: slow down | 70 `read-only`, 71 `disk-full`, 72 `backpressure`, 73 `too-many-views`, 74 `too-many-keys`, 75 `busy` |
| 90 to 99 | It may have committed | 90 `timeout`, 91 `unknown`, 92 `destroyed`, 93 `restored` |
| 100 to 119 | A read threw, or a link ended | 100 `not-held`, 101 `not-ready`, 102 `ended`, 103 `aborted`, 104 `expired`, 105 `bad-cursor`, 106 `redeployed`, 107 `view-too-big`, 108 `scan-lost`, 109 `schema-changed` |
| 120 to 139 | At open, to an admin, or in health | 120 `config`, 121 `config-differs`, 122 `dir-held`, 123 `wrong-project`, 124 `wrong-cluster`, 125 `bucket-collision`, 126 `no-server-here`, 127 `unbound`, 128 `admin-only` |
| 140 to 159 | Inside fero only: the client acts on them by itself | 140 `no-leader`, 141 `moved`, 142 `retry`, 143 `end`, 144 `gap`, 145 `stale-attempt`, 146 `empty` |

72 names. 0 means "done". Slice 1 can meet these on a wire *(reasoned from BUILD 3.4's "in" column)*: `conflict`, `absent-row`, `too-large`, `unencodable`, `cross-partition`, `no-such-method`, `threw`, `unknown`, `timeout`, `bad-cursor`, `expired`, `wrong-project`, `no-leader`, `moved`, `retry`, `end`, `gap`, `stale-attempt`. Each thing slice 1 leaves out is a named refusal too; their names are owed to the slice's page.

### 11.8 Selector kinds and modes

| Code | Selector | First slice |
|---|---|---|
| 1 | the whole resource | 1 |
| 2 | one partition | 4 |
| 3 | a one-time read | 4 |
| 4 | a log read from a place | 4 |
| 5 | a served view | 5 |
| 6 | a page | 5 |
| 7 | a partial's feed to its merger | 8 |
| 8 | a scan's page | 8 |
| 9 | the home group's records | 1 |
| 10 | a slot move's copy | 3 |

Modes: 1 `state`, 2 `log`.

### 11.9 Snapshot and picture formats

1: rows as key, version and bytes. No other format exists in the first build. Column blocks may come later as a second format (V5-21).

### 11.10 Tape event kinds

1 frame received, 2 journal pointer, 3 tick, 4 fsync done, 5 store call done, 6 boot replay, 7 bad batch found, 8 writes handed in, 9 link up, 10 link down.

## 12. The open questions

Each closes by a model, a probe of slice 0, a timing in slice 1, or an owner's card. The draft pick stands until then.

| # | Question | Draft pick | What closes it |
|---|---|---|---|
| 1 | Is the base encoding least-significant-byte-first with shortest-form varints? | Yes | Slice 1's codec guard between the Rust kernel and the TypeScript client |
| 2 | The value's encoding: a tagged binary form, or JSON with a tagged escape (V5-9 put it off; READY says decide before the shapes are fixed)? Do object keys keep their order? | Tagged binary; keys keep written order | An owner's card before the end of slice 1, with P4's fold timing beside it |
| 3 | One shared log per process, or a journal plus group segments (V5-9 put it off; as drafted every entry is written twice)? Does slice 1 write group segments at all? | Slice 1 writes the journal only and never cuts it; segments are drafted in slice 2 | An owner's card before slice 2, with slice 1's write timings |
| 4 | Is a batch one Raft entry with its own index, with offsets counting records apart? Or is each record an entry? | One entry per batch; the batch carries both its index and its base offset | Slice 0's Raft port (P1), then the write-numbering model |
| 5 | How long are the ids: resource, member, peer, session? Who makes a session id, the client or the `#sessions` registry? How is a Raft peer id tied to a disk incarnation? | 16 random bytes for a resource and a member; 8 random bytes for a peer and a session; the registry refuses a session id already taken | The founding model; a model of sessions; slice 1 |
| 6 | Does a journal row or a Raft message name its group in full (18 bytes), or by a short number agreed per process or per link? | In full | Slice 1's counted pin on bytes per record |
| 7 | How are a version's 63 bits split between epoch and sequence? (The alphabet is settled: Crockford's base 32, CONNECT 3.) | 16 and 47 | The read-cost timing in Rust (E-62 missed its 50 ns bar once a slot had moved) |
| 8 | Where does a slot's epoch ride: in every record, once per batch, or only in the slot's open entry and once per slot in a `DELTA`? | The open entry and the `DELTA` | The slot move's model (slice 3); it is on the list of fields open past slice 1 |
| 9 | Write numbering: one number per stream, or the five high marks (P5)? Which fields does a record and an `ASK` carry for it? | **One number per stream: settled by P5 (V5-30).** A write carries its stream, its number, the number before it and the floor (`stream-numbers.2`, `stream-numbers.9`); their fields and encoding are still the draft's | The fields: slice 1's codec |
| 10 | Does the frame's checksum cover message bodies that hold no batch? | Yes: everything but batch bytes, which have their own | Slice 1's link timing; the decoder's fuzz test |
| 11 | How do etcd's message types map onto the seven Raft verbs (heartbeat, its answer, read index, snapshot status)? Is the follower's early report a flag on `APPENDED` or a verb? What are a member change's bytes? What do `QUIET`, `REPAIR` and `REPAIRED` carry? | Flags on `APPEND` and `APPENDED`; etcd's own member change | P1's port; the repair model with lost and doubled messages (slice 2); the answer-stage step |
| 12 | Do the directory's announce, take back and look up need verbs of their own? | Not drafted | The model of founding and the directory together (slice 2) |
| 13 | The bytes of the home log's records: settings, the slot table's version, the fold version, the move entries and the carried set. Do a move's order and its `ready` need a verb? | Not drafted beyond section 8 | The one-commit slot move's model (READY M6), slice 3 |
| 14 | How big is the journal row's own checksum, and does it also cover a small body? Does a term and vote row keep etcd's commit index? | 4 bytes, the same algorithm; yes; yes | Slice 1; the power-cut test |
| 15 | How big is a journal segment, how many are made ahead, and what does its name carry? | 64 MiB *(a guess)*; one ahead; the epoch and the first chain number | P7 on real disks |
| 16 | Are the lock file, the boot record and the resource id file text or binary? | The lock is one line of text, as v4's; the others are binary with a checksum | Slice 1 (the lock's rules are v4's code and tests) |
| 17 | Does a `DELTA` carry the log's record bytes untouched, session and call ids included, or a form made for readers? | Untouched | PERF-11's pin in slice 1; a privacy check when the door lands (slice 7) |
| 18 | Which code cuts a slow link in slice 1, before credits exist? `busy` has two meanings in the record | Not picked | Slice 1's page; an owner's card for `busy` |
| 19 | Does a refusal travel as a number or as its name? Which codes never travel? | A number, one byte | Slice 1's codec guard |
| 20 | How is an op encoded: the one conditional op of slice 1, and the rest? | Not drafted | Slice 1's L2 page; slice 4 |
| 21 | Where do a row's expiry time and `while: 'session'` ride in a record? | The "more flags" byte, with fields after the call id | Slice 4 |
| 22 | How are L2's tables laid out in a snapshot? How is a big picture or snapshot cut into parts, and is each part checked? | Rows in blocks with a checksum each; tables not drafted | Slice 2; each table's own model |
| 23 | Does the tape checksum its events? How long is its window, and which config key sets it? | No checksum of its own in slice 1; the window is not picked | Slice 1's two recorder pins |
| 24 | What exactly crosses the line: the log's own batch bytes, or a leaner form for the fold? Who stamps writer time? | The log's own bytes; Rust hands up the clock readings from the pings, and L2 takes the median and stamps it (`writer-time.2`, `writer-time.3`) | P4 in slice 0 |
| 25 | Which raw health numbers does Rust hand up, and in what layout? | Section 10.5 | Slice 1 (the least), slice 2 (whole, OPS-02) |
| 26 | Where do the resource check and the method table ride? The record's reading is not modelled | On the first `ASK` or `SUB` for a resource on a link, and its answer | A client model with more than one resource on one link |
| 27 | A record may be 1 MB and a batch 1 MB. What is the largest record that fits a batch with its header, and is a bigger one cut across frames or refused? | Refused `too-large` | Slice 1 |
| 28 | The fields of `DOOR` and `DIAG`; how a frame sits in a WebSocket message; what TLS changes in "encode once" | One frame per WebSocket message; the rest not drafted | Slice 1b's TLS timing; slice 7 |
| 29 | The text of an attempt id; a tighter cursor for runs of slots | Session in hex, a dash, the call id; no run packing | Slice 1; the read-cost timing |
| 30 | Does a mark name its reader as text in every record, or by a number set once? | Text | E-61's three rules in slice 1; the counted pin on bytes per record |

## 13. What this page did not do

- No byte on this page has been through a write. That is slice 1's job.
- No golden byte file exists yet. Each frame and journal batch gets one when it is fixed for the build.
- The store's objects are not drafted. The resource id object comes with slice 2 (`genesis-conditional-create.1`). Old segments, snapshot layers and the restore mark come after the first build ([later.json](later.json)).
- The fields of served views, pages, scans, the merger's feed, sagas, locks, queues and forks are not drafted. They come with their slices.
- The mechanism names under each shape are the ledger's. A name marked (later) is not in the first build: its rules are in [later.json](later.json), or not written yet, and the shape only keeps room for it. A rule id in backticks, such as `journal.3`, is checked against the ledger by `tools/ledger-gate.mjs`. The ledger's `touches` field is the checked form of the same links.
