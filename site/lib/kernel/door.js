//! ── kernel/door — who may become a peer (docs/DESIGN-DOOR.md §3) ───────────────────────────────
// The rules that run on an inbound HELLO before a link is admitted, as pure functions over the HELLO's
// keys and the link's facts: the presence matrix, the proof message, verify, the address rule, the
// contract compare. The kernel holds NO crypto and NO secret: `NodeOpts.door` hands it two functions —
// mac(msg) and nonce() — and, with the derived client key (§15), a third, clientMac(msg) — which the api
// builds from node:crypto and the sim from a seeded toy (sim/door.ts). So the sim proves the PROTOCOL
// (replay, forgery, the relay, the order of frames) on seeded schedules, and the real-TCP tier proves the
// cryptography. Nothing here reaches outside the kernel (kernel/purity.test.ts), and nothing here
// journals: node.ts owns every row.
//
// The handshake, in one breath: both ends send HELLO at linkUp; with a door the HELLO carries `k`, a
// fresh nonce for this link. The DIALER proves first — DOOR {p}, an HMAC over both nonces, both uuids,
// its side and every HELLO key it sent — and the acceptor proves back ONLY to a verified dialer, then
// admits. A link that has read a HELLO with `k` sits in LS.proving: outside byUuid, clientLinks and
// admitted(), able to carry nothing but DOOR. Replay fails on the fresh nonce; reflection fails on the
// side label; a relay fails the address rule; a stranger that can only connect never gets a proof.

                                     

//! Door — what the embedder injects (the `validate` idiom): never a secret string. mac(msg) must return a
// string of exactly PROOF_LEN characters (the api: HMAC-SHA256 as base64url; the sim's toy pads to it).
// clientMac (§15, the derived client key) signs CLIENT LINKS — every link whose dialer said `r: 1` — on
// both sides, so a process that holds only the client key can follow but never prove as a member. A
// member's door carries both (the api derives clientMac from the secret); a client-only door carries the
// client key under both names (it holds nothing else); a door without clientMac keeps the one-key rule.
                                                                                                    

//! HelloKeys — a HELLO's identity keys as a peer sent them (and as this node sent its own): what a proof
// signs, so none of them can change in flight before admission. `u, i, l` are checked for shape before
// anything reads them; the optional keys ride as decoded (shape-checked in node.ts). `v` (DESIGN-LEAVE
// §10.10.6) is the sender's holds, [{e, h, p}], absent when it holds nothing.
                                                                                                                                            

//! the nonce bounds (§2): 16 random bytes as base64url is 22 characters (the api); the sim's toy sends 32
// hex characters; anything outside 16..64 is a malformed HELLO.
export const NONCE_MIN = 16
export const NONCE_MAX = 64
//! UUID_MAX — the most UTF-8 bytes a node's uuid may take. Every frame that carries a record carries its origin (the
// uuid, or uuid~N past the first life), and a committed attempt's frame its issuer too, so the two names must fit the
// envelope room the codec keeps beside a record (roomOf, kernel/codec.ts): never less than 256 bytes, at the smallest
// frame (FRAME_MIN). At 64 the worst envelope is 204 bytes: the origin and the issuer, each 3 length bytes (Writer.str
// always spends 3) plus 64 + 1 + 16 (the '~' and the largest incarnation) = 84, then baseSeq, epoch and baseCid (8 each
// at 2^53), the record count (4) and a pp varint (8). 128 would take 332 and break that room. A HELLO whose uuid is
// longer is malformed; fero() refuses one at compose time (api/index.ts). A default uuid is 8 hex characters, a UUID 36.
export const UUID_MAX = 64
//! ISSUER_MAX — the most UTF-8 bytes an attempt's issuer may take: a uuid, '~' and the incarnation's 16 digits. The
// issuer is the WRITE frame's own claim (its provenance origin), not the admitted uuid, so the HELLO bound does not
// reach it: node.ts checks it on every WRITE before the relay can stamp it. A longer one is a malformed WRITE.
export const ISSUER_MAX = UUID_MAX + 17
//! utf8Len — a string's UTF-8 byte count without encoding it (a lone surrogate counts 3, as TextEncoder writes it)
export const utf8Len = (s        )         => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}
//! PROOF_LEN — HMAC-SHA256 as base64url (§2): the one place the proof's length lives. A DOOR whose `p` is
// not exactly this long is a malformed frame; a right-length wrong value is `bad-proof`.
export const PROOF_LEN = 43

