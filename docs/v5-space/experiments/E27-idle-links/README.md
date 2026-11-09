# E-27: 10,000 idle client links in one Node server, over TLS

**Question (Q-27).** Can one Node server hold 10,000 idle client links, over TLS, inside its memory budget? A link is one client's open connection. "Idle" means it is open but quiet: only a heartbeat (a small ping every 30 s, answered with a pong) crosses it. Then 1,000 of those links become active subscribers at 10 messages a second each.

**Decides.** SC-12 (a server holds ≥ 10,000 idle links and ≥ 1,000 active subscribers per core), DEP-07 (one public address with TLS), DEP-13 (small copies); whether the client edge must be native or a proxy, for every candidate.

**Threshold (QUESTIONS.md).** 10,000 TLS links in ≤ 500 MB and ≤ 1 % of a core → a TS edge stands. Above → a native edge or a proxy is planned now.

## Method

Code: [server.mjs](server.mjs) (the edge server, one Node process), [client.mjs](client.mjs) (a client process holding many links), [e27.mjs](e27.mjs) (one run). E-39's reconnect storm reuses the same server and clients.

- **The server.** `net` or `tls` (Node's built-in OpenSSL 3.5.4, TLS 1.3, a P-256 ECDSA certificate). Per link it keeps the socket, its room and a little state. A heartbeat wheel: every second it pings the 1/30 of links whose turn it is, so each link gets one 16-byte ping every 30 s (333 pings a second at 10,000 links), and each client answers with a 16-byte pong. A client joins a room with a 16-byte hello; the server answers with an ack (and, after a restart, the messages the client missed: E-39).
- **The clients.** Two Node processes with 5,000 links each, at most 200 dialing at a time. Clients are the measuring tools; their cost is not the server's.
- **One run.** Start the server; force a GC; read its memory (the baseline). Open 10,000 links; when every link has joined, wait 5 s, force a GC, read memory again. Per link = (RSS with links - baseline RSS) / 10,000; the JS heap's share is reported apart (the rest is OpenSSL's and libuv's native memory). Then 60 s idle with only the heartbeat: the server's CPU from `/proc/self/stat`, as a share of one core. Then the active phase: the server publishes 10 messages a second (100 B) to each of 100 rooms of 10 subscribers (1,000 active subscribers, 10,000 deliveries a second), spread evenly over 10 ms ticks, while the other 9,000 links stay idle; after 5 s of warm-up, 30 s of measurement: server CPU, delivery latency (send stamp to arrival, `CLOCK_MONOTONIC`; the worse of the two client processes), memory.
- **Timing.** Memory is not a speed, but the CPU lines are, so each run sits under the timing lock: one hold per link type (`./run.sh tcp`, `./run.sh tls`), 3 runs each, load average recorded. Medians with the lowest and highest run in brackets.

Reproduce: `./run.sh certs` (a self-signed P-256 certificate in `$SP/e27/certs`), then `./run.sh tcp`, `./run.sh tls`, `./run.sh tls26` (Node 26.13.0, fetched by the toolsmith: ../tools-fetch.sh step `node26`), `./run.sh summary`. Machine: 4 vCPU, 15 GB, Linux 6.18 (Firecracker VM), Node 22.22.0, `ulimit -n` 20,000. Raw lines: [results/](results). Nothing was downloaded for the Node 22 runs; [fetch.sh](fetch.sh) names the Node 26 the `tls26` runs used.

## Results

Raw lines: [results/runs.jsonl](results/runs.jsonl) (one line per run, its load average included); [summarize.py](summarize.py) prints the table.

<!-- tables:start (python3 summarize.py results/runs.jsonl) -->

| link | links | runs | join s | base RSS MB | RSS with links MB | per link KB (RSS) | per link KB (JS heap) | peak RSS MB | idle CPU % of a core | active CPU % of a core | deliveries/s | p50 µs | p99 µs | p99.9 µs | load avg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tcp | 10,000 | 3 | 0.65 (0.65-0.65) | 52.3 (52.3-52.3) | 88.9 (88.3-89.2) | 3.74 (3.68-3.78) | 1.34 (1.34-1.34) | 87.6 (86.8-89.0) | 0.88 (0.88-0.90) | 8.8 (8.6-8.9) | 10,001 (10,000-10,002) | 724 (724-724) | 2,048 (1,878-2,435) | 4,871 (3,444-5,793) | 0.3 (0.1-1.5) |
| tls | 10,000 | 3 | 5.94 (5.85-6.34) | 53.6 (53.6-53.6) | 538.4 (535.1-538.7) | 49.65 (49.31-49.67) | 4.03 (4.03-4.03) | 537.7 (534.5-538.4) | 1.63 (1.58-1.67) | 17.1 (16.8-17.4) | 10,000 (10,000-10,001) | 1,117 (1,117-1,117) | 3,158 (2,896-3,158) | 5,312 (5,312-5,312) | 0.2 (0.1-0.3) |
| tls (Node v26.13.0) | 10,000 | 3 | 6.25 (5.88-6.40) | 57.0 (56.5-57.2) | 548.9 (543.6-549.5) | 50.35 (49.83-50.48) | 4.29 (4.28-4.29) | 547.8 (542.4-548.7) | 1.15 (1.13-1.20) | 17.4 (16.3-17.6) | 10,000 (9,998-10,001) | 939 (939-939) | 2,896 (2,656-3,158) | 5,312 (5,312-6,317) | 0.7 (0.4-1.6) |

<!-- tables:end -->

Base RSS is the server alone after a GC (about 52-54 MB). "RSS with links" is the whole server process holding 10,000 links after a GC; "per link" is the difference divided by 10,000. The JS heap's share is small; the rest is native memory (libuv's socket state, and for TLS, OpenSSL's per-connection state and Node's TLS wrap buffers). Join = the time two client processes took to open and join all 10,000 links (at most 200 dialing at a time per process; for TLS this is 10,000 full handshakes, shared with the clients' own CPU).

### What the numbers say

1. **Plain TCP is cheap.** 10,000 idle links cost 3.7 KB each (37 MB in all, 89 MB for the whole server) and 0.88 % of a core for the heartbeat (333 ping-pongs a second, about 26 µs of server CPU each). 1,000 active subscribers at 10 messages a second each (10,000 deliveries a second) cost 8.8 % of a core with a delivery p99 of 2.0 ms.
2. **TLS costs 13 × the memory and about 2 × the CPU.** Each idle TLS link holds 49.7 KB (4 KB of it in the JS heap), so 10,000 links take 538 MB of RSS, over the 500 MB line by 8 %. The heartbeat costs 1.63 % of a core (about 49 µs per encrypted ping-pong), over the 1 % line. The active phase costs 17 % of a core (about 17 µs per delivery), p99 3.2 ms.
3. **Both TLS misses are narrow and have cheap levers.** The idle CPU is the heartbeat's: a 60 s heartbeat (or TCP keepalive in its place) would halve it (reasoned, not run). The memory is per TLS connection inside Node; TLS terminated in front of Node (a native proxy, or a native edge process) leaves Node holding plain links at 3.7 KB each.
4. **Node 26 does not change the picture.** The same TLS run on Node 26.13.0 held 50.4 KB a link (549 MB) and used 1.15 % of a core idle: less CPU, the same memory.
5. **SC-12's counts hold on one core either way.** 10,000 idle plus 1,000 active links used under a fifth of a core even with TLS.


## What this box cannot show

- **Real clients.** All 10,000 links come from two local processes over loopback. Real clients arrive over real networks with packet loss, slow readers and NAT timeouts; a slow reader makes the server buffer, which idle links here never do.
- **Browsers' WebSocket framing.** These are raw TCP and TLS links; WebSocket adds a few bytes per frame and an HTTP upgrade (E-40).
- **TLS session tickets and resumption at scale.** Each link here did a full handshake once; E-39's storm measures resumption.
- **Kernel socket memory.** RSS counts the process's memory, not the kernel's socket buffers (a few KB per idle socket, outside the process). On a real host with a 256 MB container limit, kernel memory is charged to the container too.

## Verdict

**A Node edge holds 10,000 plain links easily, but 10,000 TLS links narrowly miss both bars: 538 MB (bar 500 MB) and 1.63 % of a core (bar 1 %).** By the threshold, a native edge or a proxy is planned now. The cheapest form is a TLS terminator in front of the TS server (the server then holds plain links: 89 MB and 0.88 % of a core at 10,000), plus a longer heartbeat; DEP-07's "one public address with TLS" is kept by the terminator. A newer runtime does not move it: Node 26.13 (same OpenSSL 3.5 line) holds 50.4 KB a TLS link (549 MB for 10,000) at 1.15 % of a core.

Q-27: one Node 22 server holds 10,000 idle plain-TCP links in 89 MB (3.7 KB a link) at 0.88 % of a core (heartbeat every 30 s), but 10,000 TLS 1.3 links in 538 MB (49.7 KB a link, 4 KB of it JS heap) at 1.63 % of a core, both just over the bar (500 MB, 1 %; Node 26.13: 549 MB, 1.15 %); 1,000 active subscribers at 10 messages/s each cost 8.8 % (TCP) and 17 % (TLS) of a core with p99 2.0 and 3.2 ms. Moves: every candidate with a TS edge (MIN, DRAFT, LEAN, MIN-TS, MIN-P, CELL, LANE, SPLIT, SLOG, RLOG, OBJ) down a little on SC-12 and DEP-07 until a TLS terminator in front of the TS edge (or a native edge) is planned now (an ops component, not a kernel mechanism: +0 on DEV-01, +1 deploy piece on DEP); SRV, RUST, EMB-V8 and SIDE, whose edges can be native, up a little on SC-12 (reasoned: a native TLS stack's per-connection memory was not measured here); SC-12's link counts themselves hold on under a fifth of a core.
