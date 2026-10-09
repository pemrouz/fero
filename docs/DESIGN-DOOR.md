# DESIGN-DOOR — the door, designed once (wave 3)

*Status: the design record (2026-10-08), BUILT in three stages on 2026-10-09
(the three dated notes below say what landed and where it deviated). The owner
took every default of §14 on 2026-10-09. Three proposals and three
skeptic critiques went into it (a kernel angle, a shell angle, an operator
angle). Where a skeptic disagreed with a proposal, this record sides with the
evidence and says so. Every file:line below was read on the tree at
`364e5ee`. The DECISIONS number is assigned at landing.*

*Built, stage 1 of 3 (2026-10-09): commits 1 and 2 of §13 — the role rule, then
the contract and the methods-only hint. No secret, no nonce, no DOOR verb yet.
What landed as designed: `doorReject: 78` ('uuid-taken'), `contractReject: 77`,
`RING`, `NodeOpts.contract` / `methodsOnly`, `link.methodsOnly`,
`node.feederMethodsOnly` read live, the per-batch door read in `Bind.issue`, the
composer's contract string for user-resource servers, the `[native code]`
refusal, the handler split (pre-door checks → the admit tail) with the seam
commented, 11's prose, the README drift rule, the wire card's `c` and `m`.
Deviations, each small: (1) `contractReject` and its glossary entry land in
commit 2, not 1 — the glossary gate refuses an entry for a kind the kernel does
not emit yet; the fold model learned both kinds in commit 1. (2) The shape
check for `c` and `m` sits with `n`'s, AFTER the diag branch, not before it as
step 1 lists — so an r:2 HELLO's `c` is never read, as §4 asks, and `n` keeps
its v4.1 position. (3) `missing:<key>` carries THEIR value when we lack the key
and `''` when they lack it. (4) The wire card gains `c` and `m` only; `k` and the
DOOR row wait for stage 3, since the site must not describe a frame the kernel
does not send yet; `site/index.html` did not change (it links the section
script). (5) `METHODS_ONLY` moved to api/data.ts (re-exported from api/index.ts
unchanged) because `issue()` now speaks it and data.ts cannot import index.ts.*

*Built, stage 2 of 3 (2026-10-09): commit 3 of §13, the kernel half — the handshake
itself, in the kernel and the sim. No api yet: the `secret` key, the composer's
door closure, the off-loopback rule, the stderr lines and the redaction are stage
3. What landed as designed: kernel/door.ts (the matrix, the proof message exactly
as §3, `prove`/`verify` over `ctEq`, the address rule, `contractDiff` and `ctEq`
moved here); `NodeOpts.door = { mac, nonce }`; HELLO `k` (16..64 accepted, minted
at linkUp, kept on the Link, the sent HELLO kept as `link.said` so the proof signs
exactly those keys); `DOOR: 26` with `{p}` (exactly 43 chars) and `{e}`;
`LS.proving: 3`, `link.hello`, `TAG.prove: 3`, `tune.proveMs` (5000, floor 1);
the order of checks of §3, with the proof between the pre-door checks and the
admit tail (`#admit`, one method, reached by an open HELLO or a verified DOOR);
the dialer proves first and the acceptor's DOOR precedes its VIEW and digest;
`bad-proof` with the `{e: 'denied'}` notice, `uuid-taken` with `{e: 'uuid-taken'}`
(secured nodes only — zero new frames on the open path); `timeout`; `refused` on a
close or a notice after my proof, parked; the toy door (sim/door.ts: a chained
keyed fnv padded to 43, 16 rng bytes as hex); the door family (200 seeds, n=3..5,
one intruder per seed, the chaos defaults, the monitors and the frame oracle);
the forwarder; the canary; the counted 4 frames per link; the 100-node secured
formation pinned at 104,050 events beside the open 59,500, which did not move.
Deviations, each small: (1) a second HELLO on a SECURED node is dropped and the
link LIVES (step 3 said "and a close"; §9 and §11 say dropped, and under the dup
fault a close would kill a healthy link — the stash keeps the first nonce, so
nothing is lost). (2) On a received `{e}` the dialer journals `refused` with c =
the dial target, not the notice's word, so the journal reads the same with or
without the best-effort frame. (3) The address rule's view-learned case is proved
in the kernel test (a dial whose `to` is a committed member's listen and not a
static host); the sim's forwarder covers discovered and static — the sim has no
way to make a member dial a view-learned address without a static host. (4) The
refusal idiom (dead + noRedial, park a dialed target) is one method, `#refuse`,
shared by name, contract and the door — no behaviour change. (5) sim/exec.ts grew
two seams for the family: `raw()` endpoints (a relay, a replayer, a hand-written
client) and `tap` (the frame oracle); both are inert unless used. (6) A finding,
not the door's: a discovered target that never admits — a squatter — holds
GENESIS at the lowest-uuid member for good, because genesis waits there for
`links ≥ hosts` and `hosts` counts the discovered set (kernel/membership.ts
tick). A V4-3 property, with or without a door; stated for STATUS.*

*Built, stage 3 of 3 (2026-10-09): the api half of §13 commit 3, and the docs. The
door is built. What landed as designed: the `secret` leaf (`cep`; the carriers refusal
names the flag; trimmed, `''` unset, the OFF set → `false`, a number, a boolean or
fewer than 16 characters refused with one message that never prints the value and
names `openssl rand -base64 24`); `FeroOpts.secret`; the composer's call check in the
same words; the door closure from node:crypto (HMAC-SHA256 as base64url, 43; 16 random
bytes as base64url, 22) for servers and clients, never the `#directory`; the
off-loopback rule after the directory-socket check (example 15's line unchanged, its
check run on a private port); the `FERO_CONFIG=off` note once per process;
`diag(f).config()` showing `<set>` or `false`, in the same commit as the leaf; one
stderr line per peer address and reason per process, deduped across revivals,
`nameReject` silent; the README rows and limits, the DESIGN-CONFIG row; the tests of
§11 that are the api's (config unit and e2e, api/index real TCP, the directory squatter,
the raw-socket tier three ways plus a silent one on the real 5 s timer, fero.spawn with
`FERO_SECRET`); the glossary and the wire card's `k` and DOOR. Deviations, each small:
(1) the refusal lines are fed from the composer's post-step journal cursor (the read
`cluster` already folds from), not a separate emit hook — the journal has none, and the
cursor sees every row the step wrote. (2) The lines are adapted to the rows: an
accepted link that sent no listen reads "a peer that connected" (the row carries no
uuid), the address line takes the dial target from the link table (still there at fold
time) and the claimed listen from the row, and the contract line reads our value off
`node.contract`. (3) The carriers message now names the layers a refused key MAY come
from, for every leaf — it said "the call only" for `uuid`, which rides a flag and a
variable; one assertion moved with it. (4) The call's shape message is the config hint
plus "; or secret: false to run open on purpose". (5) The layer-off note names the
variable it found (`FERO_SHOP_SECRET` too). (6) A FINDING for the kernel, not fixed
here: the acceptor sends its proof (step 11) before the role rule (step 12), so a
secret-holding client with a member's uuid is ADMITTED on its own side when
`{e: 'uuid-taken'}` arrives, drops the notice as `door out of order`, and sees only a
close — no `doorReject` row on the client; the server's row and line say it all. The
one-line fix is to run the role rule before the acceptor's proof. (7) The directory
squatter registers after the members form (deviation 6 of stage 2: a discovered target
that never admits holds genesis at the lowest member). (8) The glossary keeps one
`doorReject` entry naming every reason (the gate wants one entry per journal kind, not
per reason). (9) The `nobind` directory test says `secret: false`: a routable listen
with no secret is refused now, as §8 says.*

