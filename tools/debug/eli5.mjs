//! ── tools/debug/eli5 — the plain-English glossary + the ONE tooltip layer, shared verbatim by both debugger pages ──
// Plain-JS ESM like model.mjs, for the same reason: ONE copy of the words and ONE copy of the hover
// wiring, imported by viewer.html AND scenarios.html (the browser loads these exact bytes) and by the
// tests — two hand-ported copies would drift the way v2's reductions did. Everything on screen a
// newcomer could not decode at a glance carries data-tip="<key>"; the key resolves HERE or nowhere.
//
// HONESTY RULES, applied to words (the viewer's chrome residue, DESIGN-M7 §4): an entry explains what a
// label MEANS, it never asserts a fact about the loaded capture — facts ride the visible row, and when
// a tip wants one repeated it arrives through data-tip-fact (escaped, rendered as a dim second line).
// An unknown key renders NO tooltip: absence renders as absence, and eli5.test rejects dangling keys in
// both directions (a page naming a key this file lacks; this file holding copy no page can reach).
//
// VOICE: one term line + one or two plain sentences; every word of jargon is either explained in the
// sentence or has its own entry a hover away. Written for a reader who has never met a distributed
// system — "computer", "copy", "counter", "tie-break" — never for the kernel author.

//! ELI5 — key → { t: the term as a short label, d: the explanation }. Namespaces:
//   (bare)      chrome + facts        f:<head>    omni filter heads        sev:<s>      severity rollups
//   g:<group>   tree groups           node:/write:/cell:/link:<status>   pills AND the matching filter values
//   wm:<mark>   the watermark ladder  stop:<s>    route timeline stops     route:<part> tree write-row markers
//   rec:<type>  change-record types   jk:<kind>   every journal kind (the kernel's closed JK vocabulary)
//   kind:<k>    capture / scenario kinds   d:<glyph>  dashboard diagram   p:<phase>  phase strip   m:<metric>  metric keys
//   delta:<d>   dashboard delta cells  psev:<s>   phase diamond colours   side:<s>   link sides   absent:<r>  attach absences
export const ELI5 = {
  // ── the omni filter ──
  'filter':       { t: 'the filter', d: "Type to narrow the tree. A plain word matches names; is:crit keeps only the broken things; write:lww-lost, cell:contested or node:n01 pick by facet. A space means AND, a comma means OR." },
  'matches':      { t: 'match count', d: "How many rows fit the filter. Rows that do not match are hidden; their parents are kept but dimmed so you can see where the hits live." },
  'filter-clear': { t: 'clear the filter', d: "Show the whole tree again (pressing the A key does the same)." },
  'f:is':         { t: 'is: — by severity', d: "Keep only rows at one severity: is:crit for things that are broken, is:warn for things worth a look, is:info for ordinary transitions." },
  'f:node':       { t: 'node: — one computer', d: "Keep one computer's row and everything under it — its connections and incoming streams. The value is a piece of the computer's name." },
  'f:origin':     { t: 'origin: — by author', d: "Keep writes by their author, and fields by the author of the value they currently hold. Every write is stamped with its author's name, so this follows one author's work through the whole cluster." },
  'f:key':        { t: 'key: — by address', d: "Keep writes and fields whose address contains this text — the row name and the field path, joined by ·." },
  'f:write':      { t: 'write: — by outcome', d: "Keep writes by how they fared: applied (every computer took it), lww-lost (lost a tie-break somewhere), never-arrived (a computer has no record of it), duplicate (some computer only ever saw a second copy of it)." },
  'f:cell':       { t: 'cell: — by field state', d: "Keep fields by their state: contested (two writers raced for it) or diverged (computers disagree on its value)." },
  'f:link':       { t: 'link: — by connection state', d: "Keep connections by state: pre-admit (open but not yet admitted as a peer — usually the hello is still in progress), syncing (catching up before live changes flow), paused (the outgoing pipe is full), closing (refused — a lost dial race, a dial to itself, or the wrong resource; visible only while rewinding)." },
  'f:kind':       { t: 'kind: — by diary entry', d: "Keep computers whose event diary contains this kind of entry. The names come from this recording's own vocabulary, so the list is always the real one." },
  'sev:crit':     { t: 'crit — something is broken', d: "Red means a promise looks broken: computers hold different data (on a live view that can be a change still being copied — watch the next snapshot), a write is provably lost after everything settled, or a rule the simulator checks failed." },
  'sev:warn':     { t: 'warn — worth a look', d: "Amber is not a failure: a field two writers raced for, a diary with pages missing, a write still on its way, a connection still catching up." },
  'sev:info':     { t: 'info — an in-between state', d: "Blue marks an ordinary transition, like a connection that is open but not yet admitted as a peer — usually one whose hello is still in progress." },

  // ── time travel ──
  'time-travel':       { t: 'time travel', d: "Drag, or use the mouse wheel, to rewind every computer's diary to a step number and rebuild what each knew then: its stored fields, its open connections, its incoming streams, how far each write had got. The step is a per-computer count, not a clock: step 100 on two computers did not happen at the same moment." },
  'time-travel-off':   { t: 'time travel unavailable', d: "Some computer's diary lost its oldest pages, so a rewind would have to make up the beginning. The page refuses to guess." },
  'time-travel-reset': { t: 'back to the present', d: "Leave the rewind and show the end of the recording again. On a live view, snapshots resume." },
  'tread':             { t: 'step / last step', d: "Where the rewind sits: the current step out of the last step any computer recorded. Gold means you are looking at the past." },
  'replayed':          { t: 'a rewound view', d: "Rebuilt from the diaries as of this step: stored fields, the diary itself, how far each write had got, open connections, incoming streams. Counters (seq, epoch) and tie-breaks (elections) are only known at the end, so those show the end — as do connections and streams for a computer whose diary could not reproduce its final tables." },
  'keys@t':            { t: 'fields at this step', d: "How many separate fields this computer held at the rewind point, rebuilt from its diary." },
  'jrnl@t':            { t: 'diary progress', d: "Diary lines up to the rewind point, out of the lines kept. On a run with no writes this is the number that shows time moving." },
  'at-end':            { t: 'as of the end', d: "This pane could not be rewound — either the recording only knows these facts at its end, or replaying this computer's whole diary did not reproduce its final tables (the reason is shown) — so it shows the final picture even while you are looking at the past." },
  'links@t':           { t: 'connections at this step', d: "Lines admitted as peers, out of all open ones, rebuilt from this computer's diary up to the rewind point. Shown only after the page checked that replaying the whole diary reproduces every known field of the final table." },
  'streams@t':         { t: 'streams at this step', d: "Each author's marks rebuilt from this computer's diary up to the rewind point: looked-at and in-the-record-book come straight from diary lines; saved-to-disk is known only for a computer that never saved anything." },
  'unknown@t':         { t: 'not in the diary', d: "The diary does not record this number at this step, so the page shows a dash rather than a guess: how much is parked behind a full pipe, or what had reached disk on a computer that saves to disk." },
  'stream-folded@t':   { t: 'changes folded so far', d: "How many of this author's changes this computer had taken in by the rewind point, counted from its diary — the ones kept and the ones set aside by a tie-break alike." },
  'not-yet@t':         { t: 'not here yet', d: "The row you selected does not exist at this step — the line was not open, the stream had not started, or the field was not written yet. Scrub forward and it reappears, still selected." },

  // ── the source label and the header facts ──
  'live':          { t: 'live view', d: "You are watching real running computers. The page takes a fresh snapshot every 1.5 seconds; whatever happened between snapshots is visible only in the diaries." },
  'live-paused':   { t: 'snapshots paused', d: "You rewound time, so the page stopped taking new snapshots. The computers keep running; return to the present and the page catches up." },
  'scenario':      { t: 'a scripted test run', d: "A named, scripted run of the simulator, like: cut the cable between two computers, then reconnect. This page opened its recording once; nothing updates because the run already finished." },
  'journal-rows':  { t: 'diary lines held', d: "The total number of diary lines the page holds across all computers. It grows on an idle cluster too — heartbeats and check-ins are diary lines." },
  'kind:sim':      { t: 'simulated run', d: "This recording came from a pretend run inside one program: time was fake and every random choice came from one starting number, the seed, so the same seed replays the whole run exactly." },
  'kind:live':     { t: 'live capture', d: "A snapshot of real running computers at one instant. A live capture can never prove a write is lost — only that it had not arrived yet when the snapshot was taken." },
  'seed':          { t: "the run's dice", d: "The starting number for every random choice in the run — delays, duplicated messages, which computer writes what and when. The same seed replays the exact same run." },
  'quiesced':      { t: 'nothing left to happen', d: "The simulated world went completely still: no message in flight, no timer set. Whatever the computers hold now is final — which is what lets a missing write be called lost." },
  'not-quiesced':  { t: 'things were still moving', d: "The recording stopped while messages or timers were still pending, so a write that has not arrived may simply be on its way. Runs with heartbeats never go still, by design." },
  'shrunk':        { t: 'shrunk to the essentials', d: "A failing run cut down until no single remaining step can be dropped without the failure changing kind: A→B means the original A steps were cut to B. Ends @ violation means the recording stops at the moment a rule broke." },
  'converged':     { t: 'everyone agrees', d: "Every computer holds exactly the same data — the goal state, checked by comparing one fingerprint per computer. When each row lives on a few computers only, each row is compared among the computers that keep it; two different names are never compared, and a computer that has left keeps an old copy by design, so it is not compared." },
  'diverged':      { t: 'computers disagree', d: "The computers' fingerprints differ at the end of a run that went completely still, so they do not hold the same data and nothing else is coming to fix it — the one outcome the system promises never to leave you with. Red." },
  'differs':       { t: 'differs (in flight)', d: "The computers' fingerprints differ, but this is a live view or a run that stopped with things still moving, so a change may simply be on its way. Amber, not red: only a run that went completely still can prove a disagreement is final." },
  'split':         { t: 'split ✗ — no majority', d: "The computers disagree and no side has a strict majority — one against one, or two against two — so no fingerprint counts as the common one. Every computer is marked, because the situation is symmetric: none of them can be called the odd one out." },
  'clients-unjudged': { t: 'clients not judged', d: "A client only keeps the rows its server keeps. This client's server is not in the recording (or it had none at the end), so the page cannot tell which rows it should have: it is left out of everyone agrees, and its writes say not judged." },
  'no-nodes':      { t: 'no computer answered', d: "No computer gave a usable answer, so the page claims nothing — rather than showing a hollow green tick over an empty set." },
  'mid-flight':    { t: 'caught mid-action', d: "The computers disagree only because this recording was frozen the instant a rule broke, while a change was still being copied. Expected here, not a second problem." },
  'absent':        { t: 'computers that did not answer', d: "Attached computers the page asked but got no proper answer from on this refresh, each with a one-word reason. They are left out rather than guessed at." },
  'absent:refused':        { t: 'refused', d: "The line was dead, or hung up before a real answer came back. The page tries again on the next refresh." },
  'absent:timeout':        { t: 'timeout', d: "The computer did not pick up, or did not hand everything over, within the 1.2-second allowance, so this refresh skipped it. The page tries again on the next refresh." },
  'absent:unauthorized':   { t: 'wrong password', d: "The computer rejected the debug password. The page stops asking it until the debug server is restarted with the right one." },
  'absent:frame':          { t: 'unreadable reply', d: "The reply did not fit the message format: the bytes could not be read (that address may not be a fero computer, or it speaks another version), or the computer's answer was too big to send as one message." },
  'absent:vocab-mismatch': { t: 'a different event vocabulary', d: "This computer numbers its diary entries differently from the others, so its history cannot be shown on one page. It is set aside rather than mislabelled." },
  'absent:restarted':      { t: 'restarted mid-read', d: "Halfway through, the computer started answering as a fresh life of itself. The half-collected picture was thrown away rather than glued together." },
  'absent:error':          { t: 'could not answer', d: "The computer understood the question but replied that it cannot answer it — for example a question its older version does not know." },
  'replay-ok':     { t: 'replay ✓', d: "The page rebuilt each computer's data from scratch using only its diary and the record books, and landed on exactly what the computer holds. The recording is complete and the page's rules match the real ones." },
  'torn-read':     { t: 'torn read', d: "While the page was reading this computer, a change landed between two of its questions, so the stored data it got is a moment newer than the diary it got. A rebuild check would disagree for that reason alone, so it is skipped for this computer; the next snapshot usually reads clean." },
  'replay-truncated': { t: 'replay unchecked — diary lost pages', d: "Some computer's diary overflowed and lost its oldest lines, so its data cannot be rebuilt from the diary to check it. Not a fault: the check is skipped for that computer only, the others are still checked, and the number says how many lines were lost." },
  'replay-bad':    { t: 'replay ✗', d: "Rebuilding a computer's data from its diary and record books did not land on what it holds: the page's rules differ from the real ones, or — on an attached live cluster — the computer changed between the page's separate reads of it. Treat the rebuilt panes (writes, fields, rewinds) with care." },
  'violations':    { t: 'rules broken', d: "Rules the simulator checks after every step — like: two computers must never hold different member lists for the same version — that were found broken." },
  'events':        { t: 'things that happened', d: "One event is one thing the simulator did: a message arriving, a timer firing, a write handed in, a cable cut. This is the count when the recording was taken." },

  // ── tree groups and row types ──
  'g:nodes':      { t: 'Nodes', d: "The computers in this cluster, one row each. Every computer keeps its own copy of the data; open one to see its connections, its incoming streams and its diary." },
  'g:writes':     { t: 'Writes', d: "Every change anyone made, named author#ticket, newest first. Each row says which computers accepted it, set it aside, or never saw it." },
  'g:cells':      { t: 'Cells', d: "Every field any computer currently stores, listed once with the value that won and who wrote it. A field held by only one computer still appears here." },
  'g:violations': { t: 'Violations', d: "Rules the simulator checks after every step that were found broken. This group only appears when there is something in it." },
  'g:links':      { t: 'Links', d: "This computer's open lines to other computers — one per peer once the hello has settled (two can exist for a moment when both dial at once). When the page is attached to running computers, the debugger's own line shows here too, and never gets past hello." },
  'g:streams':    { t: 'Streams', d: "For each author whose changes this computer holds — other computers, and itself — how far along that author's numbered sequence it has got." },
  'node':         { t: 'a computer', d: "One computer in the cluster, known by its name tag. It holds its own copy of the data, stamps its own writes with its own counter, and keeps a diary of what happened to it." },
  'link':         { t: 'a connection', d: "One open line between this computer and a peer. Numbered by this computer — the peer numbers the same line differently." },
  'stream':       { t: 'an incoming stream', d: "One author's changes as held by this computer — the computer's own changes count too — tracked by three rising marks: looked at, written into the record book, saved to disk." },
  'write':        { t: 'a write', d: "One change, named author#ticket: the computer that stamped it and the ticket number it gave. The route shows what happened to it at every computer." },
  'cell':         { t: 'a field', d: "One stored value at one address (row · field). Two people changing different fields of the same row never collide; the same field is settled by a tie-break." },
  'violation':    { t: 'a broken rule', d: "A rule the simulator checks after every step, found broken. The message names the rule, the computer, and exactly what it saw." },
  'more':         { t: 'older writes hidden', d: "The tree paints only the newest 500 writes. The filter always searches all of them — type a name or a facet to reveal older ones." },
  'crumb':        { t: 'where you are', d: "The path to the selected row. Click a segment to jump up; cluster clears the selection." },
  'close':        { t: 'close the inspector', d: "Hide this pane (Esc does the same). Closing also drops the selection: the tree row is unhighlighted, the path returns to cluster, and the status bar shows the recording's headline numbers again." },
  'facts':        { t: 'the headline numbers', d: "The selected thing's key facts exactly as recorded — hover each label for what it means." },

  // ── per-computer facts ──
  'seq':          { t: 'seq — the ticket counter', d: "Each change this computer makes gets the next number, and the counter catches up to any bigger number it sees from others. So a change made after seeing another always carries a bigger number — that is how computers agree which one wins. Not a count of writes: gaps are normal." },
  'epoch':        { t: 'epoch — member-list version', d: "The version number of the cluster's member list. It goes up only when the group votes a computer in or out; every write is tagged with the version current at the time." },
  'keys':         { t: 'fields held', d: "How many separate fields this computer currently holds. Writing one field many times still counts once; a delete takes one away." },
  'jrnl':         { t: 'diary lines', d: "How many lines of this computer's event diary are kept. The diary has a fixed number of pages; +N says how many of the oldest were torn out to make room." },
  'links-stat':   { t: 'admitted / total', d: "Connections admitted as peers, out of all open ones. A line carries no data until its hello is done. The debugger's own read-only line (the observer, when the page is attached to running computers) is not a peer and is left out of both numbers." },
  'resource':     { t: 'resource', d: "The name of the shared object this computer keeps a copy of — the name a program opened, like 'shop'. Two computers only ever share data when they share this name." },
  'node:system':  { t: 'system resource', d: "A name starting with # is fero's own bookkeeping, not your data: #directory is the phone book that tells programs on this box where each name is served. Programs can never open a # name themselves." },
  'listen':       { t: 'address', d: "Where other computers can knock on this one's door. Computers that only visit and never host (clients) have none, which is fine." },
  'statehash':    { t: 'fingerprint', d: "One number summing up every field this computer holds. Two computers with the same number hold exactly the same data; the number alone means nothing, only equality does." },
  'journal':      { t: 'the diary', d: "This computer's own log of what happened to it, one numbered line per event: calls made, hellos, changes stamped or received, check-ins, votes. Newest first." },
  'by-kind':      { t: 'diary lines by kind', d: "How many diary lines of each kind this computer has — the quickest read of what it spent its time doing." },
  't':            { t: 't — diary line number', d: "The line number in this computer's diary, counting from its start — the same number the time-travel slider rewinds to. Not a clock, and unrelated to other computers' line numbers." },
  'node:converged': { t: 'on the same page', d: "This computer's fingerprint matches the cluster's most common one, so it holds the same data as the largest group — a strict majority; in an even split no side counts as common, and every computer is marked." },
  'node:diverged':  { t: 'diverged', d: "This computer holds different data from the others — its fingerprint is off the common one, or a row it keeps differs from another keeper's copy. Red because everything settled — the run went completely still — and that should never happen." },
  'node:differs':   { t: 'differs', d: "This computer disagrees with the others right now: its fingerprint is off the common one, or, when each row lives on a few computers, a row it keeps differs from another keeper's. On a live view that usually means a change has not reached it yet." },
  'node:truncated': { t: 'diary pages missing', d: "This computer's diary overflowed and its oldest lines were torn out. The data is intact — only the early history is gone — so rewinding is switched off." },

  // ── connections ──
  'link-id':       { t: 'line number', d: "This computer's own number for the connection. The peer numbers the same line differently, so match connections by peer name, not by number." },
  'side':          { t: 'who called', d: "Whether this computer placed the call (dialed) or picked up (accepted)." },
  'side:dialed':   { t: 'dialed — we called', d: "This computer placed the call. Both ends introduce themselves either way; the direction mostly decides which duplicate line to hang up if both called at once." },
  'side:accepted': { t: 'accepted — they called', d: "The peer placed the call and this computer picked up. Only hosts pick up, so this end is serving; the caller may be a client or another server — the direction alone does not say which." },
  'peer':          { t: 'the other end', d: "Which computer is on the other end of this line. Unidentified means it has not said its name yet — usually it just connected. The debugger's own read-only line says so instead: it is an observer, not a computer in the cluster." },
  'link-state':    { t: 'connection state', d: "pre-admit: the hello is not done, nothing flows. syncing: hello done, catching the peer up before live changes are sent. synced: live changes flow immediately. observer: the debugger's own read-only line, never a peer." },
  'queued':        { t: 'letters waiting', d: "Messages parked because the outgoing pipe to this peer is full. If the pile passes 256 it is dropped whole; the stored changes in it are re-sent later from the record book, so no change is lost for good." },
  'admitted':      { t: 'hello done', d: "The two computers finished introducing themselves on this line, so it may carry data. Not membership: an admitted peer may be a client, or not yet voted in." },
  'synced':        { t: 'caught up', d: "Before sending brand-new changes, this computer first learns what the peer already has and sends the backlog. Synced means that catch-up finished, so new changes now go straight through." },
  'paused':        { t: 'outgoing pipe full', d: "The peer is not reading fast enough, so messages for it are parked instead of sent. Incoming data still flows; the pile goes out in order once the pipe empties." },
  'link:pre-admit': { t: 'pre-admit', d: "The line is open but the hello handshake has not finished, so no data goes over it yet. Normal for a moment after connecting; a line that stays here never said its name." },
  'link:observer':  { t: 'observer', d: "The debugger's own line into this computer, opened with the debug password when the page is attached to running computers. It only reads: it is never admitted as a peer, carries no changes, and is left out of the admitted/total count. Also the filter value link:observer." },
  'link:syncing':   { t: 'syncing', d: "Hello is done, but this computer has not yet learned what the peer has and sent the backlog; live changes wait so nothing jumps the queue. Also set again after a waiting pile was dropped, and permanent on purpose for a client's spare lines — a client takes live changes from one server only." },
  'link:paused':    { t: 'paused', d: "This computer's outgoing pipe to the peer is full, so messages for it are parked. Not a cut, and not the peer being slow to take changes in — just a full pipe." },
  'link:closing':   { t: 'closing', d: "A line this computer refused and is closing: it lost a dial race (both sides dialled at once), it reached this computer itself, or the peer serves a different resource. It stays listed until the close comes back as a diary line — a moment later, not a fault." },
  'link:up':        { t: 'up', d: "The line is open, hello is done, and live changes flow. The debugger only labels problems, so up is the absence of one." },

  // ── streams: the watermark ladder ──
  'wm:applied':   { t: 'applied — looked at', d: "For this author, the highest ticket number this computer has dealt with — kept, or set aside because a newer change already beat it. Anything at or below it arriving again is normally old news; only a computer that stores just some of the rows may still accept an earlier one it had skipped." },
  'wm:shippable': { t: 'shippable — in the record book', d: "For this author, the highest ticket number written into this computer's copy of their record book — so it could hand it to a peer that missed it. When the system checks that a change has reached enough computers, it counts from this mark." },
  'wm:durable':   { t: 'durable — saved to disk', d: "For this author, the highest ticket number this computer has saved to disk in a way that survives a crash. Computers that keep no disk copy leave it at zero on purpose." },
  'log-records':  { t: 'record book entries', d: "How many of this author's changes this computer still keeps in its record book, including ones later overtaken. Once everyone has caught up past them, the overtaken ones are tidied away (the book has to grow large first); the entry holding each field's current value stays." },
  'origin':       { t: 'origin — the author', d: "The computer that stamped this change with its own name and ticket number. Every change has exactly one author." },

  // ── writes ──
  'rec-key':       { t: 'address', d: "Where the change lands: the row, then the field inside it, joined by ·. The row part also decides which computer is in charge of accepting changes to it." },
  'rec-value':     { t: 'the value written', d: "The actual thing stored at that address — a number, text, or an object. Each address is judged on its own: a write to a whole row and a write to one field of that row are settled separately, so which one shows through can depend on the order they arrived." },
  'not-captured':  { t: 'record not captured', d: "The diaries prove this write happened, but no computer's record book still holds what it changed — usually tidied away to save space. The page refuses to guess the payload." },
  'route:applied': { t: 'accepted by n of n', d: "How many computers accepted this write, out of how many there are. Fewer than all means some computer set it aside in a tie-break, saw only a duplicate, or never saw it — the tags beside it say which." },
  'route:lost':    { t: 'lost@ — set aside in a tie-break', d: "These computers already held a competing change for the same field that wins the tie-break, so they set this one aside. Nothing went wrong; everyone still ends up with the same value." },
  'route:never':   { t: '⊘ — never arrived', d: "These computers have no record of this write, and the simulated world has gone still — nothing more is coming. Truly lost. (A computer that keeps only some rows and was never meant to get this one is not listed here: it counts as not a holder.)" },
  'route:holders': { t: 'accepted by n of n holders', d: "How many of the computers meant to have this write took it in: the row's holders (plus the writer if it has since handed the row off). A computer never meant to get it — not a holder, a client whose server does not keep the row, or one that had left before the write — is left out of both numbers, and so is a client the page cannot judge." },
  'route:inflight': { t: '⊘ — not there yet', d: "These computers have no record of this write yet. On a running system that usually just means it is still on its way." },
  'route:dup':     { t: 'dup@ — only a duplicate seen', d: "The only trace on these computers is a discarded second copy: their bookkeeping said they were already past it, but the first delivery is not in the diary the page has. Usually trimmed history." },
  'route:summary': { t: "the write's fate in one line", d: "How many computers accepted it, then which ones set it aside in a tie-break (lost@) or have no record of it (⊘)." },
  'write:applied':       { t: 'applied everywhere', d: "Every computer accepted this write. It does not promise the value is still the latest — a newer write may have replaced it since." },
  'write:lww-lost':      { t: 'lww-lost', d: "On at least one computer this write lost a tie-break: that computer already held a competing change to the same field that counts as newer. Expected when two people edit one field at once." },
  'write:never-arrived': { t: 'never-arrived', d: "Some computer that should hold this write has no record of it, and the simulated world has gone still, so nothing more is coming — it is lost. Red because that should never happen." },
  'write:in-flight':     { t: 'in-flight', d: "Some computer has no record of this write yet. The system is still running, so it may simply not have got there." },
  'write:duplicate':     { t: 'duplicate', d: "Some computer's only trace of this write is a discarded second copy — it was already past that point, but the first delivery is not in the diary the page has." },
  'change-record': { t: 'the change record', d: "The change exactly as it travelled: its kind, the address, the value, and the stamp it got — ticket number, member-list version, author, and the row it belongs to." },
  'rec:update':    { t: 'update — set a value', d: "Set the value at this address, replacing whatever was there." },
  'rec:insert':    { t: 'insert — add a new item', d: "Add a brand-new item. When it is added without a name, the system invents one so every computer files it under the same name." },
  'rec:remove':    { t: 'remove — delete', d: "Delete the value at this address. A small marker of the deletion is kept for a while so an older, late-arriving change cannot bring the value back." },
  'rec-seq':       { t: 'ticket number', d: "seq is the change's ticket number: the next number from its author's counter, which also catches up to any bigger number it sees from other computers. Within one member-list version a bigger number is newer and wins a tie; two equal numbers fall back to the authors' names." },
  'rec-epoch':     { t: 'member-list version', d: "The version of the member list current when the change was stamped. In a tie-break a change from a later version beats any change from an earlier one." },
  'partition':     { t: 'the row — and who is in charge', d: "The top-level row this change belongs to. Once a member list exists, one computer per row — picked from the row's name and that list — stamps every change to it; before that, each computer stamps its own. Changes to the same field can still collide, and the tie-break settles those." },
  'route':         { t: 'the route', d: "What happened to this write at every computer, in arrival order: born here, accepted, came in a hand-off, lost a tie-break, a duplicate discarded, or never arrived." },
  'stop:origin':    { t: 'origin — born here', d: "This is the computer that stamped the write with its name and ticket number and sent it out." },
  'stop:applied':   { t: 'applied — accepted', d: "This computer received the write and took it in. A newer write may have replaced the value since." },
  'stop:acquired':  { t: 'got it in a hand-off', d: "When the list of computers changed, this computer became one of the row's holders and copied the row's whole history from an old holder in one go. That copy brought this write with it, so the write never arrived on its own." },
  'stop:lww-lost':  { t: 'lost the tie-break', d: "LWW — last writer wins — is the tie-break's name. This computer already held a competing change to the same field that counts as newer, so it kept that one and set this write aside, while still recording it in its history." },
  'stop:duplicate': { t: 'duplicate discarded', d: "This computer got a second copy and ignored it, because its bookkeeping said it was already past that point. The first copy's arrival is not in the diary the page has." },
  'stop:not-a-holder': { t: 'not a holder', d: "Each row is kept by a few chosen computers, its holders, and this one was not meant to get this write (as of the end of the recording): not a holder of the row; a client whose server does not keep it; or a computer that had left before the write was made, or never kept the row while it was in." },
  'stop:feeder-unknown': { t: 'not judged', d: "This client gets only the rows its server keeps, and that server is not in the recording (or the client had none at the end). So the page cannot tell whether this write was meant for it, and claims neither way." },
  'stop:inflight':  { t: 'not there yet', d: "This computer has no record of the write yet. The system is running, so it may still be on its way." },
  'stop:never':     { t: 'never arrived', d: "This computer has no record of the write, and the recording is a finished simulation, not a live feed. If the header says quiesced, nothing more was coming. If it says not quiesced or mid-flight, the run was cut off and the write may just not have got here before the cut." },
  'stop:not-yet':   { t: 'not yet, at this step', d: "At the rewind point this computer had not seen the write. Drag forward: if the write ever got here, this stop changes at that step; if it never did, it stays like this all the way to the end." },

  // ── fields ──
  'cell-value':   { t: 'the current value', d: "The value that ended up in this field after any tie-break, as held by the first computer that has it. The coloured tag beside the row says whether other computers disagree." },
  'cell-winner':  { t: 'who wrote the winning value', d: "The change that stuck, as author#ticket, read from one reference computer's replay. The tie-break rule is the same everywhere, so computers agree once they have all seen the same changes — a diverged or differs pill means some have not yet." },
  'candidates':   { t: 'candidates', d: "For a field where a tie-break happened, how many changes to it some computer's record book still holds — plain earlier edits included. A field with no tie-break always shows 1, however many times it was edited." },
  'stamp':        { t: 'epoch·seq — the winning stamp', d: "The stamp the winning change carries: member-list version first, then ticket number. Ties are settled by comparing these in that order, then by the author's name." },
  'election':     { t: 'the tie-break', d: "Every change made to this field, newest first, with the one that stuck marked won. Losers stay in history; the field's value is the winner's." },
  'won':          { t: 'won', d: "This change carries the newest stamp of every change to this field found in any record book, so its value is the one every computer ends up with once it has seen it." },
  'lost':         { t: 'lost', d: "An older stamp than the winner's — superseded, whether it collided or was simply written earlier." },
  'per-node':     { t: 'value per computer', d: "What each computer holds for this field, shown only when they disagree. Red rows differ from the first computer that has the field." },
  'absent-cell':  { t: '∅ — not held here', d: "This computer has no such field right now while others do. A change may not have reached it yet, a deletion may have reached it before the others, or it is not one of the computers that store that row." },
  'cell:contested': { t: 'contested', d: "Two writers changed this field without seeing each other's edit, and some computer had to set one aside using the tie-break — it stays in the record book, only its value is unused. Editing a field several times in a row is not contested: each edit knew about the last." },
  'cell:diverged':  { t: 'diverged', d: "Computers hold different values for this field at the end of a simulation that went completely still. Nothing else is coming to settle it, so that should never happen — hence red." },
  'cell:differs':   { t: 'differs', d: "Computers hold different values for this field on a live view, or a run that stopped with things still moving. A change is probably still being copied around; the next snapshot usually settles it. Also the filter value cell:differs." },
  'cell:differs@t': { t: 'differs at this step', d: "At this point in the rewind the computers hold different values for this field — normal while a change is still being copied around. Drag to the end to see them settle." },
  'cell:settled':   { t: 'settled', d: "Every computer has the same value and no tie-break was found. The debugger only labels problems, so settled is the absence of one. While rewinding, the tie-break check is switched off, so settled there only means the computers agree at that step." },

  // ── the diary vocabulary: one entry per journal kind ──
  'jk:dial':         { t: 'dial', d: "This computer is calling another one at that address. Whether the call connects shows up later as link up, or link down · refused." },
  'jk:linkUp':       { t: 'linkUp', d: "A line to another computer just got connected — dialed means we called, accepted means they did. Who is on it is not known yet; the first thing sent is a hello." },
  'jk:identified':   { t: 'identified', d: "The other side said its name and which life it is on — the inc number: a restarted computer starts a new life, 1, 2, 3… From here the line is trusted to carry data." },
  'jk:dupLink':      { t: 'dupLink', d: "Two computers called each other at the same time and ended up with two lines. Both hang up the same one, using a rule they both know, keeping exactly one." },
  'jk:selfReject':   { t: 'selfReject', d: "We called a number and the voice on the other end was our own — usually our own address listed under another spelling. We hang up and never try that number again." },
  'jk:linkDown':     { t: 'linkDown', d: "The line to another computer went dead: they hung up, the network broke, or we hung up on purpose. The word after it says why, or just close when that is all we know." },
  'jk:frameDrop':    { t: 'frameDrop', d: "A message came in that we could not read, or was not allowed yet, so we threw it away. Broken bytes, or anything sent before the hello, also hang up the line; an unknown or oddly shaped message costs only that message. Link -1 means a corrupt entry among the changes this computer had saved to disk, found at start-up." },
  'jk:writeLocal':   { t: 'writeLocal', d: "This computer stamped one change with its next ticket number and filed it in its own record book. The second value is the row the change belongs to." },
  'jk:applyInbound': { t: 'applyInbound', d: "A change that was new to us arrived — from another computer, or read back from our own diary when this computer restarted — and was folded into our copy. It may still lose a tie-break; that shows as a separate lwwSkip line." },
  'jk:holdBack':     { t: 'holdBack (retired)', d: "A leftover label from an early design that held on to out-of-order messages. Nothing does that any more, so this never appears." },
  'jk:dropOldest':   { t: 'dropOldest', d: "A slow connection's waiting pile got too big, so the whole pile was thrown away. Once it catches up, the other side says what it has and we resend what it missed from our record book." },
  'jk:pause':        { t: 'pause', d: "The other computer is not reading fast enough, so our outgoing pipe to it is full. Messages for it are parked instead of sent." },
  'jk:drain':        { t: 'drain', d: "The full pipe emptied out, so we send what was parked — and if anything was thrown away meanwhile, we start a check to resend what they missed." },
  'jk:ping':         { t: 'ping', d: "Every heartbeat, the computer with the smaller name asks each peer: you there? It is also the moment the two swap notes on what each has, in case anything was missed." },
  'jk:redial':       { t: 'redial', d: "The connection to that address failed, so an alarm was set to try again after a short wait — and the wait grows each time it fails." },
  'jk:dupDrop':      { t: 'dupDrop', d: "A change arrived that we had already dealt with — its number was no higher than the last one taken from that author — so it was ignored. Harmless: two paths delivered the same thing." },
  'jk:start':        { t: 'start', d: "This computer switched on and began reaching out to the computers it was told about." },
  'jk:giveUp':       { t: 'giveUp', d: "That address got a first call and then a run of retries with growing waits and never answered, so we stop for now: five retries for a member that was up a moment ago (its silence is what starts the vote to drop it), otherwise `redial.tries`, ten by default. With heartbeats on, we try again from scratch later." },
  'jk:lwwSkip':      { t: 'lwwSkip', d: "Two changes to the same field raced and this one counted as older by the tie-break (LWW: last writer wins), so the other value was kept and this one set aside. Every computer picks the same winner." },
  'jk:subsumed':     { t: 'subsumed', d: "A change to one field of a row lost to a change of the whole row (or its deletion) that counts as newer by the same tie-break. The row change already carries or erases that field, so the older field change is set aside: refused on arrival, or taken out again when the row change came later. Every computer shows the same row." },
  'jk:catchup':      { t: 'catchup (retired)', d: "A leftover label from when a newly connected computer got the entire history dumped on it. Now only what it is actually missing is sent, so this never appears." },
  'jk:digestOut':    { t: 'digestOut', d: "We sent the other computer a short list: for each author, the highest ticket number we have. Reply requested means we also asked for their list back." },
  'jk:digestIn':     { t: 'digestIn', d: "We received the other computer's list of what it has. Normally we send anything it is missing and from then on pass new changes to it as they happen — except when our pipe to it is full (the exchange is redone after it drains), or we are a client and this is not our chosen server (we answer nothing)." },
  'jk:aeShip':       { t: 'aeShip', d: "Comparing lists showed the other computer was missing some changes, so we resent just those from our record book. This is how copies heal after a disconnect." },
  'jk:revive':       { t: 'revive', d: "On a heartbeat we noticed an address we had given up on, with no line to it, and called it again from scratch. Giving up was only a rest." },
  'jk:suspect':      { t: 'suspect', d: "We have had no working line to a member for three heartbeats in a row — it is the missing line that counts, not silence on a live one — so we privately mark it maybe gone. Nothing is decided: a suspicion, not a removal." },
  'jk:propose':      { t: 'propose', d: "This computer is asking the group to approve a new member list — the two numbers are its version and how many members it has. Normally only the lowest-named member it believes alive asks; if two do ask, the one-yes-per-version rule (see vote) keeps two lists from both winning." },
  'jk:vote':         { t: 'vote', d: "Another computer asked us to approve a new member list; this records our answer: the list's version, 1 yes or 0 no, and who asked. A yes for a version goes to one asker only (the same asker asking again gets the same yes). A list without its own asker is a clean leave: a leave line names the asker just before." },
  'jk:viewInstall':  { t: 'viewInstall', d: "This computer adopted a new official member list — the two numbers are its version and how many members it has. From now on it uses that list to decide who is in charge of which rows and whether it may accept writes." },
  'jk:epochStale':   { t: 'epochStale', d: "We saw proof that the cluster moved on to a newer member list than ours. New writes wait in line while we ask for the newer list — first the computer that showed us the proof, then every neighbour on each heartbeat, up to five times." },
  'jk:gateClose':    { t: 'gateClose', d: "This computer switched itself to read-only; the reason says why: its member list is out of date, it is still rebooting, it was voted out, it is new and waiting to be voted in (joining), it said yes to a far-off member list that may now exist (held), or it plus the members it can reach are not a majority. Only new writes wait." },
  'jk:gateOpen':     { t: 'gateOpen', d: "This computer accepts writes again, and the writes that were waiting are sent now — after re-checking who is in charge of each, since the member list may have changed." },
  'jk:gateAlarm':    { t: 'gateAlarm', d: "We asked five times for the newer member list we know exists and nobody answered, so rather than staying frozen we carry on with the old one. An alarm: writes flow again, on possibly stale information." },
  'jk:writeBuffered':   { t: 'writeBuffered', d: "A write could not be sent right now — this computer is read-only, or the computer in charge of that row is unreachable — so it is held back for later. The number is how many of this computer's writes are still unfinished: the held-back ones plus any already sent and awaiting a receipt." },
  'jk:writeBufferDrop': { t: 'writeBufferDrop', d: "More than 1024 writes were unfinished here, so the oldest was thrown away; the number is the running total dropped. A program on this computer is told (its write fails and the value bounces back); a client's write dropped here at its server is not — the client's retry clock re-sends it." },
  'jk:join':         { t: 'join', d: "A computer that is not on the member list — voted out, or newly arrived and just handed the list — is knocking to be let in. Seen at the knocker, at whoever hears the knock, and at any member that passes it along; being let in still needs a vote." },
  'jk:evict':        { t: 'evict', d: "The new member list this computer adopted no longer includes that computer — voted out for not answering heartbeats, or it asked to leave (a clean stop). It can still receive updates; it just cannot write until voted back in." },
  'jk:leave':        { t: 'leave', d: "A computer that is stopping on purpose asks for a member list without itself, while it can still vote — so it passes by a normal vote instead of waiting to be declared dead. Seen at the leaver (its own name) and at every member it asked to run or join that vote; the lowest-numbered live member runs it." },
  'jk:left':         { t: 'left', d: "The clean stop is over. 1: the list without it was adopted, a stayer confirmed it, rows only it held were copied first. 0: it leaves anyway — 'unanswered': the vote never came back (slices it cannot prove are held elsewhere count); 'unechoed': its own list drops it, no stayer confirmed; or, after an undrained row, rows were not copied." },
  'jk:undrained':    { t: 'undrained', d: "A computer stopping on purpose, whose rows live on only a few computers, waited for the new keepers to prove they have its rows — and gave up on this many slices: the wait ran out, or nobody was left to hand them to. Those rows go with it unless its own disk brings them back. The left row after it says 0." },
  'jk:release':      { t: 'release', d: "This computer had said yes to a member list that never got adopted, and was read-only in case it had (held). The computer that asked for that list now says the proposal is gone — the numbers are the list's version and who asked — so the yes no longer holds it back. The yes stays spent for that version: nobody wins it twice." },
  'jk:writeForward': { t: 'writeForward', d: "A batch of writes was mailed away instead of applied here: a member sends each to the computer in charge of its row; a client sends everything to its one connected server, which sorts out ownership. Either way it now waits for a receipt. One computer per row is what stops writes colliding." },
  'jk:writeAck':     { t: 'writeAck', d: "Our write is confirmed with its final stamp — ticket number and member-list version — either by a receipt from the computer in charge (passed on by the server, for a client), or because the finished change came back through normal copying carrying our ticket. It is no longer held back." },
  'jk:writeNack':    { t: 'writeNack', d: "A forwarded write was refused. Three reasons mean 'try again': the two disagree on the member-list version (stale-epoch), the recipient is not in charge of that row (not-owner), or it cannot take writes now (withheld). One is final: invalid — the server's write rule refused a client's write; the client gives up and shows the reason." },
  'jk:writeDup':     { t: 'writeDup', d: "The computer in charge received the same write twice — usually because the first receipt got lost — and recognised its ticket number, so it did not apply it again; it re-sent the original receipt." },
  'jk:writeRelay':   { t: 'writeRelay', d: "A client (a computer not on the member list) handed this server a write; the server adopts it and works out who is in charge of the row — forwarding it on the client's behalf, or applying it itself if this server is the one in charge." },
  'jk:dedupEvict':   { t: 'dedupEvict', d: "This computer remembers each writer's recent ticket numbers to spot repeats, for up to 1024 writers. It just forgot the oldest writer's to make room, so a repeat from them would be applied again with a fresh stamp — usually harmless, but it can put an old value back over one written meanwhile." },
  'jk:persist':      { t: 'persist', d: "The computer handed a bundle of changes to the disk-writer and asked it to save them. Not saved yet — that is what the later persisted line confirms." },
  'jk:persisted':    { t: 'persisted', d: "The disk-writer reported the bundle is really on disk and survives a power cut. Only now are those changes counted as saved." },
  'jk:persistFail':  { t: 'persistFail', d: "The disk-writer could not save a bundle. From now on this computer stops trusting its disk for new changes — it keeps working with the others, it just will not promise anything is saved locally." },
  'jk:replayed':     { t: 'replayed', d: "At startup the computer re-read the changes it had saved to disk — its own and other writers' — and re-applied them, one saved bundle at a time. The number is how many changes from that bundle were folded back in (already-known duplicates are not counted); the writer shown is the bundle's." },
  'jk:bootWrite':    { t: 'bootWrite', d: "The computer rewrote its small on-disk note: who it is, which group it belongs to, and a ticket number safely above any it has handed out, so it never reuses one after a restart. Written at important moments, not per change." },
  'jk:walHole':      { t: 'walHole', d: "While re-reading saved changes, a bundle in the middle was missing: the disk claimed to have saved it and then lost it. That is proof the disk cannot be trusted." },
  'jk:confirmReq':   { t: 'confirmReq', d: "Someone asked: can you prove this change has reached enough computers, or enough disks? A request was opened that waits for that proof." },
  'jk:confirmed':    { t: 'confirmed', d: "The proof request got its answer: 1 means enough computers proved they have the change; 0 means it gave up first — the deadline ran out, or too many requests were open and the oldest was let go. The count is how many computers had proved it. A no does not undo the change." },
  'jk:compacted':    { t: 'compacted', d: "Old superseded versions of changes that every other computer has provably received were thrown away, keeping only the current winner of each field." },
  'jk:tombstoneGC':  { t: 'tombstoneGC', d: "Deletions leave small deleted-at markers so an older late change cannot bring the value back. Once everyone has fully caught up, those markers are safe to drop." },
  'jk:snapshot':     { t: 'snapshot', d: "Instead of letting the on-disk change file grow forever, the computer built a fresh compact copy of everything it holds and asked the disk-writer to swap it in all at once. Not swapped yet — the later persisted line with this bundle number confirms it. Unrelated to the snapshots the live view takes." },
  'jk:walTaint':     { t: 'walTaint', d: "The computer caught its disk lying about what was saved, so it stops trusting anything on it: wipes its in-memory copy, blanks the file, and rebuilds itself from the other computers. Its identity and membership are kept." },
  'jk:rpcIn':        { t: 'rpcIn', d: "Another computer (usually a client) asked this one to run a named function, or to start or stop a live feed of results. The function is the application's own code, not part of the copying machinery." },
  'jk:rpcAnswer':    { t: 'rpcAnswer', d: "The function we asked another computer to run has replied — 1 if it succeeded, 0 if it returned an error." },
  'jk:rpcOut':       { t: 'rpcOut', d: "This computer sent another one a request to run a function, or to open or close a live feed. Only that it left is recorded, not that it arrived." },
  'jk:rpcFail':      { t: 'rpcFail', d: "We wanted to send a function request but had no connection to send it on, so it failed at once. The program that asked may quietly retry once a line comes back." },
  'jk:shed':         { t: 'shed', d: "This computer used to keep a slice of the data but is no longer one of its assigned keepers; once every current keeper proved it has everything, it deleted its copy to free memory." },
  'jk:acquire':      { t: 'acquire', d: "This computer finished copying a data slice from its one chosen teacher and folded it in all at once, so there was never a half-copied state. It serves that slice from here; a disk-backed computer only vouches for it to others once the copy has also reached its disk." },
  'jk:orphaned':     { t: 'orphaned', d: "This computer holds a slice it may no longer serve: the keepers were reassigned away from it, or a cancelled copy left partial data behind. It freezes the slice — if it is still a keeper it re-copies from a teacher; otherwise it holds it only until the new keepers prove they have everything." },
  'jk:acquireStart': { t: 'acquireStart', d: "This computer needs a fresh copy of a slice it is supposed to keep — part is missing, or the slice is frozen from an earlier reassignment — so it picked exactly one teacher and holds incoming changes for that slice to one side until the copy lands." },
  'jk:acquireAbort': { t: 'acquireAbort', d: "The copy-from-teacher attempt was cancelled: the teacher disconnected, the group changed, the copy looked torn, too much piled up, or it took too long. Nothing was half-applied; it asks again later." },
  'jk:teachShip':    { t: 'teachShip', d: "This computer acted as teacher: it sent another computer the part of a slice it was missing, then a marker saying that is everything up to here." },
  'jk:gateDrop':     { t: 'gateDrop', d: "A change arrived for a slice this computer is not supposed to keep — usually the sender was working from a slightly older assignment — so it was ignored. The real keepers get it directly." },
  'jk:stageDrop':    { t: 'stageDrop', d: "Copy-data for a slice arrived from someone other than the one teacher this computer is copying from — a second teacher, or stragglers from an abandoned copy — and was thrown away: mixing two teachers' copies could bring back deleted data." },
  'jk:shedStall':    { t: 'shedStall', d: "This computer has been waiting a long time to delete a frozen slice because some keeper still has not proven it has everything. A still-waiting alarm that repeats less and less often." },
  'jk:diagAuth':     { t: 'diagAuth', d: "A debugging tool connected with a valid password, so the computer opened a read-only inspection window for it. The tool is a spectator, never a member." },
  'jk:diagDeny':     { t: 'diagDeny', d: "A debugging tool tried to open an inspection window and was refused: no debug passwords configured, a malformed request, or a wrong password. The tool is only told denied." },
  'jk:diagPull':     { t: 'diagPull', d: "A connected debugging tool read a chunk of this computer's data — its summary, part of a record book, or its current state. Reads of the diary itself are deliberately not recorded." },
  'jk:nameReject':   { t: 'nameReject', d: "Another computer connected but said it shares a different named dataset, so this one refused to link with it — otherwise two unrelated datasets would silently merge." },
  'jk:contractReject': { t: 'contractReject', d: "Two servers compared their settings when they met and one differed — the heartbeat, the replica count, whether methods guard the data, the validation rule, or the hash. They refused to link and the row names the setting and the other side's value. Fix the setting on one of them and they link at the next heartbeat." },
  'jk:doorReject':   { t: 'doorReject', d: "A computer knocked and was turned away at the door. The row says which line closed and why: it had no secret, or only it had one, its proof was wrong, it never proved in time, it turned our proof away, it answered from the wrong address, or a client used a member's name (the member keeps its line). Never the secret itself." },
  'jk:resync':       { t: 'resync', d: "A client (a computer not on the member list) noticed it holds changes its server no longer has — the cluster lost them, or the client moved to a server that is behind. A client never teaches a server, so it starts over: it forgets its copy and asks the server for everything." },
  'jk:resynced':     { t: 'resynced', d: "The client's fresh download finished (the server's answer arrives after the data, in order). Anything the client held before that did not come back is removed from its screen, except rows of a slice the server is still copying in: those stay until that copy lands and is checked. The second number is how many stayed." },
  'jk:refeed':       { t: 'refeed', d: "A client hung up on the server it was following on purpose: that server said it cannot take writes right now (it is on the small side of a split, or waiting on a vote), and another server the client is also connected to said it can. The client switches to that one — the numbers are the two lines — and reconnects to the first as a spare." },
  'jk:unfed':        { t: 'unfed', d: "The server a client follows said that one slice of the data left it (another server took the slice over, and this one let its copy go). The client drops that slice too — its rows leave the screen and its records leave the record book — so it keeps showing exactly what its server holds. The second number is how many records left." },
  'jk:fed':          { t: 'fed', d: "The server a client follows copied one slice of the data in from another server and sent the client that slice's history as one bundle. The client applied the bundle in one go, so no row the bundle also removes was ever shown. The numbers: messages in the bundle, and rows kept on the screen since the last fresh download that left it now." },

  // ── the dashboard ──
  'tally':         { t: 'passing / total', d: "How many scenarios passed their own checks, out of how many ran. Every scenario is a scripted run of the simulator with a verdict." },
  'rev':           { t: 'code revision', d: "The git commit the code was at when this run happened (not the baseline's)." },
  'when':          { t: 'when it ran', d: "How long ago this run finished. It does not tick — a re-run refreshes it." },
  'wall-run':      { t: 'whole-run wall-clock', d: "Real time the whole suite took on this machine. Noisy here — the counted metrics are the signal." },
  'rerun':         { t: 're-run everything', d: "Run every scenario again right now — about two real seconds, since every cluster runs on a simulated clock — and repaint the cards." },
  'no-baseline':   { t: 'no baseline yet', d: "There is no saved answer key to compare against, so no before → after changes can be shown. Only the command-line run (npm run scenarios) saves one; this page never does." },
  'debugger-link': { t: 'the debugger', d: "Open the capture explorer on whatever the server was started with — a capture file, a live cluster, or an attached one. Started with none of those, it opens empty and asks for a capture file; open a card instead." },
  'open-debugger': { t: 'open in the debugger', d: "Click anywhere on the card to open a full recording: every computer, write, field and diary line. The seed sweep opens one seed (the first failure, else the last); the wire card opens a small clean stand-in run, not the pin check itself." },
  'fail-note':     { t: 'why it failed', d: "The first check that did not hold, in the scenario's own words — a broken rule, or an end check like converged or drained." },
  'pass':          { t: 'pass', d: "Every rule the scenario checks came out true at the end." },
  'fail':          { t: 'fail', d: "At least one check did not hold. The note below names the first one." },
  'kind:happy':    { t: 'happy path', d: "Nothing goes wrong on purpose: the scenario shows the system doing its normal job — like testing a car on a smooth road." },
  'kind:unhappy':  { t: 'fault path', d: "The scenario breaks something on purpose — duplicates messages, cuts a cable, fills a pipe, crashes every computer — and checks the system still ends up correct. Expected to pass." },
  'kind:meta':     { t: 'meta', d: "Not one cluster story but a measurement of the machinery itself: a pinned wire size, or a whole sweep of many seeded runs." },
  'd:node':        { t: 'a computer', d: "One computer in the scenario's cluster. Big scenarios draw only a few as a sketch." },
  'd:writer':      { t: 'a writer', d: "A computer that makes changes during this scenario — the gold rim and dot mark it. Gold is the brand accent, not a status." },
  'd:fault':       { t: '≋ — a faulty link', d: "Messages on this connection are slowed by random amounts and sometimes delivered twice, so arrivals reorder across links — on purpose. Nothing is ever lost on it." },
  'd:cut':         { t: '✂ — a cut link', d: "This connection is cut for part of the run — the cable between two computers is unplugged, so nothing gets through until it is plugged back in, which nearly every scenario does later." },
  'psev:ok':       { t: 'a healthy step', d: "Green: this step is the good outcome — everyone got connected, everyone holds the same data, the cut healed." },
  'psev:warn':     { t: 'a messy step', d: "Amber: something messy is being sorted out here — duplicates, a full pipe, a tie-break, an eviction ballot. Expected, not an error." },
  'psev:crit':     { t: 'a breaking step', d: "Red: this is where the scenario breaks something on purpose — a cut, a crash, a pile thrown away. It appears on passing cards too." },
  'psev:info':     { t: 'an ordinary step', d: "Blue: a plain step of the protocol — dialing, hellos, copying, encoding. Nothing good or bad about it." },
  'psev:gold':     { t: "the card's key step", d: "Gold marks the step this card is really about — most often the moment new data is written, sometimes another headline move like the one proposal, the revived call or the checksum. It is the page's brand colour, never a status." },

  // ── the phase strip (labels normalised: a trailing ×N is size, not meaning) ──
  'p:dial':            { t: 'dial', d: "Every computer calls every other one — deliberately redundant." },
  'p:hello':           { t: 'HELLO', d: "Each connection opens with both sides saying who they are. Nothing else is sent until this is done." },
  'p:dedup':           { t: 'dedup', d: "Two computers that called each other at once hang up the same duplicate line, keeping exactly one per pair." },
  'p:digest':          { t: 'digest', d: "Right after hello, each pair swaps a short list of what it has so any gap gets filled and the line counts as caught up." },
  'p:formed':          { t: 'formed', d: "Every pair holds exactly one connection and knows who is who: the mesh is complete." },
  'p:form':            { t: 'form', d: "Get every computer connected to every other one — a full mesh — before the scenario's real work starts." },
  'p:write routed':    { t: 'write routed', d: "Every row is given to one designated writer, so writes go to that computer and never collide." },
  'p:replicate':       { t: 'replicate', d: "Copies of each new change are sent to the other computers." },
  'p:converge':        { t: 'converge', d: "At the end every computer holds exactly the same data." },
  'p:write':           { t: 'write', d: "New changes are written into the system." },
  'p:mesh at n01':     { t: 'mesh at n01', d: "The lowest-named computer waits until it is connected to everyone — that is the trigger for the first member-list vote." },
  'p:propose':         { t: 'propose', d: "One computer asks the group to approve the first member list." },
  'p:vote':            { t: 'vote', d: "The other members answer the proposal — yes at most once per version." },
  'p:view 1':          { t: 'view 1', d: "View 1 is the first official member list, adopted here by every member. A view is one numbered version of the member list." },
  'p:arm':             { t: 'arm', d: "The first member list is adopted, and with it every row's holders: the few computers chosen to keep it. From here a write goes to its row's holders only." },
  'p:holders only':    { t: 'holders only', d: "Each write is copied to the computers that hold its row and to no one else. The rest never see it, and the debugger marks them not a holder rather than lost." },
  'p:join + hand-off': { t: 'join + hand-off', d: "A new computer joins, and the new member list makes it a holder of some rows. For each one it copies the row's whole history from an old holder in one go, and the old holder that is no longer needed drops its copy." },
  'p:holders agree':   { t: 'holders agree', d: "Every holder of a row ends up with exactly the same values for it. Computers that do not hold the row are not compared." },
  'p:3× same key':     { t: '3× same key', d: "Three computers write the same fields at the exact same instant — a genuine race." },
  'p:lww election':    { t: 'LWW election', d: "LWW is last writer wins — the tie-break. Each computer settles the race by the same fixed rule: newer member-list version, then higher ticket number, then author name." },
  'p:same winner':     { t: 'same winner', d: "Every computer picked the same winner for each field without talking to each other." },
  'p:dial + write':    { t: 'dial + write', d: "Writes start before the computers have even finished saying hello — the risky window." },
  'p:dup race':        { t: 'dup race', d: "Doubled-up, delayed messages arrive while duplicate lines are still being sorted out." },
  'p:digest sync':     { t: 'digest sync', d: "The hello-time list swap fills in whatever was written before a connection was ready." },
  'p:dup + delay':     { t: 'dup + delay', d: "Every connection delays and duplicates messages by its own random amounts, so messages arrive in a different order on different connections." },
  'p:cut':             { t: 'cut', d: "The cable between two computers is unplugged, so nothing gets through in either direction until it is plugged back in." },
  'p:heal + digest':   { t: 'heal + digest', d: "The cable comes back, the redial reconnects, and the list swap re-sends exactly what each side missed." },
  'p:cut mid-dial':    { t: 'cut mid-dial', d: "The cut lands while a call is still ringing — it must leave no half-open line behind." },
  'p:backoff':         { t: 'backoff', d: "Failed calls are retried after a wait that doubles each time up to a ceiling (with a little random jitter) — ten retries after the first call (`redial.tries`), five when the line was to a member that was up a moment ago, then the computer gives up for now." },
  'p:heal':            { t: 'heal', d: "The cable is plugged back in. Nothing reconnects until the next redial fires." },
  'p:give up':         { t: 'give up', d: "After the first call and the failed retries (ten, or five for a member that was just up) the computer stops trying — for now." },
  'p:revive':          { t: 'revive', d: "While a number is given up, every heartbeat re-dials it with a fresh round of retries — so once the cable is back, one of those calls finally connects." },
  'p:pause':           { t: 'pause', d: "A connection's outgoing pipe is marked full, so the messages (frames) for it pile up instead of going out." },
  'p:shed':            { t: 'shed', d: "The pile overflows and the entire pile is thrown away at once — a visible loss the record book can heal." },
  'p:drain + digest':  { t: 'drain + digest', d: "The pipe unclogs, the list swap happens, and everything that was thrown away is re-sent." },
  'p:burst':           { t: 'burst', d: "A burst of writes lands while pipes are full." },
  'p:drain + converge': { t: 'drain + converge', d: "Every frozen pipe unclogs at once, each thrown-away pile is re-sent from the record book, and everyone matches." },
  'p:evict ballot':    { t: 'evict ballot', d: "The reachable majority votes the unreachable computer off the member list." },
  'p:cp buffer':       { t: 'CP buffer', d: "CP means choosing to stay correct over staying available: the cut-off computer goes read-only and keeps its write in its pocket rather than risk disagreeing with the others." },
  'p:rejoin + flush':  { t: 'rejoin + flush', d: "Reconnected, the outcast learns it was voted out, asks back in, gets voted in, and finally sends its pocketed write." },
  'p:2-2 cut':         { t: '2-2 cut', d: "Four computers split into two pairs that cannot hear each other — neither pair is a majority." },
  'p:both gate':       { t: 'both gate', d: "Both halves close their write gate — go read-only — and hold their writes rather than diverge." },
  'p:heal + flush':    { t: 'heal + flush', d: "Everything reconnects and both held writes go through." },
  'p:one view':        { t: 'one view', d: "There was never a second version of the member list — no split-brain." },
  'p:write anywhere':  { t: 'write anywhere', d: "Writes are handed to any computer; the system itself forwards each to the one in charge of its row." },
  'p:forward → owner': { t: 'forward → owner', d: "The computer that received the write hands it to the one in charge of that row." },
  'p:stamp + ack':     { t: 'stamp + ACK', d: "The computer in charge stamps and files the write, then sends back a receipt." },
  'p:forward':         { t: 'forward', d: "The write is sent to the computer set up to be in charge of it." },
  'p:commit':          { t: 'commit', d: "The computer in charge files the write exactly once." },
  'p:ack dies':        { t: 'ACK dies', d: "The receipt is lost when the line drops at that exact moment." },
  'p:retry → dedup':   { t: 'retry → dedup', d: "The sender would ask again, but never has to here: when the line comes back, the list swap re-sends the filed record, ticket attached, and that stands in for the lost receipt. A real repeat would be recognised by its ticket number and answered: already filed." },
  'p:once':            { t: 'once', d: "The write exists exactly once everywhere, even though its receipt was lost." },
  'p:cut → park':      { t: 'cut → park', d: "The isolated computer parks a write for a row it is not in charge of — pockets it, to send once reconnected." },
  'p:owner writes':    { t: 'owner writes', d: "Meanwhile the computer in charge of that row writes its own version." },
  'p:flush → forward': { t: 'flush → forward', d: "Once reconnected, the pocketed write is sent to the computer in charge rather than filed locally." },
  'p:one origin':      { t: 'one origin', d: "Every version of that row was filed by the same computer — one writer per row." },
  'p:write + fsync':   { t: 'write + fsync', d: "Each write is also saved to disk before it counts as safe." },
  'p:confirm ✓':       { t: 'confirm ✓', d: "Ask: is this safely on most disks? — and get a yes for everything." },
  'p:kill −9':         { t: 'kill −9', d: "Pull the plug on every computer at the same instant, without warning." },
  'p:replay wals':     { t: 'replay WALs', d: "Each rebooted computer reads its on-disk log back and rebuilds what it knew." },
  'p:write again':     { t: 'write again', d: "The restarted computer makes new changes. It stamps them as a new life of itself — a second author name — so none of its new tickets can collide with the ones it stamped before the crash." },
  'p:encode':          { t: 'encode', d: "One change record is turned into bytes for the wire." },
  'p:frame + crc':     { t: 'frame + CRC', d: "The bytes are wrapped into a frame — a size, the bytes, a checksum — so a corrupted message is caught rather than misread." },
  'p:decode':          { t: 'decode', d: "The bytes are read back into a message." },
  'p:verify':          { t: 'verify', d: "The sizes and counts must match the numbers written down as the expected answer — exactly, not roughly." },
  'p:×100 seeds':      { t: '×100 seeds', d: "The same chaos scenario is run a hundred times with different dice." },
  'p:race + cut':      { t: 'race + cut', d: "Writes start while the computers are still connecting, over faulty connections; half the runs also cut one cable for a while." },

  // ── metrics ──
  'm:links/node':      { t: 'connections per computer', d: "How many live connections one computer ended up with — exactly one per other computer, even though every pair called each other from both ends." },
  'm:dup links closed': { t: 'duplicate lines hung up', d: "When two computers call each other at once, one line gets hung up; this counts those hang-ups. Both ends count theirs, so it exceeds the number of pairs." },
  'm:events':          { t: 'events', d: "How many individual things happened inside the simulated world — messages arriving, timers firing, writes handed in, cables cut. A step counter." },
  'm:writes':          { t: 'writes', d: "How many changes were officially stamped into a record book, counted at the computer that stamped them." },
  'm:applied':         { t: 'applied', d: "How many times a computer received someone else's change that was new to it and filed it — one per receiving computer. A change that then lost a tie-break still counts here; the loss shows separately." },
  'm:hand-off stops': { t: 'stops reached by hand-off', d: "Across every write, how many computers got it inside a whole-row copy after the member list changed, not on its own. Each would have been painted never-arrived before the page read the hand-offs." },
  'm:not-a-holder stops': { t: 'stops at non-holders', d: "Across every write, how many computers were not one of its row's holders and so never got it — by design. Each would have been painted never-arrived before the recording carried the holders." },
  'm:contested':       { t: 'contested fields', d: "Fields where two or more computers wrote the same thing close enough together that a tie-break had to pick a winner. With one designated writer per row this should be zero — that is the point." },
  'm:nodes':           { t: 'computers', d: "How many computers the scenario really ran — the diagram draws only a few of them." },
  'm:links':           { t: 'connections', d: "How many computer-to-computer connections survived — exactly one per pair." },
  'm:members':         { t: 'members', d: "How many computers were invited into the first official member list." },
  'm:proposers':       { t: 'proposers', d: "How many computers tried to call the first vote — it must be exactly one, the lowest-named." },
  'm:installs':        { t: 'member lists adopted', d: "How many times the new member list was written into a computer's records — it must be exactly one per computer, no misses and no repeats." },
  'm:lww losses':      { t: 'tie-breaks lost', d: "How many times a computer received a change that lost the tie-break and set it aside. The same losing change counts at every computer that set it aside." },
  'm:dups dropped':    { t: 'duplicates dropped', d: "How many times a computer received a change it already had and ignored the repeat." },
  'm:ae re-shipped':   { t: 're-sent after a gap', d: "How many changes had to be re-sent from a record book because a list swap showed a computer's copy was behind." },
  'm:redials':         { t: 'redials', d: "How many times a computer set a timer to try calling an unreachable computer again." },
  'm:give-ups':        { t: 'give-ups', d: "How many times a computer stopped retrying a dead number for a while." },
  'm:revives':         { t: 'revives', d: "How many times the regular heartbeat nudged a computer to try a given-up number again." },
  'm:shed':            { t: 'frames thrown away', d: "How many outgoing messages (frames) were thrown away because the receiving side had paused and the waiting pile overflowed — the whole pile at once." },
  'm:paused links':    { t: 'paused connections', d: "How many of one computer's connections were frozen on purpose to build up pressure." },
  'm:whole-queue drops': { t: 'whole-pile drops', d: "How many times a frozen connection's waiting pile overflowed and was emptied — exactly once per connection." },
  'm:records shed':    { t: 'frames thrown away, in total', d: "The total number of frames — here one change each — thrown away across all fifty frozen connections." },
  'm:views committed': { t: 'member lists adopted', d: "How many times a computer adopted a new official member list. On the split-brain card the first list is not counted, so the number there must be zero." },
  'm:evictions':       { t: 'evictions', d: "How many times a computer noted that a member was dropped from the group when it adopted the new list — once per computer that noted it, including the dropped computer itself once it hears the news." },
  'm:joins':           { t: 'join knocks', d: "How many please-let-me-back-in messages were sent or received." },
  'm:writes buffered': { t: 'writes that waited', d: "How many writes a cut-off computer held in its pocket instead of filing them, waiting to be reconnected." },
  'm:forwarded':       { t: 'writes forwarded', d: "How many writes arrived at a computer that was not in charge and were handed to the one that is." },
  'm:acked runs':      { t: 'receipts', d: "How many got-it receipts came back. A handed-off write can be confirmed twice — first when its copied change comes back, then by the receipt itself — so this can be double the number forwarded." },
  'm:commits':         { t: 'commits', d: "How many times the computer in charge filed the write — it must be exactly once, even after a retry." },
  'm:acks observed':   { t: 'receipts seen', d: "How many times the computer that asked learned its write was filed — the copy of the change arriving counts, and so does a receipt after a retry. It must be at least one, by one route or another." },
  'm:forwards':        { t: 'forwards', d: "How many times a write was handed to the computer in charge of its row." },
  'm:parked':          { t: 'writes parked', d: "How many writes a cut-off computer parked in its pocket, to send once reconnected." },
  'm:flushed via owner': { t: 'filed by the owner', d: "How many versions of the shared value ended up filed by the computer in charge — both, including the one the cut-off computer had pocketed." },
  'm:confirmed persisted': { t: 'confirmed on disk', d: "How many is-this-safely-on-most-disks questions came back yes before the plug was pulled." },
  'm:rows replayed':   { t: 'rows replayed from disk', d: "How many saved records the rebooted computers read back from their disks." },
  'm:author lanes':    { t: 'author names of the reborn member', d: "How many author names the restarted computer's record books hold for itself: its first life and its second. Two means the new life stamped under a fresh name, as it must; one would mean it wrote nothing after coming back." },
  'm:bytes/record':    { t: 'bytes per record', d: "How big one standard change is on the wire. The expected number is written down exactly, so any change here is a real change to what goes over the wire." },
  'm:frames/burst (3 peers)': { t: 'frames per burst', d: "When one computer writes with three peers listening, how many messages (frames) it sends — exactly one each, never more." },
  'm:seeds':           { t: 'seeds passing', d: "How many of the hundred randomised chaos runs came out clean." },
  'm:events/s':        { t: 'events per second', d: "How fast the simulator chews through events — a speed reading, wobbly from run to run, and here higher is better." },
  'm:wall ms':         { t: 'wall-clock ms', d: "How long this scenario took on the real clock. The simulation itself runs in fake time; this number jiggles and never affects pass or fail." },
  'delta:same':        { t: '= — unchanged', d: "Same as the baseline run. Counted metrics come out identical run after run, so equal is the expected quiet answer." },
  'delta:drift':       { t: 'drifted from the baseline', d: "old → new. Counted metrics come out identical run after run, so any change is a signal worth reading — even one that looks like an improvement." },
  'delta:ms':          { t: '± vs the baseline', d: "Timing change against the baseline — on the wall-clock row how much slower or faster, on the events-per-second row how much throughput moved. Timing swings 2-3× on this machine, so it is shown dimly — the counted rows are the signal." },
  'delta:ms-hot':      { t: 'more than doubled', d: "A timing number more than doubled against the baseline — on the wall-clock row that means slower, on the events-per-second row it actually means faster. Still a noisy number here, but big enough to notice." },
}

