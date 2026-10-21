// sections/demo/words.js — the narrator's reasons, read from the kernel: why a write waits, who can vote, and what a
// broken rule means. DOM-free, so the same code runs in Node against a LiveCluster (tests/demo.drive.mjs checks it
// there before it drives the page).
//
// A sentence is "parts": strings and small objects that demo.js renders (and attests): { n } a process name,
// { m } a mood, { c, mood } code that sets a mood, { v } a number, { star } luna's owner's ★, { ok } a green mark.
import { pair } from '../../core.js'

export const N = (id) => ({ n: id })
export const M = (m) => ({ m })
export const V = (v) => ({ v })
export const OK = (ok) => ({ ok })
export const STAR = { star: 1 }
export const CODE = (c, mood) => ({ c, mood })
// a no-break space: what it joins never splits across two lines
export const NB = '\u00a0'
// luna's owner as the narrator names it: the name and its ★, joined so the star never wraps away from the name
export const OWNS = (id) => [N(id), NB, STAR]
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
export const words = (n) => WORDS[n] ?? String(n)
// a simulated duration: one decimal, and a no-break space so "1.3 s" never splits across lines
export const secs = (ms) => `${(ms / 1000).toFixed(1)} s`
// a, b and c (names as parts)
export function list(ids) {
  if (ids.length <= 1) return ids.map(N)
  return [...ids.slice(0, -1).flatMap((id, i) => (i ? [', ', N(id)] : [N(id)])), ' and ', N(ids[ids.length - 1])]
}
// the moods a sentence quotes (a stale quote is how the narrator knows a newer write makes it wrong)
export function moodsIn(parts, out = new Set()) {
  if (Array.isArray(parts)) for (const p of parts) moodsIn(p, out)
  else if (parts && typeof parts === 'object') { if (parts.m) out.add(parts.m); if (parts.mood) out.add(parts.mood) }
  return out
}
// a line of the kernel's log (core.js page.log) in the page's own words, for the door. core.js prints a commit's
// stamp as "view 6 · #8197 · n01~3" and a value as JSON, { mood: "grumpy" }. The door prints the stamp the way 01's
// door does, "view 6 · counter 8197 · n01" (the owner's name without its life number: "~3" is n01's third life),
// and a value the way the café's code is written, { mood: 'grumpy' }.
export function plainLog(s) {
  return String(s)
    .replace(/view (\d+) · #(\d+) · ([^\s·~]+)(?:~\d+)?/g, 'view $1 · counter $2 · $3')
    .replace(/"([^"'\\]*)"/g, "'$1'")
}
// plain text of parts (for the drive and for logs)
export function text(parts) {
  if (parts == null || parts === false) return ''
  if (Array.isArray(parts)) return parts.map(text).join('')
  if (typeof parts === 'string') return parts
  return String(parts.n ?? parts.m ?? parts.c ?? parts.v ?? parts.ok ?? (parts.star ? '★' : ''))
}

// ── who can help ─────────────────────────────────────────────────────────────────────────────────────────────
// a server is "up" when it runs and is not cut off; the page cuts whole processes, so the up servers can all reach
// each other. Why one cannot help a write: it is down, it has left, it is cut off, or it runs but is not (back) in
// the list of servers the last vote agreed on.
const up = (page, id) => page.alive(id) && !page.isolated(id)
export function reasonOf(page, id, members) {
  if (!page.alive(id)) return page.left.has(id) && !page.down.has(id) ? 'left' : 'down'
  if (page.isolated(id)) return 'cut'
  if (members && !members.includes(id)) return 'out'
  return null
}
const REASON = { down: ' is down', left: ' has left', cut: ' is cut off', out: ' is not back in the list of servers yet' }
// "n01 is down, n02 has left and n03 is cut off" (two or more down: "n01 and n03 are down")
export function reasons(rs) {
  const by = new Map()
  for (const [id, r] of rs) { if (!by.has(r)) by.set(r, []); by.get(r).push(id) }
  const clauses = [...by].map(([r, ids]) => ids.length === 1 ? [N(ids[0]), REASON[r]]
    : [list(ids), r === 'down' ? ' are down' : r === 'left' ? ' have left' : r === 'cut' ? ' are cut off' : ' are not back in the list of servers yet'])
  if (clauses.length <= 1) return clauses
  return [...clauses.slice(0, -1).flatMap((c, i) => (i ? [', ', c] : [c])), ' and ', clauses[clauses.length - 1]]
}
// who is left to vote on the list of servers, and whether they are more than half of it
export function voters(page, without = null) {
  const v = page.view()
  const rest = v.members.filter((m) => m !== without && up(page, m))
  return { members: v.members, rest, can: rest.length * 2 > v.members.length }
}
// "n03 alone cannot vote it in", "n02 and n03 cannot vote it out", "Nobody can vote it in yet"
export function cannotVote(rest, how) {
  if (!rest.length) return ['nobody in the list of servers can be reached to vote it ', how]
  return [list(rest), rest.length === 1 ? ' alone' : '', ' cannot vote it ', how, ': more than half of the servers must agree']
}

// ── why a write from the client waits ────────────────────────────────────────────────────────────────────────
// holdCause(page, c1) → null when a write from c1 can go through now, else { key, kind, … }. The key names the cause,
// so the narrator says each cause once. Checked in the order a reader would look: the client itself, any server at
// all, luna's owner (down or cut off: the others must vote it out first, if they can), then more than half of the
// list of servers on the owner's side (the kernel's write gate, membership.gate: "minority"), then c1's own server
// not yet back in the list (its gate: "joining" or "evicted").
export function holdCause(page, c1, row = 'luna', owner = undefined) {
  if (!c1 || !page.alive(c1)) return null
  const v = page.view()
  if (!v.epoch) return null                                 // before the first vote nothing is held (open start)
  const S = page.serverIds
  if (page.isolated(c1)) return { key: `self-cut:${c1}`, kind: 'self-cut', c1 }
  const link = (a, b) => page.alive(a) && page.alive(b) && !page.cuts.has(pair(a, b))
  if (!S.some((s) => link(c1, s))) return { key: 'no-server', kind: 'no-server', c1, why: S.map((s) => [s, reasonOf(page, s, null) ?? 'cut']) }
  owner ??= page.owner(row)
  if (owner && (!page.alive(owner) || page.isolated(owner))) {
    const { rest, can } = voters(page, owner)
    const kind = page.alive(owner) ? 'owner-cut' : 'owner-down'
    return { key: `${kind}:${owner}:${can ? 'vote' : 'stuck'}`, kind, owner, can, rest, c1 }
  }
  const side = v.members.filter((m) => up(page, m))
  if (owner && side.length * 2 <= v.members.length) {
    const why = S.filter((s) => s !== owner).map((s) => [s, reasonOf(page, s, v.members)]).filter(([, r]) => r)
    return { key: `minority:${owner}:${why.map((w) => w.join('=')).join()}`, kind: 'minority', owner, why, c1 }
  }
  const relay = page.primary(c1)
  if (relay && up(page, relay) && !v.members.includes(relay)) {
    // since V4-58 a client leaves a server whose writes are shut for a linked one whose writes are open, so with such
    // a server in reach the wait ends either way: the relay is voted back in, or c1 moves first
    const move = S.some((s) => s !== relay && link(c1, s) && up(page, s) && v.members.includes(s))
    return { key: `relay-out:${relay}:${move ? 'move' : 'stay'}`, kind: 'relay-out', relay, c1, move }
  }
  return null
}

// the sentence for a cause. subject 'write': "c1's write waits"; 'writes': "writes wait" (a crash, a cut, a stop)
export function causeParts(c, subject = 'write') {
  const w = subject === 'write'
  const so = w ? ['so ', N(c.c1), '\'s write waits'] : ['so writes wait']
  switch (c.kind) {
    case 'self-cut': return [N(c.c1), ' is cut off, so its ', w ? 'write waits' : 'writes wait', ' for the split to heal. It still reads its own copy.']
    case 'no-server': return [N(c.c1), ' cannot reach any server: ', reasons(c.why), '. So its ', w ? 'write waits' : 'writes wait', '. It still reads its own copy.']
    case 'owner-down':
    case 'owner-cut': {
      const state = c.kind === 'owner-down' ? ' is down' : ' is cut off'
      if (c.can) return ['luna\'s owner, ', N(c.owner), ',', state, ', ', so, ' until the others vote it out.']
      return ['luna\'s owner, ', N(c.owner), ',', state, ', and ', cannotVote(c.rest, 'out'), '. So ', w ? [N(c.c1), '\'s write waits'] : 'writes wait', '. Reads still work.']
    }
    case 'minority': return [N(c.owner), ' cannot reach more than half of the servers', c.why.length ? [': ', reasons(c.why)] : '', '. So ', w ? [N(c.c1), '\'s write waits'] : 'writes wait', '. Reads still work.']
    case 'relay-out': return c.move
      ? [N(c.c1), '\'s server, ', N(c.relay), ', is not back in the list of servers yet, ', so, ' until the others vote it in or ', N(c.c1), ' moves to a server in the list.']
      : [N(c.c1), '\'s server, ', N(c.relay), ', is not back in the list of servers yet, ', so, ' until the others vote it in.']
  }
  return [N(c.c1), '\'s write is waiting.']
}
// the short line under "writes waiting"
export function causeLine(c) {
  switch (c?.kind) {
    case 'self-cut': return `${c.c1} is cut off`
    case 'no-server': return `${c.c1} cannot reach any server`
    case 'owner-down': return `luna's owner, ${c.owner}, is down`
    case 'owner-cut': return `luna's owner, ${c.owner}, is cut off`
    case 'minority': return `${c.owner} cannot reach more than half of the servers`
    case 'relay-out': return `${c.relay} is not back in the list of servers yet`
  }
  return ''
}

// ── a broken rule ────────────────────────────────────────────────────────────────────────────────────────────
// The rule itself is printed in core.js's words (RULE_LINES: what each rule checks, the table 04 prints too).
// The kernel's rules report each distinct breach once (core.js); the "(seen at …)" tail names the node that saw it.
export function breaches(page) {
  return (page.sim?.violations ?? []).map((x) => ({ monitor: x.monitor, detail: String(x.detail).replace(/ \(seen at [^)]*\)$/, '') }))
}
const who = (lane) => String(lane).split('~')[0]
// what the simulator caught, in plain words, and whether the copies agree now (read live). It says what happened,
// never what cannot happen. The rule the page can reach is attempt-exactly-once: the owner put a write in order and
// crashed before its copy reached the next owner, which put the write in order again when it was sent again.
export function breachParts(b, page, { crashed = () => false } = {}) {
  const agree = !!page.agree?.()
  const x = /^attempt (\S+?)\|\d+ committed TWICE: (\S+?)\|\d+\|\d+ and (\S+?)\|\d+\|\d+/.exec(b.detail)
  if (b.monitor === 'attempt-exactly-once' && x) {
    const c = who(x[1]), first = who(x[2]), second = who(x[3])
    const head = 'The simulator caught one write put in order twice. '
    const same = agree ? ' Same value, so the copies still agree.' : ' Same value.'
    if (first !== second && crashed(first)) return [head, N(first), ' put ', N(c), '\'s write in order and crashed before its copy reached ', N(second), ', so ', N(second), ' put the retry in order too.', same]
    if (first !== second) return [head, N(first), ' and ', N(second), ' both put ', N(c), '\'s write in order: the retry reached ', N(second), ' before the first copy did.', same]
    return [head, N(first), ' put ', N(c), '\'s write in order again when it was sent again.', same]
  }
  return ['The simulator caught it the moment it happened.', agree ? ' The copies still agree.' : '']
}