*Settled at review (2026-10-09): a skeptic read the built door against this record
and found two blockers, one major, two minors and two nits; every one was checked,
confirmed and fixed, each with a test that is red without its change. (1) THE RELAY
WAS OPEN: the address rule reads the peer's claimed `l` before any proof exists, so a
relay listed in the directory could hand the dialer a copy of the member's HELLO with
`l` rewritten to the relay's own address, pass the rule, forward the dialer's proof
and be admitted at the real member as the dialer (a member victim; a secured client
victim fed RECORDS). §3's argument that "A sees B's signed `l` inside B's proof" was
wrong — B's proof arrives after A has proved. The proof message now carries
`verifierListen`, the `l` the prover read in the verifier's HELLO, and the verifier
rebuilds over the `l` it SENT (`link.said.l`): a rewritten listen is `bad-proof`.
§3 "what is signed", "the relay", §6, §7 and §0 are rewritten above; no frame is
added, so the 104,050 pin did not move; the label stays `fero-door/1` because no
door ever shipped. (2) The `#directory` host sent `m: 1` with nothing set (it is
composed with `methods`; the hint lacked the `!isSystem` gate the contract has); a
real-socket test now pins the host's HELLO keys to u, i, l, n and the client's to
u, i, l, r, n. (3) The stderr printer wrote peer-chosen text verbatim — a claimed
listen (type-checked only), a claimed uuid, a contract value — so a newline forged
a line, an escape drove the terminal, and a module Set grew without bound; on an
OPEN server this needed no secret. Now a peer's field prints only through `shown`
(control characters dropped, cut at 64) and the dedupe keys on facts this node owns:
the resource, the kind, the reason and the dial target. A DEVIATION from "one line
per peer address and reason": an ACCEPTED peer has no address we trust, so inbound
refusals print once per reason per process, and the line reads "a peer that
connected as <claim>" so the operator reads it as a claim; the set is capped at
1024 entries. (4) The role rule now runs before the acceptor's proof (stage 3's
finding 6, fixed): the refused client is still proving, reads the notice as
`refused`, and never admits the server on its side. (5) A `DOOR { e }` on a link I
never proved on is `frameDrop 'notice before proof'` and a close, not a `refused`
row. (6) The call's secret is trimmed like the text layers trim theirs. (7) The
debug attach (r:2) on a secured node — with the token, a wrong token, on a proving
link — is now pinned by tests (the behaviour was right). Nothing printed by an
example changed.*

*Settled at the second review (2026-10-09): a second skeptic read the fixed door
and found one major, three minors and three nits; each was checked and
confirmed, and each fix is red without its change. (1) THE HONEST CROSSING DIAL
WROTE A REFUSAL: when two secured members dial each other at once, the acceptor
on the losing link ships its proof and closes that link as the duplicate in one
step; the sim posts a close after the minimum delay and bytes after a random one,
so the close can reach the dialer first. The dialer was still proving with its
proof sent — the shape of a refusal — so it journaled `refused` against an honest
member and parked it given-up (7 of 8 seeds of a two-node formation; with
heartbeats off nothing clears a park, so that side never re-dialed the peer after
a cut). Now linkDown reads the uuid the stashed HELLO claimed: when `byUuid`
already holds a live admitted link to it, the close is the peer's keeper rule —
no row, no park, no redial. A close with no other link to the peer is still
`refused`, as "close-while-proving" below says. A kernel test feeds the loser's
linkDown while proving; a sim test runs 240 honest formations and a cut with
heartbeats off. The 104,050 pin did not move (the row and the park were never
events, and the loser never re-dialed either way). (2) A `refused` row written at
linkDown came after the link left the table, so its line printed a dialed target
as "a peer that connected" and deduped across every target: for `refused` and
`timeout` the row's `c` IS the dial target, a fact this node owns, so the printer
reads it off the row when the table misses. (3) A dialed contract mismatch deduped
on the differing key's name, which the peer chooses; it keys on the kind and the
target now, as the inbound branch did. (4) A client with the right secret and a
member's uuid printed "the secrets probably differ" — the kernel had read
`{e: 'uuid-taken'}` and dropped the word. A DEVIATION from stage 2's note 2 ("the
dialer journals `refused`, not the notice's word"): that ONE word is kept —
`doorReject 'uuid-taken'` with `c` = the dial target — because it is a reason this
side cannot guess and the line can name the fix (`FERO_UUID`); `denied`, any other
word and a bare close still read `refused`, so a lost notice reads as before. (5) A
reverse-order relay test (the relay holds the victim's HELLO before the member
dials it) sits beside the rewrite relay. (6) README's limits name the static-host
relay. (7) The wire card's proof gloss names the claimed address. Not fixed, stated
for STATUS: on the secured path a crossing dial costs one extra dial — the dialer
whose accepted link the peer closed as the duplicate starts a member redial chain
before its own dialed link's proof lands (the open path marks that loser itself at
admit); the extra link is closed as a duplicate at once. It is inside the 104,050
count. Nothing printed by an example changed.*

## §0 The decision, in ten lines

1. HELLO grows once, by three optional keys: `c` (the cluster contract, a
   short readable string), `m: 1` (this server is methods-only) and `k` (a
   fresh nonce, only when a secret is set). An old peer ignores them; absent
   means "no claim", the `n` precedent.
2. One new verb, `DOOR` (26), carries a proof `{ p }` or a best-effort
   refusal notice `{ e }`. The DIALER proves first; the acceptor proves back
   only to a verified dialer. The proof is an HMAC over both nonces, both
   identities, the side and every HELLO key the prover sent.
3. The kernel holds no crypto and no secret. `NodeOpts.door = { mac, nonce }`
   is injected the way `validate` is. The api builds it from `node:crypto`;
   the sim builds a seeded toy. So the sim proves the protocol and the
   real-TCP tier proves the cryptography.
4. One config key, `secret`: the call, `FERO_SECRET`, a `fero.opt.ts` file.
   Never a flag, never in the journal, a capture, `diag(f).config()`, an
   error message, or the website manifest.
5. With nothing set, nothing changes on loopback: the same frames, the 27
   examples as they are, every sim golden and perf pin byte-identical.
6. A server that listens off loopback must set a secret or say
   `secret: false`; otherwise `fero()` refuses (§14 Q1).
7. A role rule with or without a secret: a client HELLO may not take a
   member's uuid. The member's link is never touched (the STATUS line).
8. Two journal kinds: `contractReject: 77` names the key that differs;
   `doorReject: 78` carries a typed reason. One stderr line per peer and
   reason per process (§14 Q4).
9. The `#directory` stays open on loopback and gets no secret; a dialer
   refuses a discovered or view-learned peer whose claimed listen is not the
   address it dialed, and its proof signs the listen it was shown, so a
   relay that rewrites the claim fails at the real node. Together they close
   the directory-squatter relay.
10. Not protected, said out loud: eavesdropping and tampering after the
    handshake (TLS later), a leaked secret, a dishonest client that holds
    the one shared secret, and the per-box loopback plane.

**What the owner must say yes to** (§14 has each with a default): refuse an
off-loopback listen without a secret; one shared secret now and a derived
client key as the first follow-up; the contract as a readable string, not a
hash; stderr lines for refusals; no new example rung in this change.

## §1 The problem

Three STATUS items change the same frame, HELLO, the first frame a link sends
(kernel/node.ts:621-625: `{ u, i, l, r?, n? }`). (1) STATUS.md:56: one box's
shell can set `heartbeat.ms` or `replicas` alone since V4-10 and a mismatch
shows as behaviour, never as a refusal at the door; the fix is a HELLO-carried
contract, and V4-14 asks it to carry `ring=fmix32` (docs/DECISIONS.md:1358-
1359). (2) STATUS.md:62: a client learns that a resource is methods-only
only after a round trip; the owner said the hint may ride with the contract
(the plan §4, :315). (3) STATUS.md:54: a client's HELLO that presents a
member's uuid trips the duplicate-link rule (kernel/node.ts:1161-1177)
against the real member; the owner chose BUILD for peer authentication on
2026-10-05 (the plan §4, :308). The three must land as ONE change so HELLO
grows once and the wire is re-pinned once.

## §2 The HELLO shape

Today (kernel/node.ts:621-625), sent at `linkUp` before anything routes:

```
{ u: string, i: number, l: string, r?: 1 | 2, n?: string }
```

`u` the uuid, `i` the incarnation, `l` my listen address ('' for a client),
`r` 1 = client, 2 = debug attach, `n` the resource name when configured. Keys
are spread in only when present, so a node that sets nothing sends the v4.0
bytes. The handler reads named keys off a generically decoded object
(kernel/codec.ts:303-316), so an unknown key is kept and ignored.

After this change:

```
{ u, i, l, r?, n?, c?: string, m?: 1, k?: string }
```

- `c` — the cluster contract (§4). Present only on a user-resource SERVER
  composed by api/index.ts. A client, the `#directory`, the sim harness
  (sim/harness.ts:24-36 passes no such option) and every embedder send
  nothing. A string of 1 to 256 characters; anything else is 'malformed
  hello'. About 70 bytes, once per link.
- `m` — the methods-only hint (§4). Present only when the sender is a user-
  resource server with `methods:` (api/index.ts:118 `methodsOnly`). Exactly
  the number 1; anything else is 'malformed hello'.
- `k` — my nonce for this link. Present only when this node has a `door`
  (a secret). 16 random bytes as base64url, 22 characters; a string of 16 to
  64 characters is accepted, anything else is 'malformed hello'. Minted by
  `door.nonce()` at `linkUp`, kept on the Link, never reused. Not from
  `env.rng`: the shell's rng is `Math.random` (shell/runtime.ts:144-145).