//! tip(key) — the entry or null. Exact keys only (own properties — never a prototype hit like 'constructor').
export const tip = (key) => (key != null && Object.prototype.hasOwnProperty.call(ELI5, key) ? ELI5[key] : null)

//! phaseKey(label) — 'converge ×100' → 'p:converge': a trailing ×N is the scenario's size, not the phase's meaning
export const phaseKey = (label) => 'p:' + String(label ?? '').replace(/\s*×[\d,]+\s*$/u, '').trim().toLowerCase()

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

//! tipHTML(key, fact) — pure: the card's inner markup, or '' when the key is unknown (no card at all)
export const tipHTML = (key, fact = '') => {
  const e = tip(key)
  if (!e) return ''
  return `<div class="e5t">${esc(e.t)}</div><div class="e5d">${esc(e.d)}</div>` + (fact ? `<div class="e5f">${esc(fact)}</div>` : '')
}

//! the card's CSS — tokens come from the host page's :root (both pages share the pure-black system);
// the fallbacks keep it legible if a page ever drops a token. Gold stays chrome: the inset hairline is
// the same accent the selected tree row carries, never a status colour.
const CSS = `
.e5{position:fixed;left:0;top:0;z-index:1000;max-width:330px;pointer-events:none;opacity:0;transition:opacity .08s;
  background:#101013;border:1px solid var(--line-2,#3b3b43);border-radius:5px;padding:8px 12px 9px 13px;
  box-shadow:inset 2px 0 0 var(--gold,#ecc36a),0 12px 34px #000d;font:12px/1.5 var(--ui,system-ui,sans-serif);color:var(--ink,#fbfcfe)}
.e5.on{opacity:1}
.e5 .e5t{font:700 9.5px/1.4 var(--ui,system-ui,sans-serif);letter-spacing:.08em;text-transform:uppercase;color:var(--gold,#ecc36a);margin-bottom:3px}
.e5 .e5d{color:var(--ink,#fbfcfe);word-break:break-word}
.e5 .e5f{margin-top:5px;font:11px/1.4 var(--mono,ui-monospace,monospace);color:var(--soft,#70707a);word-break:break-word}
[data-tip]{cursor:help}
`

