# E-40: a browser or an edge worker as a full client over WebSocket

**Question (Q-40).** Can a browser or an edge worker be a full fero client over WebSocket (P-19: the same client API in Node, Bun, Deno, browsers and edge workers that have no raw TCP, over WebSocket on the project's one public TLS address)? Three parts: how big is `data` plus a client, as a browser bundle; how many deliveries a second does one server core push over WebSocket compared with plain TCP; and how long does a cold client take (start, import, connect, TLS, door, first committed write), in Node and in a Worker-like runtime?

**Decides.** P-19, P-05, SC-12, DEP-07; L0's transports and L3's client shape (DEV-09); with Q-27, whether the client edge must be native.

**Thresholds (QUESTIONS.md).**
- Bundle ≤ 60 KB gzip, WebSocket fan-out ≥ 0.7 × TCP's, and a cold client within P-19's bar → P-19 holds in TS. P-19's bar: the cold client answers in ≤ C + 2 round trips + one TLS handshake, and the import costs ≤ 50 ms.
- Fan-out below 0.7 × TCP's → a native edge (Q-27) is planned now. A bundle above the bar → a client build of `data` is planned now (a data-side change).

## Method

Code: [client/fero-client.ts](client/fero-client.ts) (the prototype client), [server.mjs](server.mjs) (its server), [bundle.mjs](bundle.mjs), [cold.mjs](cold.mjs) with [static-src/](static-src) and [cold-node.mjs](cold-node.mjs), and E-08's relay and subscribers for the fan-out part. `data` at 63fea66 and fero's frame codec (`kernel/codec.ts`, fero a08ac53) are used as they are.

- **The prototype client.** About 100 lines: a WebSocket with binary frames; the door (the server sends a 32-byte nonce with the upgrade; the client proves it holds the project secret with HMAC-SHA-256 through `crypto.subtle`); follow (a cursor; the server answers with a snapshot frame, then each commit); a write that resolves when it commits (V4-7). State lives in `data` (a keyed source, folded through data's hot lane, as a replica folds); records travel in fero v4's frame codec, which already runs in browsers (the site ships it). It uses no Node API. The proof, the follow and the first write leave together, without waiting for the welcome, so after TCP, TLS and the WebSocket upgrade the first write costs one more round trip.
- **(a) Bundle.** esbuild 0.25.12, minified ESM for browsers, tree-shaking on; gzip -9 and brotli 11. Four bundles: all of `data`; only what the client imports from `data` (`$`, `lane`); the codec alone; the whole client.
- **(b) Fan-out.** E-08's Node relay ([relay.mjs](../E08-relay-fanout/relay.mjs)) in `ws` mode: the same relay, but each subscriber does an HTTP upgrade, joins its room with a masked client frame, and each tick's room buffer is one unmasked binary WebSocket frame (a 2-4-byte header, built once per room per tick). E-08's Rust subscriber processes strip the frame headers. TCP and WebSocket ran in the same hold, 1,000 and 10,000 subscribers, at max (the relay flat out on one core), 3 runs each. Plain (no TLS) on both sides, so the comparison isolates the WebSocket framing; TLS's cost is E-27's.
- **(c) Cold client.** A server ([server.mjs](server.mjs)) serves the fero wire over `wss://` (TLS 1.3, P-256 certificate) and the page and bundles over plain `http://` on another port, so the page's own connection never carries the WebSocket's TLS handshake. Ten runs of each: **Node** (a fresh `node` process imports the same browser bundle and connects; Node 22's built-in `WebSocket`); a **Chromium page** (Chrome for Testing 153 headless through Playwright 1.63; a fresh browser per run, so no TLS session or cache survives); a **Chromium dedicated Web Worker** (the page starts a module worker that imports the bundle and connects: the Worker-like runtime, with the same APIs an edge worker has: `WebSocket`, `crypto.subtle`, no DOM). Marks: script start, import done, `open` (TCP + TLS + upgrade), challenge received, proof sent (after the HMAC), first write committed. The commit here is in memory; a replicated commit adds C (E-01: 0.73 ms on this box).
- **Timing.** (b) and (c) ran under the timing lock, load average recorded. (a) is not a speed.

Reproduce: `./fetch.sh` (esbuild), `./run.sh certs`, `../E08-relay-fanout/run.sh build`, then `./run.sh` (bundle, fanout, cold, summary). Raw lines: [results/](results).

## Results

Raw lines: [results/](results) (`bundle.jsonl`, `fanout.jsonl`, `cold.jsonl`; timed runs carry their load average). [summarize.py](summarize.py) prints the tables.

<!-- tables:start (python3 summarize.py results) -->

### (a) Bundle sizes (esbuild, minified ESM for browsers)

| bundle | what | modules | minified bytes | gzip -9 bytes | brotli bytes |
|---|---|---|---|---|---|
| data-all | every export of data | 25 | 96,832 | 26,621 | 23,523 |
| data-used | only data's $ and lane (what the client imports) | 25 | 76,501 | 20,189 | 17,986 |
| codec | fero v4's frame codec | 3 | 17,651 | 7,243 | 6,388 |
| client | the prototype client: data ($, lane) + codec + wire + door | 28 | 95,866 | 27,877 | 24,790 |

### (b) Fan-out from one Node relay core: WebSocket against plain TCP

| relay | tick | wire | subscribers | rate | runs | deliveries/s | records in/s | relay cores | deliveries per relay core-second | subscriber cores (2 procs) | p50 µs | p99 µs | p99.9 µs | load avg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| node | data | tcp | 1,000 | max | 3 | 707,360 (646,454-829,568) | 45,271 (41,373-53,092) | 0.99 (0.99-1.00) | 713,604 (648,887-841,133) | 0.57 (0.52-0.62) | 771,752 (637,534-838,861) | 1,006,633 (973,078-1,073,742) | 1,040,187 (1,006,633-1,140,851) | 2.1 (2.1-2.1) |
| node | data | ws | 1,000 | max | 3 | 626,525 (555,893-708,684) | 40,098 (35,577-45,356) | 0.99 (0.99-1.00) | 632,854 (557,286-714,939) | 0.40 (0.36-0.42) | 872,415 (738,198-973,078) | 1,140,851 (1,140,851-1,207,960) | 1,207,960 (1,140,851-1,207,960) | 2.2 (2.2-2.4) |
| node | immediate | tcp | 1,000 | max | 3 | 1,403,757 (1,339,119-1,861,337) | 89,840 (85,704-119,126) | 0.99 (0.99-1.00) | 1,423,328 (1,345,848-1,861,337) | 0.55 (0.54-0.61) | 385,876 (285,213-402,653) | 520,094 (402,653-520,094) | 536,871 (436,208-536,871) | 1.0 (1.0-1.0) |
| node | immediate | ws | 1,000 | max | 3 | 1,273,416 (1,221,649-1,300,660) | 81,499 (78,186-83,242) | 0.99 (0.99-0.99) | 1,279,815 (1,229,332-1,307,196) | 0.38 (0.38-0.39) | 419,430 (419,430-452,985) | 536,871 (536,871-570,425) | 570,425 (570,425-603,980) | 1.2 (1.1-1.3) |
| node | data | tcp | 10,000 | max | 3 | 602,071 (554,315-626,834) | 3,853 (3,548-4,012) | 0.99 (0.98-0.99) | 613,575 (562,043-632,367) | 0.51 (0.47-0.52) | 5,905,580 (5,637,145-6,174,016) | 9,663,676 (9,663,676-9,663,676) | 9,663,676 (9,663,676-9,663,676) | 2.3 (2.1-2.4) |
| node | data | ws | 10,000 | max | 3 | 576,683 (557,330-640,705) | 3,691 (3,567-4,101) | 0.99 (0.98-0.99) | 583,982 (565,817-647,177) | 0.54 (0.51-0.60) | 5,905,580 (5,905,580-6,174,016) | 9,663,676 (9,663,676-9,663,676) | 9,663,676 (9,663,676-9,663,676) | 2.3 (1.9-2.6) |
| node | immediate | tcp | 10,000 | max | 3 | 1,122,995 (1,060,254-1,133,586) | 7,187 (6,786-7,255) | 0.99 (0.98-0.99) | 1,134,338 (1,075,035-1,150,849) | 0.51 (0.44-0.51) | 4,563,403 (4,563,403-4,831,838) | 6,174,016 (5,905,580-6,442,451) | 6,442,451 (6,174,016-6,710,886) | 1.4 (1.3-1.4) |
| node | immediate | ws | 10,000 | max | 3 | 1,063,297 (1,029,536-1,070,871) | 6,805 (6,589-6,854) | 0.99 (0.98-0.99) | 1,078,121 (1,042,568-1,089,945) | 0.50 (0.49-0.50) | 4,831,838 (4,563,403-4,831,838) | 6,442,451 (6,174,016-6,442,451) | 6,442,451 (6,442,451-6,710,886) | 1.2 (1.1-1.4) |

WebSocket / TCP deliveries per relay core-second at 1,000 subscribers, tick=data: 0.89
WebSocket / TCP deliveries per relay core-second at 1,000 subscribers, tick=immediate: 0.90
WebSocket / TCP deliveries per relay core-second at 10,000 subscribers, tick=data: 0.95
WebSocket / TCP deliveries per relay core-second at 10,000 subscribers, tick=immediate: 0.95

### (c) Cold client: ms from the start of the runtime (process start for Node, navigation start for the page)

| runtime | runs | script starts | import of the bundle | connect + TLS + upgrade (open - start) | open -> challenge | challenge -> proof sent | proof -> first write committed | connect start -> committed | total: runtime start -> committed | load avg |
|---|---|---|---|---|---|---|---|---|---|---|
| node | 10 | 17.9 (16.6-22.7) | 4.1 (3.7-5.7) | 47.3 (37.3-59.3) | 0.7 (0.6-1.0) | 2.9 (2.2-3.9) | 5.0 (4.1-8.2) | 57.6 (44.1-72.2) | 79.2 (66.2-100.7) | 2.8 (2.6-2.8) |
| page | 10 | 13.6 (10.1-18.3) | 21.8 (14.2-29.3) | 11.1 (8.5-13.9) | 0.4 (0.2-0.9) | 0.5 (0.3-0.7) | 5.1 (3.7-6.1) | 17.4 (13.0-20.7) | 51.6 (41.2-63.2) | 2.8 (2.6-2.8) |
| worker (Chromium Web Worker) | 10 | 25.8 (20.0-28.7) | 12.6 (11.3-16.8) | 7.9 (6.7-10.1) | 0.4 (0.3-0.7) | 0.6 (0.4-0.8) | 4.4 (3.2-6.4) | 13.1 (11.5-15.9) | 51.9 (43.5-59.2) | 2.8 (2.8-2.8) |

A second client in the same runtime (warm: the runtime and the bundle are loaded; ms from its connect call):

| runtime | runs | connect + TLS + upgrade | -> challenge | -> proof sent | -> first write committed (total) |
|---|---|---|---|---|---|
| node | 10 | 4.1 (3.5-4.5) | 4.3 (3.6-4.8) | 5.1 (4.3-5.7) | 6.9 (6.0-8.1) |
| page | 10 | 5.8 (3.4-9.3) | 6.0 (3.6-9.8) | 6.3 (3.8-10.2) | 9.6 (6.4-12.6) |
| worker | 10 | 7.2 (4.0-10.7) | 7.5 (4.4-10.8) | 7.8 (4.6-11.0) | 9.9 (7.6-12.6) |

<!-- tables:end -->

**A note on (b).** The `tick=data` rows (the relay fans out after every read of its feed) ran while another agent's analysis job (one Python process, one core, E-37's `agef37.py`) ran outside the lock, so the box had about 3 free cores (load average 2.1-2.4); TCP and WebSocket ran in the same hold, so their ratio stands. The `tick=immediate` rows (the relay gathers every read of one event-loop turn and fans out once, which E-08 found doubles a Node relay's deliveries per core) ran later on a quiet box, again TCP and WebSocket side by side. The ratio is the same in both: 0.89-0.90 × at 1,000 subscribers and 0.95 × at 10,000.

### What the numbers say

1. **The bundle is small.** All of `data` is 26.6 KB gzip; the prototype client with `data`'s source and lane, fero's frame codec, the wire and the door is **27.9 KB gzip** (24.8 KB brotli), under half of P-19's 60 KB. Tree-shaking barely trims `data` (its operators register themselves when imported), so the client pays for the whole engine; that is still well inside the bar.
2. **WebSocket costs little at the relay.** Over WebSocket a Node relay core pushed 0.89-0.90 × (1,000 subscribers) and 0.95 × (10,000) what it pushed over plain TCP, in both tick modes, above the 0.7 line (with the faster tick: 1.28 M against 1.42 M deliveries per core-second at 1,000 subscribers, 1.08 M against 1.13 M at 10,000). The framing is a 2-4-byte header built once per room per tick; the masking cost falls on clients' sends only, which are rare.
3. **A cold client is mostly runtime start and CPU, not round trips.** From its connect call to its first committed write, a cold browser page took 17 ms and a cold Web Worker 13 ms, including the TLS handshake; a second client in the same runtime took 7-10 ms. Cold Node took 58 ms, of which about 43 ms is its built-in WebSocket client loading on first use (the second Node client opened in 4 ms). The import of the bundle took 4 ms (Node), 22 ms (page) and 13 ms (worker), under P-19's 50 ms.
4. **The round trips meet P-19 by design.** TCP, TLS 1.3 and the HTTP upgrade, then one more round trip: the server sends the door's challenge with the 101 response, and the client sends its proof, its follow and its first write together, so the welcome, the snapshot and the commit come back in one flight. That is "one TLS handshake + 2 round trips" (the upgrade and the door-plus-write), plus C for a replicated commit. On loopback a round trip is about 0.05-0.1 ms, so the measured milliseconds above are CPU (crypto, JIT-cold code, folding the 100-row snapshot), which a real network adds its round trips to.


## What this box cannot show

- **Real round trips.** Loopback round trips are about 0.05-0.1 ms, so the cold client's time here is almost all CPU (process or browser start, import, TLS crypto, HMAC). On a real network the protocol's round trips dominate; their count is stated by design and checked in the marks.
- **A real edge runtime.** Cloudflare's workerd, Deno Deploy and Vercel's edge were not run; the Chromium Web Worker stands in (same `WebSocket` and `crypto.subtle`, no raw TCP). An edge runtime's own limits (CPU per request, outbound WebSocket support, connection lifetimes) are not measured.
- **Mobile browsers and slow devices.** Import and HMAC times are for this box's CPU.
- **WebSocket with TLS at scale.** The fan-out comparison is plain; E-27 prices TLS per link.

## Verdict

**Yes: a browser or a Worker-like runtime can be a full fero client over WebSocket, and P-19 holds in TypeScript.** The whole client with `data` is 27.9 KB gzip (bar 60 KB); a Node relay serves WebSocket at 0.89-0.95 × its plain-TCP fan-out (bar 0.7 ×); a cold client imports in 4-22 ms (bar 50 ms) and reaches its first committed write in one TLS handshake plus two round trips, which on this box took 13-17 ms in Chromium (page and Web Worker) and 7-10 ms for a warm client. Two design rules come out of it: the door must ride with the upgrade (challenge in the 101 flight; proof, follow and first write in one flight back), and Node clients should not pay for a WebSocket client they do not need (Node's first WebSocket costs about 43 ms to load; Node can use the plain TLS transport).

Q-40: yes; `data` plus a prototype client (door, follow with cursor, writes that resolve on commit, fero's frame codec) is 27.9 KB gzip (all of `data` 26.6 KB), a Node relay pushes 0.89 × (1,000 subscribers) to 0.95 × (10,000) as many deliveries per core over WebSocket as over plain TCP, and a cold client reaches its first committed write over wss in 13 ms (Chromium Web Worker) and 17 ms (Chromium page) from its connect call, 58 ms in Node (43 ms of it loading Node's WebSocket client), with imports of 4-22 ms and one TLS handshake plus two round trips by design. Moves: every candidate up on P-19 and DEP-07 (the client is TypeScript in every row; browsers and edge workers need no bridge, and no client build of `data` is needed, so that data-side change is avoided); L0 gains WebSocket as a first-class transport carrying the same frames, and L3's client shape fixes the pipelined door (DEV-09); with E-27, the WebSocket edge is affordable in TS per core (0.89-0.95 × TCP), so Q-40 adds no reason for a native edge beyond E-27's TLS-memory finding.