Key order inside the object is the send site's insertion order: `u, i, l, r,
n, c, m, k`. HELLO still goes out at `linkUp`, before the sender knows the
peer's role, so `c`, `m` and `k` reach clients and debug attaches too. A
client ignores `c`; everyone ignores `m` except a client; the debug viewer
already drops the node's HELLO (tools/debug/attach.ts:85).

One new verb, `DOOR: 26`, after `LEAVE: 25` (kernel/codec.ts:74). A control
frame carries exactly one value (kernel/codec.ts:442-455), so:

- `{ p: string }` — the proof, a 43-character base64url HMAC-SHA256.
- `{ e: 'denied' | 'uuid-taken' }` — a best-effort notice sent just before a
  refusal close. The shell closes with `socket.destroy()` (shell/runtime.ts:
  163), so the notice can be lost; the journal row is the contract, as with
  the diag deny (kernel/diag.ts:58-60).

Frames per link: 2 with no secret (two HELLOs, as today); 4 with a secret
(two HELLOs, two DOORs). No frame after admission changes.

Compared with the panel: the kernel proposal used an 8-hex hash for `c`, the
shell proposal put no auth key in HELLO at all (TLS), the operator proposal
is the shape taken here. All three agreed on `m: 1`.

## §3 The auth rule

### Setting

A node has a secret exactly when `NodeOpts.door` is set:

```ts
door?: { mac(msg: string): string; nonce(): string }
```

The api builds it (api/index.ts, beside `rtOpts` at :252-281): `mac = (msg)
=> createHmac('sha256', secret).update(msg).digest('base64url')`, `nonce =
() => randomBytes(16).toString('base64url')`. api/index.ts:15 already imports
`node:crypto`. The kernel never sees the secret string; it sees two
functions, like `validate` (kernel/node.ts:96). kernel/purity.test.ts:19-30
stays green: no `node:` import, no `Math.random` in kernel/.

A new link state, `LS.proving: 3` (kernel/link.ts:35, appended, never
renumbered). A proving link has read a HELLO that carries `k`, holds the
claimed fields on the Link, and is NOT in `byUuid`, NOT in `clientLinks`, NOT
counted by `admitted()`. Every admitted-only verb already closes a link whose
state is not `LS.admitted` (RECORDS at kernel/node.ts:1231-1234, membership
at :1482-1486), so a proving link can carry nothing but DOOR.

### What is signed

```
msg = JSON.stringify(['fero-door/1', side, verifierNonce, proverNonce,
                      verifierUuid, verifierListen,
                      u, i, l, r ?? 0, n ?? '', c ?? '', m ?? 0])
p   = door.mac(msg)
```

`side` is `'dialer'` or `'acceptor'`: the prover's side on this link, so a
proof cannot be turned around. `verifierNonce` is the `k` from the peer's
HELLO; `proverNonce` is my own `k`; `verifierUuid` and `verifierListen` are
the `u` and `l` the peer's HELLO claimed, AS I READ THEM; `u … m` are MY
HELLO keys exactly as sent. The verifier rebuilds the message with its own
uuid and the `l` it actually sent on this link (`link.said.l`), so a HELLO
whose `l` was rewritten between us yields a proof the real node cannot
verify (the relay, below; added at review, 2026-10-09). JSON over an array
of strings and numbers has one encoding, so there is no separator
ambiguity. The label versions the message.

### The order of checks on an inbound HELLO

Each step before the proof touches no shared state: not `byUuid`, not
`#peerInc`, not `#backoff` (except to park), not `clientLinks`, not
membership. Today those are all in the admit tail (kernel/node.ts:1178-1218).

1. **Shape.** `u` string, `i` number, `l` string as today (:1120-1123); then
   `n`, `c`, `m`, `k` as §2 says. Bad shape → `JK.frameDrop 'malformed
   hello'`, `dead`, close `'malformed-hello'`.
2. **The debug attach.** `r: 2`, or a link already in `LS.diag`, goes to
   `diagHello` (:1129) exactly as today, BEFORE everything else. A debug
   attach is never asked for a proof and never checked for the contract. Its
   own token is its door (kernel/diag.ts:61-88). Its used-link guard
   (diag.ts:63-67) already closes an r:2 that arrives on a proving or
   admitted link, so kernel/diag.test.ts:118 keeps passing.
3. **A second HELLO, secured nodes only.** On a node WITH a door, a HELLO on
   a link in `proving` or `admitted` is `frameDrop 'hello twice'` and a
   close: it would replace the stashed nonce and break the proof. On a node
   WITHOUT a door, today's path is kept: a duplicated HELLO re-runs the
   admit block. The kernel skeptic measured why: the sim's dup fault
   (sim/exec.ts:355-356) re-delivers HELLO in 14 of the 20 golden seeds
   (sim/exec.test.ts:33-60), so a drop on the open path would move the
   golden. The kernel proposal had the rule unconditional; the skeptic is
   right.
4. **Name**, unchanged (:1136-1153).
5. **Contract** (§4). Runs here so a config mistake reads `contractReject`,
   never `bad-proof`, and no proof is spent on a link that would be refused
   anyway. The kernel proposal put the secret check before the name and
   contract; its skeptic objected and this record agrees.
6. **Self-reject**, unchanged (:1155-1160).
7. **The secret matrix.** I have a door and the peer sent no `k` →
   `JK.doorReject` reason `'no-secret'`. I have no door and the peer sent
   `k` → `'peer-secret'`. Both ends see the mismatch, so both refuse and
   both print. The refusal: `dead = noRedial = true`; a dialed target is
   parked `gaveUp` (the name-reject idiom at :1151, so heartbeat revival at
   :761-771 re-dials it once per heartbeat while it stays in hosts ∪ view);
   close `'door'`.
