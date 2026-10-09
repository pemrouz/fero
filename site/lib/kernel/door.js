//! ── kernel/door — who may become a peer (docs/DESIGN-DOOR.md §3) ───────────────────────────────
// The rules that run on an inbound HELLO before a link is admitted, as pure functions over the HELLO's
// keys and the link's facts: the presence matrix, the proof message, verify, the address rule, the
// contract compare. The kernel holds NO crypto and NO secret: `NodeOpts.door` hands it two functions —
// mac(msg) and nonce() — which the api builds from node:crypto and the sim from a seeded toy
// (sim/door.ts). So the sim proves the PROTOCOL (replay, forgery, the relay, the order of frames) on
// seeded schedules, and the real-TCP tier proves the cryptography. Nothing here reaches outside the
// kernel (kernel/purity.test.ts), and nothing here journals: node.ts owns every row.
//
// The handshake, in one breath: both ends send HELLO at linkUp; with a door the HELLO carries `k`, a
// fresh nonce for this link. The DIALER proves first — DOOR {p}, an HMAC over both nonces, both uuids,
// its side and every HELLO key it sent — and the acceptor proves back ONLY to a verified dialer, then
// admits. A link that has read a HELLO with `k` sits in LS.proving: outside byUuid, clientLinks and
// admitted(), able to carry nothing but DOOR. Replay fails on the fresh nonce; reflection fails on the
// side label; a relay fails the address rule; a stranger that can only connect never gets a proof.

                                     

//! Door — what the embedder injects (the `validate` idiom): never a secret string. mac(msg) must return a
// string of exactly PROOF_LEN characters (the api: HMAC-SHA256 as base64url; the sim's toy pads to it).
                                                                   

//! HelloKeys — a HELLO's identity keys as a peer sent them (and as this node sent its own): what a proof
// signs, so none of them can change in flight before admission. `u, i, l` are checked for shape before
// anything reads them; the optional keys ride as decoded (shape-checked in node.ts).
                                                                                                                               

//! the nonce bounds (§2): 16 random bytes as base64url is 22 characters (the api); the sim's toy sends 32
// hex characters; anything outside 16..64 is a malformed HELLO.
export const NONCE_MIN = 16
export const NONCE_MAX = 64
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
export const proofMsg = (side                       , verifierNonce        , proverNonce        , verifierUuid        , verifierListen        , h           )         =>
  JSON.stringify(['fero-door/1', side, verifierNonce, proverNonce, verifierUuid, verifierListen, h.u, h.i, h.l, h.r ?? 0, h.n ?? '', h.c ?? '', h.m ?? 0])

//! prove — MY proof on this link: over the peer's nonce (their `k`), my nonce, the uuid and listen they
// claimed, and the HELLO I sent (link.said, the exact object that went out at linkUp).
export const prove = (door      , link      , mine           , theirs           )         =>
  door.mac(proofMsg(link.dialed ? 'dialer' : 'acceptor', theirs.k          , link.nonce, theirs.u, theirs.l, mine))

//! verify — the PEER's proof: rebuilt from the stashed HELLO with the peer's side, my nonce as the
// verifier's, my uuid and the listen I SENT on this link (link.said.l — what a prover that read my
// HELLO unaltered signed); compared in constant time.
export const verify = (door      , link      , myUuid        , theirs           , p        )          =>
  ctEq(door.mac(proofMsg(link.dialed ? 'acceptor' : 'dialer', link.nonce, theirs.k          , myUuid, link.said .l, theirs)), p)

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