//! ctEq — length + constant-time XOR compare: a token or proof check must not leak match-prefix length
// via timing. Shared with kernel/diag.ts (the DIAG token), where it was born.
export const ctEq = (a        , b        )          => {
  if (a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

//! matrix (§3 steps 7-8) — mine: this node has a door; theirs: the peer's HELLO carried `k`. Both or
// neither agree; one side alone is the mismatch both ends see (and both refuse, so both print).
export const doorMatrix = (mine         , theirs         )                                                   =>
  mine ? (theirs ? 'secured' : 'no-secret') : (theirs ? 'peer-secret' : 'open')

//! proofMsg (§3 "what is signed") — `side` is the PROVER's side on this link, so a proof cannot be turned
// around; verifierNonce is the `k` the verifier minted for this link, proverNonce the prover's own;
// verifierUuid and verifierListen are the `u` and `l` the verifier's HELLO CLAIMED, as the prover read
// them; then every HELLO key the prover sent (absent keys read as 0 / '' so the array has one shape).
// The verifier rebuilds the message with its OWN uuid and the `l` it actually sent, so a HELLO whose
// `l` was rewritten in flight — the relay that answers for a member under its own address, so the
// address rule cannot see it — yields a proof the real member cannot verify: `bad-proof`, never
// admitted. JSON over an array of strings and numbers has one encoding, so there is no separator
// ambiguity. The label versions the message.
//! `v` (DESIGN-LEAVE §10.10.6, 2026-10-12) is signed INSIDE the array as [[e, p, h], …] — arrays of numbers
// and strings, one encoding, where the objects as decoded would have the decoder's key order and a
// canonical string would bring back the separator ambiguity. For consistency with the other HELLO keys
// (the door guards the admit, and the HELLO is the one word read before a link is counted), not for
// protection afterwards: the same holds travel unsigned in every PULL `vs` after admission, as a VOTE or
// a VIEW does. The label is fero-door/2 on purpose: a peer from before this key never verifies here and
// we never verify there, so a secured pair of mixed versions fails `bad-proof` at both ends at once,
// rather than only once a hold rides a HELLO (mixed versions are unsupported before 1.0, V4-14).
export const proofMsg = (side                       , verifierNonce        , proverNonce        , verifierUuid        , verifierListen        , h           )         =>
  JSON.stringify(['fero-door/2', side, verifierNonce, proverNonce, verifierUuid, verifierListen, h.u, h.i, h.l, h.r ?? 0, h.n ?? '', h.c ?? '', h.m ?? 0, holdsSigned(h.v)])

//! holdsSigned — `v` as the proof signs it: each hold as [e, p, h]; [] when absent
export const holdsSigned = (v         )                             =>
  Array.isArray(v) ? (v                                         ).map((x) => [x.e, x.p, x.h]) : []

//! sign (§15) — which key signs this link: the DIALER's HELLO says. `r: 1` from the dialer makes a client
// link, signed with the client key on both sides (the member's answer too: a client holds nothing else);
// any other link is signed with the secret. The dialer's `r` is inside its own proof, so it cannot be
// checked as a client and admitted as anything else. A door without clientMac signs everything with mac.
const sign = (door      , dialer           , msg        )         =>
  dialer.r === 1 && door.clientMac !== undefined ? door.clientMac(msg) : door.mac(msg)

//! prove — MY proof on this link: over the peer's nonce (their `k`), my nonce, the uuid and listen they
// claimed, and the HELLO I sent (link.said, the exact object that went out at linkUp).
export const prove = (door      , link      , mine           , theirs           )         =>
  sign(door, link.dialed ? mine : theirs, proofMsg(link.dialed ? 'dialer' : 'acceptor', theirs.k          , link.nonce, theirs.u, theirs.l, mine))

//! verify — the PEER's proof: rebuilt from the stashed HELLO with the peer's side, my nonce as the
// verifier's, my uuid and the listen I SENT on this link (link.said.l — what a prover that read my
// HELLO unaltered signed); compared in constant time.
export const verify = (door      , link      , myUuid        , theirs           , p        )          =>
  ctEq(sign(door, link.dialed ? link.said  : theirs, proofMsg(link.dialed ? 'acceptor' : 'dialer', link.nonce, theirs.k          , myUuid, link.said .l, theirs)), p)

//! addressOk (§3 step 9, the relay) — a link I DIALED whose target is not one of my STATIC hosts came
// from the directory's discover set or a committed view's member listen: both carry the peer's own
// `node.listen`, the very string the peer puts in its HELLO as `l`. So the claimed `l` must equal the
// address I dialed, or someone between us is answering for it. Static hosts are exempt: an operator
// types them in any spelling (0.0.0.0, a hostname, a NAT address). Accepted links are never checked.
export const addressOk = (link      , statics                               , claimed        )          =>
  !link.dialed || link.to === undefined || claimed === link.to || (statics !== undefined && statics.includes(link.to))

//! contractDiff (§4) — the first key whose value differs between two contract strings (`v1;k=v;k=v` — the
// leading bare token is the version). Returns [key, THEIR value]; a key one side lacks reads
// `missing:<key>` (their value, or '' when they lack it). Called only when the strings differ.
export const contractDiff = (mine        , theirs        )                   => {
  const parse = (s        )                     => s.split(';').map((t) => { const i = t.indexOf('='); return i < 0 ? ['version', t] : [t.slice(0, i), t.slice(i + 1)] })
  const ours = parse(mine), b = new Map(parse(theirs))
  for (const [k, v] of ours) { const t = b.get(k); if (t === undefined) return [`missing:${k}`, '']; if (t !== v) return [k, t] }
  for (const [k, v] of b) if (!ours.some(([ok]) => ok === k)) return [`missing:${k}`, v]
  return ['version', theirs] // same keys, same values, a different spelling: name the whole string
}