8. **Neither side has a door** → step 12 (today's path, plus the role rule).
9. **Both have a door: the address rule.** If I dialed this link and
   `link.to` is NOT one of my static `hosts` (kernel/node.ts:386 — so it
   came from the directory's `discover` set at :381 or from a committed
   view's member listen at :484-488), then the acceptor's claimed `l` must
   equal `link.to`. Otherwise `doorReject 'address'` with `c = the claimed
   l`, parked, close. Why this is safe: the directory registers exactly the
   registrant's `node.listen` (api/directory.ts:285) and a VIEW carries each
   member's own gossiped listen, which is the same string that member puts
   in its HELLO (`l: this.listen`, :622). Static `hosts` are exempt because
   an operator types them in any spelling (`0.0.0.0`, a hostname, a NAT
   address). Why it is needed: see "the relay" below.
10. **Stash and prove.** Keep the HELLO on `link.hello`, set `state =
    proving`, arm a one-shot timer `TAG.prove` (`tune.proveMs`, default
    5000; kernel/env.ts:219 TAG is append-only). If I am the DIALER, send
    `DOOR { p }` now, built over the peer's `k`. The acceptor sends nothing
    yet.
11. **On `DOOR { p }`.** The link must be in `proving` (else `frameDrop
    'door out of order'`; a DOOR on an admitted link is a DROP, not a close,
    so the dup fault cannot kill a live link; a DOOR before HELLO closes,
    the write-before-hello idiom). `p` must be a 43-character string. Rebuild
    `msg` from the stashed HELLO with the peer's side, my own `k` as
    `verifierNonce`, my own uuid as `verifierUuid`; compare with `ctEq`
    (kernel/diag.ts:31-36, moved to kernel/door.ts and shared). Mismatch →
    `doorReject 'bad-proof'`, best-effort `DOOR { e: 'denied' }`, dead +
    noRedial, park if dialed, close `'door'`. Match and I am the ACCEPTOR →
    run the REFUSING half of the role rule (step 12) first — a verified
    client that claims a member's uuid is refused now, while it is still
    proving, so it reads the notice as `refused` and never admits me on its
    own side (settled at review, 2026-10-09) — then send my `DOOR { p }`,
    THEN continue to step 12. On a FIFO link the dialer sees the proof
    before the digest and VIEW that admission ships. Match and I am the
    DIALER → continue to step 12. A `DOOR { e }` on a link I have NOT proved
    on (an acceptor still waiting) is a stranger's frame, not a refusal:
    `frameDrop 'notice before proof'` and a close, no `refused` row.
12. **The role rule**, with or without a door. If `r === 1` and the claimed
    uuid is a member of the committed view (kernel/membership.ts:186
    `isMember`) or is held by an admitted NON-client link in `byUuid`: refuse
    this link, `doorReject 'uuid-taken'` with `c = the uuid`, best-effort
    `DOOR { e: 'uuid-taken' }`, dead + noRedial, close. The member's link is
    not touched and no `dupLink` row is written. The reverse: a non-client
    HELLO whose uuid an admitted CLIENT link holds closes that client link
    (`doorReject 'uuid-taken'` on the client's link id) and continues. A
    member is what the rule protects; a client was never entitled to the
    uuid. (The operator proposal said "the first holder keeps the uuid"; its
    skeptic showed that lets a client lock a member out of a peer whenever
    it connects first, and that a stray `FERO_UUID` in a shell makes this
    the common case. The shell proposal's class rule and this record agree:
    the member wins.) Two client links with one uuid keep today's rule.
13. **Duplicate-link and admit**, unchanged (:1161-1226), with two added
    lines in the tail: `link.methodsOnly = (m === 1)` and `link.hello =
    null`.

A proving link whose timer fires: `doorReject 'timeout'`, dead + noRedial,
park if dialed, close `'door-timeout'`. A timer, not a heartbeat sweep: the
operator skeptic noted `heartbeat: { ms: 0 }` is a documented opt-out
(api/index.ts:261-263), so a sweep would never run there. The timer is set
only on secured links, so it draws nothing on the open path.

A link that closes while proving, AFTER I sent my proof: the dialer journals
`doorReject 'refused'` and parks. It is a guess (a crash mid-handshake looks
the same), so the stderr line says so: *closed during the handshake; if this
repeats every heartbeat the secrets probably differ*. One close is not a
guess: when the stashed HELLO's uuid is already held by a live admitted link
in `byUuid`, the peer closed this link as the duplicate of a crossing dial
(its proof may still be in flight behind the close) — no row, no park, no
redial (settled at the second review, 2026-10-09). A `DOOR { e: 'uuid-taken' }`
read while proving keeps its word: `doorReject 'uuid-taken'` with `c` = the
dial target; `{ e: 'denied' }` reads `refused` like a close.

### Replay and forgery, step by step

- **A forged HELLO without `k` to a secured node** is refused at step 7.
  Nothing was touched.
- **A forged HELLO with a random `k`.** The link sits in `proving`. The
  forger cannot compute `p` (it has no secret). If it sends a bad `p`,
  `bad-proof`; if nothing, the timer. Never in `byUuid`. The duplicate-link
  rule never ran, so a claimed member uuid changed nothing. This is the
  STATUS line for strangers.
- **A captured HELLO + DOOR replayed on a new connection.** My new link has
  a fresh `k`; the captured proof signed the old one; `bad-proof`. The
  incarnation is NOT the replay bound: a reconnect after a blip carries the
  same `(u, i)` as a replay would, and refusing reconnects breaks healing.
  The nonce can tell them apart.
- **A reflected proof.** The side label and the self-reject both stop it.
- **A stranger that can only CONNECT never gets a proof to relay.** The
  acceptor signs only after verifying the dialer. The kernel proposal had
  both sides prove at once with a direction bit; that also works, but every
  member then signs any nonce for anyone who can connect. Dialer-first costs
  the dialer half a round trip more and makes the argument one sentence.
- **The relay.** Someone a member DIALS can forward the handshake to a
  second member: A dials X (the relay); X dials B pretending to be A and
  forwards frames both ways. Both proofs check out, because nothing in them
  names X. This is the hole both the kernel skeptic and the operator skeptic
  found, and it matters on the default box: any local process can register
  a fake address for a name (api/directory.ts:24-27), and a parked target
  listed by the directory is re-dialed every heartbeat (kernel/node.ts:761-
  771). Two rules close it, and it takes both (the review of 2026-10-09
  showed that step 9 alone does not):
  - Step 9, the address rule, catches a relay that forwards VERBATIM: B's
    HELLO says `l: B`, A dialed X, they differ, A refuses before sending any
    proof; B never gets a dialer proof and its link times out.
  - The proof message catches a relay that REWRITES: X hands A a copy of
    B's HELLO with `l: X`, so the address rule is satisfied, and A proves.
    But A's proof signs `verifierListen = X`, the listen it was shown, and
    B rebuilds the message over the listen it SENT (`B`): `bad-proof`, no
    admission, B's own proof never leaves, and A reads the notice and parks
    X. The earlier text claimed A "sees B's signed `l` inside B's proof";
    it does not — the dialer checks `l` before any proof exists, and B's
    proof arrives only after A has already proved. The dialer's proof is
    what has to bind the claim.
  What neither closes: a relay sitting at a STATIC `hosts` address that
  forwards verbatim (A signs B's real listen, which B verifies), or in a
  network position. That is TLS's job later and it is in the NOT PROTECTED
  list. Note the asymmetry is deliberate: the dialer signs the string it was
  SHOWN, never the one it TYPED, so a typed `0.0.0.0` or hostname never
  breaks an honest handshake.
- **A dishonest client that holds the shared secret** can omit `r: 1` and is
  a member. The role rule cannot see it. Said plainly in §7; the derived
  client key is the follow-up (§14 Q2).

### Journal rows

| kind | a | b | c |
|---|---|---|---|
| `contractReject: 77` | link | the first key that differs, or `missing:<key>` | their value for it (a string, never ours) |
| `doorReject: 78` | link | `'no-secret'` · `'peer-secret'` · `'bad-proof'` · `'uuid-taken'` · `'address'` · `'timeout'` · `'refused'` | the dial target or the claimed listen; for `uuid-taken` the uuid on the refusing side, the dial target on the refused client |

Never in a row: the secret, a nonce, a proof. The journal's 4096 ring
(kernel/journal.ts:127) fills in about 34 minutes if two mis-keyed members
re-dial each other every 500 ms, the same cadence `nameReject` has today.
Stated, not fixed here.

### Refusal messages (one stderr line per peer and reason, per process)

```
fero('shop'): refused by 127.0.0.1:4100 — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)
fero('shop'): refused 127.0.0.1:51234 (uuid 7c3e) — it has no secret and this node has one; every member and client must share FERO_SECRET
fero('shop'): refused 127.0.0.1:4100 (uuid 9e1c) — its secret differs from this node's
fero('shop'): refused 127.0.0.1:4100 — closed during the handshake; if this repeats every heartbeat the secrets probably differ
fero('shop'): refused 127.0.0.1:4100 — it answered as 127.0.0.1:4200, not the address the directory gave (a stale or forged entry)
fero('shop'): refused a client claiming uuid 7c3e — that uuid belongs to a member (a shared FERO_UUID?)
fero('shop'): refused by 127.0.0.1:4100 — the uuid this process runs as, 7c3e, belongs to a member there (a shared FERO_UUID?)
fero('shop'): refused 127.0.0.1:4101 (uuid 9e1c) — the cluster contract differs: heartbeat.ms is 500 here, 250 there (every member must agree on heartbeat.ms, replicas, methods, validation and ring)
```

No message contains the secret, a nonce or a proof.

## §4 The contract rule and the methods-only rule

### The contract

Who sends `c`: user-resource servers only. The composer builds the string
beside `rtOpts` (api/index.ts:252-281) and passes `NodeOpts.contract`. The
`#directory` is composed with `isSystem` (api/index.ts:95; api/directory.ts:
320) and gets no contract and no `m`, so the system plane's bytes do not
change. Clients pass nothing and are never checked: the single-feeder rule
covers them (V4-5, a spoke never teaches).

The string, in this fixed order:

```
v1;heartbeat.ms=500;replicas=0;methods=0;validation=none;ring=fmix32
```

- `heartbeat.ms`: the effective value, after the composer's 500 default
  (api/index.ts:264).
- `replicas`: `config.replicas`, or 0.
- `methods`: 1 when `methods:` is set (api/index.ts:118), else 0.
- `validation`: 8 hex digits of `fnv(seams.validation.toString())` using
  the exported `fnv` of kernel/ring.ts:34 (fmix32-finished; node.ts's own
  fnv at :1845 is module-private), or `none`. Hashed EVEN WHEN `methods:` is
  on: V4-5 made `methods:` + `seams.validation` a supported pair and the
  server's own Bind runs the validator under the door (api/index.ts:309-
  310). The kernel proposal folded both into one `door=` field, which hides
  validation drift in exactly that setup; its skeptic caught it. A validator
  whose source text is `[native code]` (a bound or native function) is
  refused at `fero()` time: two different rules would hash alike.
- `ring`: appended by the KERNEL from a new `export const RING = 'fmix32'`
  in kernel/ring.ts, so the label cannot drift from the ring code (V4-14,
  docs/DECISIONS.md:1358-1359). The api never writes this part.

A later tune row that the wire depends on (`suspect.ticks`; docs/DESIGN-
CONFIG.md:411 says it waits for this hash) joins the string.

Why a readable string and not the plan's 8-hex hash: about 60 more bytes,
once per link, buy a journal row and a stderr line that say *heartbeat.ms is
500 here, 250 there* instead of `a1b2c3d4 vs 9f8e7d6c`. Two of the three
proposals and their skeptics took this side. The values are not secret.

The check, at step 5 of §3: both HELLOs carry `c`, the link is not a client
link, and the strings differ → `JK.contractReject` (a = link, b = the first
key whose value differs, c = their value), `dead = noRedial = true`, a dialed
target parked `gaveUp` (heartbeat revival re-dials a fixed member once per
heartbeat), close `'contract-mismatch'`. One side absent → no check (an
embedder, the sim, an old peer; mixed versions before 1.0 are unsupported,
V4-14). `c` on an `r: 2` HELLO is never read: the diag branch runs first.

The caveats, from the plan §2.1 (:132-133): `fn.toString()` cannot see
values a closure captures, and a different Node major may print the same
file differently. Under `--experimental-strip-types` the same file on the
same Node major hashes alike. This is a drift detector, not a security
control: a malicious member can lie in `c`.

**Rolling changes, stated.** Once a key is in the contract, changing it on
one member at a time splits the cluster: the first restarted member is
refused by the others, parked, and after `suspectTicks` evicted (a parked
target is not `dialing()`, kernel/node.ts:396-399, so the eviction hold at
kernel/membership.ts:256 does not apply). At three members the second
restart closes the write gate until the third restarts. So: changing
`heartbeat.ms`, `replicas`, the door, the validation text, the Node major,
or the secret is a full stop and start of every member and client. Today's
drift is silent; this is loud and correct, and the README says it beside the
`cluster` scope word (README.md:91, whose "the kernel does not police drift"
is rewritten).

### The methods-only hint

The sender: a user-resource server with `methods:` sets `NodeOpts.methodsOnly
= true` and HELLO carries `m: 1`. An open server sends nothing. Members never
compare `m`: the contract's `methods=` field already polices it, so every
admitted member agrees.

The receiver: on admit the kernel sets `link.methodsOnly = (m === 1)`. A
client reads it LIVE off its primary: `node.feederMethodsOnly` is
`links.get(primary)?.methodsOnly ?? false`. Read live, not copied at admit:
HELLO is never resent, so a copy reset on failover (the `feederOpen` shape at
kernel/node.ts:667-669) would never be refilled. The kernel skeptic caught
this against the kernel proposal.

The client's use, in Bind (api/data.ts:201-217): `issue()` reads the door
ONCE per batch (a batch is one kernel step; the primary cannot change inside
it). When it is closed, every record of the batch is refused with
`METHODS_ONLY` (api/index.ts:42) before `#validate` runs: an outcome row
`rejected` with reason `'methods-only'`, nothing shipped, no `pending` row.
The write methods throw the SAME `WriteRejectError` the relay's refusal
throws today: `bind.issue` returns the string and :490-491 rejects `reached
'issued'` with `explain()` (:479) appending *(the server takes changes only
through its methods)*. A program cannot tell a local refusal from a relayed
one except by time. The shell skeptic's perf note is taken: no closure per
record on clients that have neither a door nor a validator; `#validate`
stays `undefined` there and the door read is one property per batch.

What does not change: a write issued before the first admit knows nothing
and still goes to the relay, which refuses it with `METHODS_ONLY_ADMIT`
(api/index.ts:277). The server's door is the guard; the hint is a shortcut.
A spoofed `m: 1` can only make a client refuse its own writes. An old server
sends no `m` and the client falls back to the round trip. The examples that
check the door wait for the `rejected` row or await the promise (08, 40,
44), so they stay green. V4-5 rejected "advertising the pin in HELLO" as a
wire-surface change (docs/DECISIONS.md:454-455); the owner reopened it for
this change, so HELLO grows once.

## §5 The config keys

One new key: `secret`. It follows V4-10 (one lowercase word, declared in
`LEAVES`, api/config.ts:53-69).

| Key | Layers | Default | Scope |
|---|---|---|---|
| `secret` | the call · `FERO_SECRET` (per resource `FERO_SHOP_SECRET`) · a `fero.opt.ts` file (`secret:` or `shop: { secret }`) | unset = the open door | cluster: the same value on every member AND every client |

- **LEAVES row:** `secret: { layers: 'cep', why: 'a secret never rides argv:
  ps, /proc/<pid>/cmdline and shell history show every flag' }`. The
  carriers table refuses `--fero.secret` with that `why` (api/config.ts:198-
  199); the template there says "the call or a fero.opt.ts file" and gains
  "or the environment" for a `cep` leaf. This is the shape docs/DESIGN-
  CONFIG.md:390-401 gave the deferred `diag` key.
- **Coercion** (api/config.ts:234-261), string layers only: trimmed; `''`
  is unset (the fold keeps looking); the existing `OFF` set (`off`, `false`,
  `0`, :233) means `false` = open on purpose (the operator skeptic noted a
  secret-specific set would refuse `0` as "looks like a number"); a number
  or a boolean is refused with its OWN message that never prints the value:
  *secret must be text of at least 16 characters (from FERO_SECRET) — a
  value that is all digits is read as a number; `openssl rand -base64 24`
  prints a good one*. Fewer than 16 characters: refused, same hint. The call
  layer skips `coerce` (:332), so the composer checks the call's `secret`
  itself: a string of 16 or more characters, or `false`.
- **Redaction:** `diag(f).config()` (api/index.ts:864-877) shows `secret`
  as `'<set>'` with its `from`, or `false`; never the value. `from()` returns
  a spelling, not a value. The leaf, its redaction and the test land in ONE
  commit, because `config()` prints every leaf's raw value today (:871-872);
  the shell skeptic's sequencing note.
- **What a secret may never do:** ride a flag; appear in a journal row (the
  kernel gets two functions, not the string); appear in a capture or
  `diagNode` (which reads no opts); appear in `diag(f).config()` or any
  error message; appear in the website manifest (site/strip.mjs:23-27 ships
  kernel + sim only, and the kernel has no secret to ship).
- **`FERO_CONFIG=off`** reads the call alone (api/config.ts:302-303), so an
  ambient `FERO_SECRET` is ignored under the battery (utils/battery.ts:16-
  17). One stderr line per PROCESS when that happens (*FERO_CONFIG=off:
  FERO_SECRET is ignored, this process runs open*), so an operator cannot
  believe a box is locked when it is not. A test that wants the env layer
  spawns its child with `FERO_CONFIG` deleted (tests/config.test.ts:37-40).
- **Leak paths, stated:** `FERO_SECRET` is inherited by every child process
  the app starts, not only `fero.spawn` children (api/spawn.ts:23 passes no
  env, so children inherit), and the same user can read
  `/proc/<pid>/environ`. A project `fero.opt.ts` is usually committed: the
  README says put a literal secret in `$HOME/fero.opt.ts` or the
  environment; the existing guard test still refuses a root `fero.opt.*`.
- **The off-loopback rule (§14 Q1):** a user-resource server whose listen
  host is not loopback (`127.*`, `localhost`, `[::1]`; the composer's
  `loopback()` helper at api/index.ts:216, NOT `localish` at api/directory.
  ts:70-71, which counts `0.0.0.0` as local), with `secret` unset, throws:
  *listen 0.0.0.0:4100 is reachable from other machines and no secret is
  set — set FERO_SECRET (the same value on every member and client), or pass
  secret: false (FERO_SECRET=off) to run open on purpose*. It runs AFTER the
  directory-socket check (api/index.ts:208-212), so examples/15-static-
  topology/refusals.ts:9 (`listen: '0.0.0.0:3376'`) keeps printing *would
  take the directory's socket* and 15's README block is untouched. A client
  is never refused for having no secret.
- **No new key** for the contract or the hint: both derive from keys that
  exist. No rotation key: changing the secret is a full stop of every
  process (a `secret: [new, old]` window is a follow-up).
- **Kernel side:** `NodeOpts.door`, `NodeOpts.contract`,
  `NodeOpts.methodsOnly`; a tune row `proveMs` (default 5000, floor 1 like
  every non-redial row, kernel/tune.ts:124-139), no config key for it.
- `FERO_DIAG_TOKEN` stays the viewer's variable (api/config.ts:117 strips
  it). A secret is not a diag token and a diag token is not a secret.

## §6 The directory

The `#directory` does not change. It is a system resource: api/directory.ts
composes its client (:233) and its host (:320) with explicit opts and
`isSystem`, so api/config.ts never runs for it (api/index.ts:95). It gets no
secret, no contract and no `m`, and its links are exactly today's: open,
loopback, `127.0.0.1:3376` (api/directory.ts:41).

Why: it is shared by every resource on the box, and resources may run
different secrets; a secured server must still register and look up with no
config beyond its own secret; and the box-local plane is already declared
unauthenticated (api/directory.ts:24-27: *loopback IS the trust boundary*).
Giving it a per-box secret would be a new key and a new trust domain that
protects addresses when the dial itself now authenticates.

What a secret changes about what the directory hands out: a wrong address is
now REFUSED at the door. A local process registers a fake address for
`shop`; a member dials it; the squatter cannot prove (`no-secret` or
`bad-proof`), or it relays and fails the address rule (§3 step 9), or it
relays with a rewritten listen and the real member refuses the proof
(§3 "the relay"); the target is parked and re-dialed once per heartbeat
while it stays listed.
Bounded chatter, no admission. The operator proposal said a squatter "only
fails auth"; its skeptic showed the relay; the address rule is the answer.

What the directory still cannot stop: a local process can HIDE entries
(denial of discovery) or knock a registrant off the directory host (the
host's own dup-link rule is unchanged). A routable rendezvous
(`FERO_RENDEZVOUS=10.0.0.5:3376`) stays the operator's explicit,
unauthenticated act. The cross-box hosts lane (a portless host meaning "ask
that box's directory") inherits the address rule for free: a discovered
target is checked wherever it came from.

## §7 The threat model

**Protected, with a secret on every member and client:**

- A process without the secret cannot become a member or a client: it sends
  no records, reads nothing, calls no method, casts no vote.
- It cannot squat a resource name or a port and be admitted: a dial that
  reaches it is refused and costs one dial per heartbeat.
- It cannot knock a member off by claiming its uuid: the duplicate-link rule
  runs only after a proof over a nonce this node minted for this link.
- A recorded handshake cannot be replayed: each side's nonce is fresh per
  link.
- A proof cannot be moved to another node, link or direction: it binds both
  uuids, both nonces, the side, and every HELLO key of the prover.
- A process that can only connect never gets a proof to relay: the dialer
  proves first.
- A relay behind a directory entry or a view-learned address is refused:
  one that forwards verbatim by the address rule, one that rewrites the
  listen by the proof (the dialer signs the listen it was shown; the real
  node rebuilds over the one it sent).
- The identity keys (`u, i, l, r, n, c, m`) cannot be changed in flight
  before admission: they are signed by their sender, and `u` and `l` are
  signed again by the side that read them.
- A debug attach cannot be used as a peer: the r:2 branch latches outside
  membership on its own token, unchanged.

**Protected, with no secret (the role rule):**

- An honest client cannot take a member's uuid, by accident (a stray
  `FERO_UUID`, which is an env-carried key, api/config.ts:54) or on purpose.
  The member's link is never touched; the client is refused loudly.

**Protected, the contract (a drift detector, not security):**

- Members that disagree on `heartbeat.ms`, `replicas`, the door, the
  validation text or the ring hash never link, and both ends say which key.

**Not protected, said plainly:**

- Eavesdropping: every frame is cleartext, records and views included. The
  secret never crosses the wire, only HMACs of nonces, so a listener learns
  no secret. Use a private network, WireGuard or SSH; TLS at the shell is
  the later layer and this handshake runs unchanged under it.
- Tampering or hijack AFTER the handshake by someone on the path: no frame
  after admission is signed.
- A relay at a STATIC `hosts` address or in a network position: the address
  rule exempts typed hosts. TLS's job.
- A dishonest client that holds the one shared secret: it can omit `r: 1`
  and is a member — it can write any lane, vote, LEAVE a member out, and
  claim any member's uuid. Every client holds the member secret in this
  change. Where clients are not trusted, wait for the derived client key
  (§14 Q2). This is why the STATUS line is said to close for strangers and
  for honest clients, not for a hostile secret holder.
- A leaked secret: whoever holds it is a member. No per-node identity, no
  revocation, no rotation window; changing it is a full restart.
- A weak secret: the 16-character floor helps; a dictionary word does not.
- Reading the secret from the process: `/proc/<pid>/environ` as the same
  user, a `$HOME/fero.opt.ts`, a child process that inherited the env.
- The `#directory` at `127.0.0.1:3376`: unauthenticated, per box; a local
  process can register or hide entries. With a secret its lies are refused
  at the door, not prevented.
- The diag token still crosses cleartext (kernel/diag.ts:14-15), unchanged.
- Denial of service: a socket that connects and never proves holds a link
  for `proveMs`; a flood of DOOR frames costs one HMAC each before the link
  closes; a parked bad address is re-dialed once per heartbeat. Bounded,
  not prevented.
- The default: no secret on loopback means the open door, today's wire
  (V4-3's boundary). Off loopback the composer refuses, or the operator
  says `secret: false` and owns it.
- The contract is not a security control: a member can lie in `c`.
- Timing: the proof compare is constant-time (`ctEq`); the HMAC itself is
  node:crypto's.

## §8 Compatibility and the default

**With no secret set** (the default): no `k`, no DOOR, no proving state, no
timer. A user-resource server's HELLO gains `c` (about 70 bytes) and, with
`methods:`, `m: 1`. That is the ONLY wire change on the open path. Why it is
right: V4-3 made loopback the trust boundary and every example and the
whole battery run with nothing configured; the contract and the hint are
pure gains there (a mixed cluster now refuses loudly; a client's bad write
fails at once).

- **The sim, the goldens, the perf pins:** sim nodes set no `door`,
  `contract` or `methodsOnly` (sim/harness.ts:24-36; sim/exec.ts:128-130
  builds `Node` from bare opts), so the 20-seed golden (sim/exec.test.ts:33-
  60), the 1000-seed sweep, the n=100 formation pin of 59,500 events
  (sim/scale.perf.ts:32-41) and every hand-fed HELLO in the perf files
  (kernel/node.perf.ts:47, :110 send `{ u, i, l }`) are byte-identical. The
  role rule's branch fires only on a client/member uuid collision, which no
  sweep produces.
- **The examples (27 rungs):** every listen is loopback or the default
  (examples/15-static-topology/server.ts:5 and 16-scoped/server.ts:5 take
  `mine` from loopback ports; the only `0.0.0.0` is 15's refusal line, which
  the directory-socket check catches first). No printed line changes, so no
  README block is re-recorded. One README's PROSE changes: examples/11-
  validation/README.md:34-39 teaches a mixed-rule cluster ("every server
  must carry the rule — the last line below is one that does not", and the
  `sh` line `node client.ts --fero.server=true # … its hammer lands`). The
  contract now refuses that server at the door, so the bullet and the `sh`
  comment are reworded to *refused at the door: the contract differs
  (validation)*. The check runs the files the README names and is unchanged.
- **The website demo:** site/strip.mjs copies kernel + sim/exec, monitors
  and harness (:23-27); the demo runs with no secret and no contract, so the
  tab runs today's trajectories. kernel/door.ts has no `node:` import, so
  the strip gate holds. The wire card (site/sections/wire.js:46, :60) lists
  HELLO's keys and gains `c`, `m`, `k` and a DOOR row.
- **An old peer and a new node with nothing set:** identical both ways; the
  old peer ignores `c` and `m`. Mixed versions before 1.0 are unsupported
  anyway (V4-14).
- **An old peer and a secured node:** refused `no-secret`, parked; the old
  side keeps its own redial chain, harmless and logged.
- **A client with no secret against a secured cluster:** every member
  refuses it `no-secret`; the client sees `peer-secret` from each (the
  member's HELLO carries `k`), parks each target, never gets a primary,
  `cluster.writable` stays false (api/index.ts:598), and prints one line per
  target naming `FERO_SECRET`. The shell skeptic showed a TLS design could
  not give this client any message at all; the kernel handshake can.
- **A client with the secret:** mints `k`, proves as the dialer, is admitted
  `r: 1` exactly as today, sends no `c`.
- **A debug attach (r:2) on a secured node:** the diag branch runs first;
  `FERO_DIAG_TOKEN` and the allowlist are the only check. Unchanged.
- **`fero.spawn` roles:** the secret arrives through `FERO_SECRET` in the
  child's environment, never argv. A check that wants it deletes
  `FERO_CONFIG` from the child env (the battery pins it off, utils/battery.
  ts:17).
- **The directory host and client:** no `c`, no `m`, no `k`; bytes as today.
- **Breaking, pre-1.0:** an off-loopback listen with no secret now refuses
  to start (§14 Q1); a rolling change of a contract key now splits the
  cluster until every member runs the new value (§4). Both get a DECISIONS
  line.

## §9 What the sim proves, what only real sockets prove

The kernel runs byte-identical in the sim (sim/exec.ts:130 builds `new
Node(opts, { now, rng, sink })`; no sockets). Because `door` is injected, the
sim can drive the whole handshake with `sim/door.ts`: `mac` = a keyed fnv
over `secret + '\0' + msg` as hex, `nonce` = 16 bytes from the sim's seeded
rng. It is a toy (it proves the protocol, not the cryptography) and it has
no `node:` import, so the strip gate and the determinism canary (two
same-seed runs, equal `trace`) both hold.

**The sim proves:**

- A secured n=3..5 cluster forms, converges and heals under the chaos
  defaults (delay, dup, severOnFrame, crash and restart); the frame count
  with a secret is exactly 4 per link, pinned.
- An intruder (wrong secret, no secret, a valid HELLO claiming a member's
  uuid as r:1, a replayed HELLO + DOOR on a fresh link, a reflected proof)
  never enters any `byUuid`, view or digest, never causes a `dupLink` row
  against a real member, never moves `#peerInc` or confirm marks. These
  become monitors that run where `converged()` runs.
- The relay: two nodes and a hand-written forwarder in the exec; refused by
  the address rule when the target is discovered or view-learned, admitted
  (and documented) when it is a static host.
- The acceptor never sends a proof before the dialer's proof checked out
  (an oracle on the frame order).
- The contract: a mismatch refuses at both ends and parks; revival re-dials
  at heartbeat cadence; a fixed value heals; one side absent admits;
  malformed drops; `r: 2` with any `c` is never refused.
- The role rule with and without a secret: `uuid-taken`, the member link
  alive, no `dupLink` row; a member HELLO evicts a squatting client link;
  two same-uuid clients keep today's rule.
- The dup fault: a duplicated HELLO or DOOR after admission is dropped and
  the link lives (secured); a duplicated HELLO on the open path re-admits as
  today (the golden).
- The timer: a proving link with no DOOR dies at `proveMs` and parks, with
  heartbeats off.
- `m: 1` sets `link.methodsOnly`; `feederMethodsOnly` follows the primary
  across a failover.
- Byte identity: with nothing set the goldens, the sweep and the 59,500 pin
  do not move.

**Only real sockets prove** (tests/, api/index.test.ts, tests/config.test.
ts):

- node:crypto's HMAC and `randomBytes`: two real links never share a nonce;
  a proof made by one process verifies in another.
- The config layers deliver the secret and the flag is refused; the
  per-resource rung; the redaction; no message contains the value.
- The stderr lines, deduped across revivals.
- The best-effort `DOOR { e }` under `socket.destroy()`, and the close-
  while-proving inference.
- The directory squatter on a real box: a raw socket registered as `shop`
  is refused and the real members form.
- The STATUS bug end to end: a raw `net.Socket` writes a crafted HELLO
  claiming a live member's uuid (with `r: 1`, then without) to a secured
  server; the member's link survives and `cluster` keeps both members. The
  same against an OPEN server with `r: 1`: refused by the role rule. Without
  `r: 1` against an open server the link still drops: that test documents
  the default's limit.
- `fero.spawn` children with `FERO_SECRET` in the environment.
- `fn.toString()` stability on this Node.

## §10 Perf and the pins

The record path is untouched: no change to RECORDS, WRITE, WACK, WNACK,
DIGEST, VIEW or the apply loop. The Z1-Z4 zero-garbage pins and the
write/codec/node pins run with no secret and the same frames as today.

- **No secret:** zero new frames; one string compare of `c` per HELLO on
  servers; two `undefined` checks on the handler's open path; about 70
  bytes per server HELLO. Nothing on a per-record path. On a client,
  `Bind.issue` reads one property per batch. `api/data.perf.ts` and data's
  suite run A/B back to back on tmpfs (the WSL2 rule); the structure says
  neutral.
- **With a secret:** two HMAC-SHA256 per link per side over about 200 bytes
  (microseconds in node:crypto); two extra frames per link; admission at
  1 RTT for the acceptor and 1.5 RTT for the dialer instead of ½; one timer
  per proving link. A 100-member mesh forming is about 20,000 HMACs, once.
- **Pins that move:** none. `sim/scale.perf.ts:32-41` (59,500) runs with no
  secret. The sweep goldens are unchanged. `api/config.perf.ts` walks one
  more `LEAVES` row (noise; the threshold stays).
- **New pins:** a sim count pin, 100-node formation WITH a secret, measured
  once at landing and recorded in DECISIONS (structural, so stable on
  WSL2); it is what catches a later frame added to the handshake unnoticed.

## §11 The tests

- **kernel/door.test.ts** (new; the discover.test.ts idiom, two nodes
  stepped by hand): the open-path HELLO bytes equal a literal v4.0 encoding
  (the byte-identity guard, plus a journal-row golden for the no-secret
  HELLO sequence, since the sweep golden hashes state not rows); malformed
  `c`, `m`, `k`, `p` each drop and close; with a door on both sides,
  admission only after DOOR, RECORDS/DIGEST/WRITE in `proving` close
  'before hello', the dialer sends DOOR first and the acceptor's DOOR
  precedes its digest and VIEW; wrong secret → `bad-proof` + `{ e }`, the
  dialer journals `refused`; one side only → `no-secret` / `peer-secret`,
  both park; replay → refused, the real link still admitted (THE regression
  for STATUS.md:54); reflection → refused; the acceptor never proves first
  (oracle); the role rule four ways (r:1 vs a view member, r:1 vs an
  admitted member link, a member vs a squatting client link, client vs
  client), with and without a door; `address` on a discovered and a
  view-learned target, exempt on a static host; the timer at `proveMs` with
  heartbeats off; DOOR on an admitted link drops; a second HELLO drops on a
  secured node and re-admits on an open one; contract mismatch / match /
  one-sided / malformed / r:2; `m: 1` → `link.methodsOnly`,
  `feederMethodsOnly` follows the primary across failover; the crossing-dial
  case (both dial each other) proves both links and the keeper picks one as
  today. Each test mutation-checked: drop the guard, watch it go red.
- **kernel/codec.test.ts:** HELLO round-trips with `c`, `m`, `k`; DOOR with
  `{ p }` and `{ e }`.
- **kernel/tune.test.ts:** the `proveMs` row and its floor.
- **sim:** a `door` family of about 200 seeds, a secret on every member plus
  one intruder per seed (wrong secret, no secret, a member's uuid as r:1, a
  replay); the new monitors; the 4-per-link frame count; the forwarder case;
  the existing golden unchanged.
- **api/config.test.ts and tests/config.test.ts:** `secret` from the call,
  `FERO_SECRET`, `FERO_SHOP_SECRET` over `FERO_SECRET`, a `$HOME` file;
  `--fero.secret` refused naming the flag; a number, a boolean, a 15-
  character value refused without echoing the value; `''` unset; `off` →
  false; `secret: 123` in the call refused by the composer;
  `diag(f).config()` redacted; the secret string appears in no thrown
  message; `FERO_CONFIG=off` with `FERO_SECRET` set prints its one line;
  `secret` is in `CONFIG_LEAVES` and the README table (the drift test).
- **api/index.test.ts** (real TCP; the :329 template): the same secret forms
  three members; different secrets never link, both journals carry
  `doorReject`, one stderr line per peer and reason with no duplicate across
  revivals; a secured server and a no-secret client (the client's line names
  `FERO_SECRET`); a client with a member's uuid is refused while the member
  stays linked (secret on, secret off); `heartbeat.ms` 500 against 250 →
  `contractReject` naming `heartbeat.ms` with both values; different
  validation text → names `validation`; `methods:` + `seams.validation`
  with a differing validator → refused (the V4-5 pair); methods-only hint:
  `data.x = 1` on a client gives a `rejected` row with no `pending` row and
  no WRITE frame, `methods.update` rejects at once with `WriteRejectError`
  reached `issued` reason `methods-only`, a write before the first admit is
  still refused remotely; a non-loopback listen with no secret throws, with
  `secret: false` runs, and the directory-socket refusal still wins for
  `0.0.0.0:3376`.
- **api/directory.test.ts:** a secured server is found through a private-
  port directory; a raw socket registered as the name is refused at the door
  and the real members form.
- **tests/ real-TCP tier:** the raw-socket STATUS scenario in §9, three ways.
- **tools/debug:** eli5 entries for `contractReject` and `doorReject` (the
  glossary gate in tools/debug/eli5.test.ts fails without them); model.mjs
  treats both like `nameReject` (tools/debug/model.mjs:260); the honesty
  gate counts.
- **examples.test.ts:** unchanged and green with nothing configured; 11's
  README prose re-read against its check.

## §12 What was rejected, and from whom

- **TLS 1.3 with a pre-shared key at the shell** (the shell proposal's
  core). It encrypts and authenticates for free, and `peer` on `linkUp` is a
  clean seam. Rejected for this change because the kernel never sees the
  door, so the sim cannot prove the handshake, the replay refusal or the
  stranger refusal on a seeded schedule; the shell stops being thin (the
  I-21 hang class on `secureConnect`, handshake timeouts, BoringSSL
  runtimes); and its own skeptic found that a plain client against a TLS
  server gets no message at all, only a closed socket. TLS stays the right
  LATER layer for sealing the stream, and this handshake runs unchanged
  under it; the `peer`-on-linkUp idea is the shape to reuse then.
- **mTLS with certificates** (all three proposals rejected it): a CA, a
  cert per node and client, rotation, expiry; every example would need
  files.
- **A pure-TS SHA-256 and HMAC inside kernel/** (the kernel proposal).
  Hand-rolled crypto in the safety-critical module, and the secret would sit
  in kernel state next to captures. Injecting `door.mac` keeps the kernel
  crypto-free, mirrors `validate`, and lets node:crypto do the hashing. The
  cost: the sim proves the protocol with a toy MAC, not the cryptography;
  the real-TCP tier covers the closure.
- **Both sides prove at once, with a direction bit** (the kernel proposal).
  Sound, but every member then signs any nonce for anyone who can connect,
  and the safety argument needs the bit. Dialer-first makes the argument
  one sentence for half a round trip on the dialer side.
- **An HMAC in HELLO alone, no second frame:** a captured HELLO replays on a
  new connection into a full admission.
- **The incarnation as the replay bound:** a reconnect after a blip looks
  exactly like a replay.
- **Nonces from `env.rng`:** `Math.random` in the shell (shell/runtime.ts:
  144-145).
- **An 8-hex contract hash** (the plan's default, the kernel proposal): the
  operator cannot tell which key differs. Sixty bytes once per link buy the
  key and both values.
- **One `door=methods|validation|open` field** (the kernel proposal): hides
  validation drift under `methods:`; two fields instead.
- **"The first holder keeps the uuid"** (the operator proposal): a client
  that connects first locks a member out of a peer; the member wins.
- **Binding the dialed address into the proof for EVERY target** (rejected
  by all three): typed `hosts` differ in spelling from a peer's own listen
  (`0.0.0.0`, hostnames, NAT). The address rule applies only where the
  string is the peer's own listen (discovered and view-learned targets),
  where it cannot drift; the kernel and operator skeptics proposed exactly
  this.
- **Two secrets now, `secret.member` and `secret.client`** (the shell
  proposal). Right idea, second step: the shell skeptic showed that in
  one-secret mode the separation does not exist, so the honest record says
  so and lands the derived client key as a follow-up (§14 Q2).
- **A secret flag:** argv is visible to every local user (docs/DESIGN-
  CONFIG.md:390-401, the diag precedent).
- **A secret required on loopback too:** breaks all 27 examples and the
  two-terminal demo for a boundary loopback already gives (V4-3). Required
  off loopback instead (§14 Q1).
- **A per-box secret or TLS for the `#directory`:** a new trust domain that
  protects addresses when the dial itself authenticates.
- **Three journal kinds** (`contractReject`, `authReject`, `uuidReject`):
  two kinds, one for the config mistake (an operator filters on it) and one
  typed for everything the door refuses.
- **A proving timeout on the heartbeat sweep** (the kernel proposal):
  `heartbeat: { ms: 0 }` is a documented opt-out; a timer per secured link
  instead.
- **Dropping a duplicate HELLO on every node** (the kernel proposal): moves
  the golden (14 of 20 seeds re-admit through the dup fault); secured nodes
  only.
- **A per-frame MAC after admission:** that is the record path, and it is
  what TLS is for.
- **A new example rung in this change** (the operator proposal's 18-secret):
  a rung is a README of real terminals, and under the battery its check
  must delete `FERO_CONFIG` for the env layer to work at all (the operator
  skeptic). Worth doing after the door lands (§14 Q5).

## §13 Size and the commit plan

M to L: about 1,000 to 1,300 lines, 60% tests. Two days of build plus the
three or four review rounds kernel-semantics lanes have needed.

| Where | Lines | What |
|---|---|---|
| kernel/door.ts (new) | ~170 | the presence matrix, the proof message, verify, the address rule, the role rule, the contract compare, `ctEq` moved here from diag.ts |
| kernel/node.ts | ~+60/−15 | the HELLO handler split into the pre-door checks and the admit tail; the DOOR case; `LS.proving`; the prove timer; `NodeOpts.door/contract/methodsOnly`; `feederMethodsOnly` |
| kernel/codec.ts, journal.ts, link.ts, env.ts, tune.ts, ring.ts | ~+20 | `DOOR: 26`; JK 77/78; `LS.proving`, `link.hello`, `link.methodsOnly`; `TAG.prove`; `proveMs`; `RING` |
| api/index.ts | ~+90 | the contract string, the door closure, the off-loopback rule, the stderr printer (deduped per peer and reason, fed from `contractReject`/`doorReject` rows), the client's door read |
| api/config.ts, api/types.ts, api/data.ts | ~+45 | the `secret` leaf, coercion, the carriers template; `FeroOpts.secret`; the per-batch door read in `issue()` |
| sim/door.ts (new), sim tests | ~+60 + ~150 | the toy door; the door family and monitors |
| tools/debug | ~+8 | two eli5 entries, model.mjs |
| site | regenerate | strip.mjs rerun; the wire card |
| tests | ~600 | §11 |
| docs | — | this record; one DECISIONS entry; README rows (`secret`, the `cluster` scope sentence, the drift sentence at :91); DESIGN-CONFIG rows; STATUS: :54, :56, :62 leave, one line on rotation enters; examples/11 prose |

Commits, each with its tests and `npm test` + `npm run perf` green:

1. **The role rule.** No wire change, no secret. A client HELLO never takes
   a member's uuid; a member evicts a squatting client link. `doorReject:
   78` lands here with the one reason `uuid-taken`. Closes the accidental
   STATUS case on the default path.
2. **The contract and the hint.** `c`, `m`, `contractReject: 77`, `RING`,
   `link.methodsOnly`, the client's local refusal, 11's prose, the wire
   card. The open-path HELLO grows here; the byte-identity guard for nodes
   that set nothing lands with it.
3. **The door.** `secret`, `door`, `k`, `DOOR`, `LS.proving`, the timer, the
   matrix, the address rule, the stderr lines, the off-loopback rule, the
   redaction (same commit as the leaf), sim/door.ts and the door family.
4. **Docs and gates.** DECISIONS, README, DESIGN-CONFIG, STATUS, eli5,
   site/lib regenerated, the new count pin recorded.

## §14 Open questions for the owner

Each has a default. Silence means the default.

1. **Refuse an off-loopback listen with no secret?** A server with `listen:
   '0.0.0.0:4100'` (or any non-loopback host) and no `secret` fails at
   `fero()` unless it says `secret: false`. Pre-1.0 breaking for anyone
   binding `0.0.0.0` today. *Default: yes.* (The alternative is one stderr
   line and an open server.)
2. **One shared secret now, or two keys now?** With one secret every client
   is a member on the wire; a dishonest client can claim any uuid. A derived
   client key (`secret.client = HMAC(secret, 'fero/client/1')`, given to
   processes that may only follow; members check an `r: 1` proof with it and
   every other proof with the secret) closes that in about 30 lines, but
   adds a key and a mode. *Default: one secret in this change, the derived
   key as the first follow-up, the limit written in README and §7.*
3. **The contract as a readable string, not a hash?** About 60 more bytes
   once per link; the refusal names the key and both values. *Default: the
   string.*
4. **stderr lines from the library on refusals?** One line per peer address
   and reason per process, for `contractReject` and every `doorReject`
   reason. `nameReject` stays silent as today, or joins? *Default: print
   for the two new kinds; leave `nameReject` as it is.*
5. **A secret example rung later?** Two members with the secret, a third
   without, both screens showing the refusal. Not in this change. *Default:
   a follow-up rung after the door lands.*
6. **The address rule's reach.** Apply it to discovered and view-learned
   targets only (typed `hosts` exempt), as designed, or to every target and
   accept false refusals on mixed spellings? *Default: discovered and view
   only; the static-host relay goes in NOT PROTECTED until TLS.*
7. **The secret floor.** 16 characters, with `openssl rand -base64 24` as
   the hint. *Default: 16.*