//! mountTips(doc) — the hover layer: ONE floating card + ONE delegated listener set on the document, so
// every innerHTML repaint (tree, inspector, menu, status bar, cards) is covered without per-element
// wiring. Show after a short settle (instant when sliding between tips), hide on leave / press / scroll /
// key, and re-hide when a repaint detached the anchor under the cursor. Idempotent per document; returns
// the controller (the tests drive it through the registered listeners, like every other interaction).
export const mountTips = (doc, opts = {}) => {
  if (!doc) return null
  if (doc.__eli5) return doc.__eli5
  const win = doc.defaultView || globalThis
  const delay = opts.delay ?? 120
  const style = doc.createElement('style')
  style.textContent = CSS
  doc.head.appendChild(style)
  const card = doc.createElement('div')
  card.className = 'e5'
  card.setAttribute('role', 'tooltip')
  doc.body.appendChild(card)

  let anchor = null
  let timer = 0
  const cancel = () => { if (timer) { win.clearTimeout(timer); timer = 0 } }
  const hide = () => { cancel(); anchor = null; card.classList.remove('on'); card.innerHTML = '' }
  const place = () => {
    if (!anchor || !anchor.getBoundingClientRect) return
    const r = anchor.getBoundingClientRect()
    const vw = win.innerWidth || 1280, vh = win.innerHeight || 800
    const cw = card.offsetWidth || 0, ch = card.offsetHeight || 0
    let x = Math.max(8, Math.min(r.left, vw - cw - 8))
    let y = r.bottom + 7
    if (y + ch > vh - 8) y = r.top - ch - 7      // no room below → above
    if (y < 8) y = 8
    card.style.left = x + 'px'
    card.style.top = y + 'px'
  }
  const show = (el) => {
    const html = tipHTML(el.getAttribute('data-tip'), el.getAttribute('data-tip-fact') || '')
    if (!html) { hide(); return }                // unknown key → no card (absence renders as absence)
    anchor = el
    card.innerHTML = html
    card.classList.add('on')
    place()
  }
  const tipOf = (t) => (t && t.closest ? t.closest('[data-tip]') : null)

  doc.addEventListener('mouseover', (e) => {
    const el = tipOf(e.target)
    if (!el) { if (anchor || timer) hide(); return }
    if (el === anchor) return
    cancel()
    const wait = anchor ? 0 : delay              // sliding between tips is instant; a first hover settles
    timer = win.setTimeout(() => { timer = 0; show(el) }, wait)
  })
  doc.addEventListener('mouseout', (e) => {      // leaving the document (relatedTarget null) drops the card
    if (!e.relatedTarget && (anchor || timer)) hide()
  })
  doc.addEventListener('mousemove', () => { if (anchor && anchor.isConnected === false) hide() })   // a repaint replaced the anchor
  for (const ev of ['mousedown', 'keydown', 'wheel']) doc.addEventListener(ev, hide)
  doc.addEventListener('scroll', hide, true)     // scroll does not bubble — capture it
  win.addEventListener && win.addEventListener('resize', hide)

  const api = { card, hide, show, get anchor() { return anchor } }
  doc.__eli5 = api
  return api
}
