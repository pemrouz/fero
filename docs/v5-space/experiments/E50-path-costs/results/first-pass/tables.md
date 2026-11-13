## bench/write

### One checksum pass: ns per pass (3 runs)

| bytes | v4's crc32c (JS, table) | crc32c slice-by-8 (JS) | zlib.crc32 (native, IEEE) | v4 MB/s | native MB/s |
|---|---|---|---|---|---|
| 128 | 324 (324-334) | 166 (163-170) | 153 (152-158) | 395 (383-395) | 835 (813-840) |
| 1,024 | 2,862 (2,850-2,878) | 1,302 (1,276-1,349) | 400 (396-412) | 358 (356-359) | 2,561 (2,486-2,587) |
| 65,536 | 185,334 (184,381-186,114) | 84,657 (82,364-86,664) | 15,267 (14,897-15,371) | 354 (352-355) | 4,293 (4,264-4,399) |
| 1,048,576 | 2,941,552 (2,882,147-3,003,428) | 1,331,054 (1,327,893-1,388,964) | 234,659 (233,869-249,770) | 356 (349-364) | 4,469 (4,198-4,484) |

### v4's codec per record: ns per record (3 runs)

| frame | record | wire bytes per record | encode | of it crc | scan | key | full decode | copyOf at issue | walk only |
|---|---|---|---|---|---|---|---|---|---|
| 1 | row | 147 (147-147) | 3,622 (3,619-3,948) | 377 (370-385) | 1,061 (990-1,113) | 1,221 (1,140-1,267) | 3,608 (3,468-3,616) | 434 (423-451) | 169 (168-188) |
| 1 | field | 38.0 (38.0-38.0) | 516 (507-532) | 78.0 (76.6-79.2) | 499 (469-528) | 779 (744-781) | 782 (771-782) | 15.4 (13.8-15.6) | 14.1 (13.0-14.6) |
| 16 | row | 124 (124-124) | 1,949 (1,923-2,259) | 350 (334-354) | 675 (624-695) | 851 (779-918) | 3,138 (2,904-3,338) | 410 (407-420) | 166 (160-170) |
| 16 | field | 14.4 (14.4-14.4) | 329 (302-329) | 39.3 (39.0-39.4) | 144 (112-145) | 400 (365-424) | 427 (396-466) | 8.90 (8.90-9.40) | 9.50 (9.40-9.70) |
| 256 | row | 127 (127-127) | 1,956 (1,886-1,988) | 359 (357-360) | 669 (666-683) | 841 (814-842) | 3,213 (3,156-3,517) | 436 (419-488) | 180 (176-184) |
| 256 | field | 14.6 (14.6-14.6) | 280 (279-286) | 41.3 (41.2-41.5) | 124 (100-125) | 389 (343-402) | 423 (380-429) | 8.80 (8.40-9.30) | 8.10 (7.90-8.20) |

| 1 MiB value | encode µs | crc alone µs | scan µs | full decode µs | copyOf µs | one slice copy µs |
|---|---|---|---|---|---|---|
| str | 3,550 (3,536-3,642) | 2,956 (2,952-2,963) | 2,964 (2,914-3,022) | 3,525 (3,518-3,626) | 0.00 (0.00-0.00) | 93.1 (84.0-238.0) |
| u8 | 3,255 (3,151-3,284) | 2,986 (2,956-3,040) | 2,992 (2,956-3,007) | 3,213 (3,151-3,304) | 94.0 (61.5-153.7) | 124 (98-172) |

### One hop when the box is idle: µs (3 runs of 19,900 round trips)

| hop | p50 | p90 | p99 |
|---|---|---|---|
| turn | 1.00 (1.00-1.00) | 2.50 (2.50-2.50) | 5.20 (4.50-14.60) |
| worker-rtt | 32.6 (32.1-35.2) | 41.2 (40.5-43.9) | 86.2 (79.4-97.0) |
| pool-write | 26.3 (25.9-27.7) | 33.1 (31.9-34.5) | 64.8 (60.6-65.8) |
| sync-write | 0.60 (0.60-1.10) | 0.80 (0.70-1.30) | 1.40 (1.20-1.90) |

### Decoding the 13 strings of a row: ns per string (3 runs)

| TextDecoder per string (v4) | short-ASCII fast path | fast path + field-name cache |
|---|---|---|
| 127 (122-131) | 66.3 (62.0-71.0) | 61.3 (59.1-63.7) |

## bench/reads

### One local read of a held row: ns per read (key-string building, `idx.only`, subtracted)

| rows | runs | snapshot.k | snapshot | lens.k | handle.k | map.get |
|---|---|---|---|---|---|---|
| 1,000 | 3 | 89,474 (86,739-89,477) | 83,703 (83,157-85,082) | 538 (512-540) | 195 (187-199) | 51.1 (50.6-52.7) |
| 100,000 | 3 | 30.4 ms (29.6-34.0) | 28.7 ms (28.3-28.9) | 3,014 (2,980-3,177) | 2,028 (2,020-2,188) | 453 (442-485) |
| 1,000,000 | 3 | 473 ms (468-501) | 497 ms (458-511) | 4,187 (4,042-4,244) | 2,926 (2,767-2,950) | 928 (909-963) |

### Answering one state-mode SUB of one 100-row room: µs

| rows | runs | scan | index | encode | shared, 100 subscribers | shared, 1000 subscribers |
|---|---|---|---|---|---|---|
| 100,000 | 3 | 2,836 (2,596-2,968) | 483 (466-498) | 241 (239-252) | 4.83 (4.66-4.98) | 0.48 (0.47-0.50) |
| 1,000,000 | 3 | 25,843 (25,435-30,174) | 700 (691-750) | 271 (262-277) | 7.00 (6.91-7.50) | 0.70 (0.69-0.75) |

### Routing one committed record to its followers: ns per record, frames of 256 (3 runs)

| record | followed partitions (of 100,000) | records that hit | scan + full decode | scan + key decode | scan + slot test | slot test alone |
|---|---|---|---|---|---|---|
| row | 0 | 0.0 % | 2,938 (2,876-2,941) | 639 (638-665) | 439 (420-460) | 4.40 (4.30-4.40) |
| row | 10 | 0.0 % | 2,944 (2,936-2,968) | 632 (591-668) | 436 (405-441) | 2.20 (2.20-2.70) |
| row | 1,000 | 1.2 % | 3,007 (2,950-3,019) | 644 (615-652) | 487 (471-514) | 1.70 (1.70-1.80) |
| row | 100,000 | 100.0 % | 3,045 (2,942-3,063) | 628 (611-665) | 644 (614-660) | 2.20 (2.20-3.30) |
| field | 0 | 0.0 % | 500 (496-500) | 442 (414-443) | 149 (136-150) | 2.20 (2.10-3.30) |
| field | 10 | 0.0 % | 540 (522-541) | 446 (430-463) | 150 (146-158) | 2.60 (2.20-2.80) |
| field | 1,000 | 1.2 % | 544 (544-842) | 509 (465-533) | 219 (215-232) | 1.70 (1.70-2.30) |
| field | 100,000 | 100.0 % | 556 (553-565) | 479 (476-486) | 496 (485-497) | 2.20 (2.20-2.30) |

| record | bytes per record | crc check (v4 JS crc32c) | boundary scan |
|---|---|---|---|
| row | 123.2 | 349 (348-355) | 344 (340-356) |
| field | 16.7 | 47.2 (46.9-48.1) | 62.2 (46.4-63.2) |

Cutting one subscriber's frame out of a committed batch: ns per chosen record

| record | records chosen of 256 | re-encode from objects (v4) | copy bytes + v4 JS crc | copy bytes + native crc |
|---|---|---|---|---|
| row | 1 | 3,334 (3,235-3,464) | 1,239 (1,183-1,363) | 1,031 (530-1,100) |
| row | 16 | 2,399 (2,383-2,468) | 461 (457-464) | 157 (154-164) |
| row | 256 | 2,369 (2,310-2,392) | 439 (436-449) | 113 (113-128) |
| field | 1 | 738 (665-739) | 622 (174-670) | 660 (646-675) |
| field | 16 | 321 (317-332) | 163 (136-170) | 111 (104-157) |
| field | 256 | 278 (272-301) | 110 (108-111) | 67.2 (64.5-72.9) |

Self-check (a cut frame decodes back to exactly the chosen records): True

### A live subscription's changes: v4's one control frame per change against one frame per 256: ns per change (3 runs)

| record | step | v4 SUBREC per change | one frame per 256 |
|---|---|---|---|
| row | serve, 1 subscriber, per subscriber | 4,584 (4,524-5,020) | 2,437 (2,285-2,643) |
| row | serve, 100 subscribers, per subscriber | 4,584 (4,524-5,020) | 24.4 (22.9-26.4) |
| row | apply on the client (decode + data) | 5,520 (5,408-5,685) | 3,129 (3,093-3,186) |
| row | wire bytes per change | 181.1 | 117.2 |
| field | serve, 1 subscriber, per subscriber | 2,591 (2,570-2,632) | 277 (272-292) |
| field | serve, 100 subscribers, per subscriber | 2,591 (2,570-2,632) | 2.77 (2.72-2.92) |
| field | apply on the client (decode + data) | 2,411 (2,321-2,512) | 625 (614-630) |
| field | wire bytes per change | 79.6 | 14.7 |

## bench/upkeep

### b1: a checksum and a copy, per byte (32 MB; 100 B records, 256 to a batch; 3 runs)

| case | ns per byte | ns per 100 B record | MB/s |
|---|---|---|---|
| v4-js-crc32c/record | 2.46 (2.45-2.48) | 246 (245-248) | 387 (385-389) |
| v4-js-crc32c/batch | 2.51 (2.47-2.68) | 251 (246-268) | 381 (356-387) |
| zlib-crc32/record | 2.31 (2.29-2.40) | 230 (229-240) | 414 (398-416) |
| zlib-crc32/batch | 0.27 (0.26-0.29) | 27.5 (25.7-28.7) | 3,469 (3,327-3,717) |
| zlib-crc32/1MiB | 0.23 (0.22-0.25) | 23.2 (22.1-25.4) | 4,118 (3,750-4,311) |
| copy-set/batch | 0.04 (0.04-0.04) | 4.40 (4.20-4.40) | 21,523 (21,500-22,839) |
| copy-slice/batch | 0.22 (0.21-0.27) | 22.4 (20.6-27.3) | 4,257 (3,499-4,637) |
| copy-slice/record | 6.98 (6.87-7.16) | 698 (686-716) | 137 (133-139) |
| copy-set/1MiB | 0.06 (0.06-0.06) | 5.80 (5.70-6.10) | 16,304 (15,738-16,650) |

### b2: each level of reading a batch, µs per record (200,000 small rows, 256 to a batch; 3 runs)

| form | level | µs per record, wall | µs per record, CPU | bytes per row |
|---|---|---|---|---|
| v4 | encode | 2.63 (2.62-2.63) | 2.92 (2.86-3.01) | 136.3 |
| json | encode | 0.45 (0.44-0.45) | 0.56 (0.55-0.56) | 138.2 |
| v8 | encode | 0.71 (0.71-0.72) | 0.88 (0.88-0.90) | 124.2 |
| v4 | crc | 0.39 (0.39-0.39) | 0.49 (0.49-0.50) |  |
| v4 | scan | 0.74 (0.74-0.75) | 0.96 (0.95-0.96) |  |
| v4 | key | 1.57 (1.55-1.58) | 1.85 (1.84-1.87) |  |
| v4 | full | 4.11 (4.10-4.11) | 4.48 (4.47-4.52) |  |
| v4 | crc-native | 0.04 (0.04-0.06) | 0.14 (0.14-0.16) |  |
| v4 | full-crc-native | 3.07 (3.05-3.37) | 3.43 (3.42-3.68) |  |
| v4 | scan-no-crc | 0.39 (0.37-0.40) | 0.60 (0.59-0.61) |  |
| v4 | full-no-crc | 3.02 (3.01-3.02) | 3.37 (3.34-3.40) |  |
| json | full | 1.11 (1.10-1.16) | 1.21 (1.20-1.26) |  |
| v8 | full | 0.94 (0.94-0.95) | 1.33 (1.32-1.33) |  |
| json | full-crc-native | 1.13 (1.12-1.15) | 1.23 (1.22-1.24) |  |
| v8 | full-crc-native | 0.98 (0.98-0.99) | 1.38 (1.37-1.39) |  |

## bench/core

### B1: one write and one received record through fero v4 (solo runtime, no I/O)

| mode | runs | ns per op | bytes allocated per op |
|---|---|---|---|
| write-num | 3 | 4,757 (4,510-4,870) | 4,826 (4,821-4,834) |
| write-row | 3 | 8,322 (8,064-8,465) | 8,085 (8,084-8,090) |
| inbound-num | 3 | 2,398 (2,313-2,599) | 2,397 (2,390-2,401) |
| inbound-row | 3 | 7,571 (7,304-8,578) | 7,053 (7,042-7,054) |

Where the time goes: self time by area, % (one CPU profile per mode)

| area | write-num | write-row | inbound-num | inbound-row |
|---|---|---|---|---|
| fero api/data.ts (Bind: issue, outcome, settle) | 36.5 | 22.8 | 7.5 | 3.6 |
| gc | 23.9 | 21.3 | 16.6 | 11.5 |
| data (fold, views) | 15.5 | 12.5 | 33.3 | 12.4 |
| fero kernel other (node, write, link, journal) | 14.6 | 28.6 | 26.3 | 33.6 |
| bench driver | 8.7 | 5.5 | 0.5 | 0.1 |
| fero api/substrate.ts (lens, applyRec) | 0.6 | 1.5 | 0.2 | 0.1 |
| fero kernel/codec.ts | 0.1 | 7.8 | 10.2 | 24 |
| node internals | 0.1 | 0.1 | 2.8 | 5.2 |
| native/builtins | 0 | 0 | 2.6 | 9.4 |

Top functions (self time, %):

- write-num: (garbage collector) :0 23.9; apply fero:kernel/node.ts:2813 10.2; #issue fero:api/data.ts:501 9.9; run core-bench/api.ts:53 8.7; cellOf fero:api/data.ts:283 7.7; #forget fero:api/data.ts:607 7.4; commitOnce data:kernel/runtime.ts:222 4.9; settle data:kernel/node.ts:664 4.2
- write-row: (garbage collector) :0 21.3; apply fero:kernel/node.ts:2813 12.4; stable fero:kernel/node.ts:3110 9.7; #issue fero:api/data.ts:501 7; copy fero:kernel/codec.ts:475 6.1; #forget fero:api/data.ts:607 5.6; run core-bench/api.ts:53 5.5; commit fero:kernel/node.ts:1175 4.7
- inbound-num: (garbage collector) :0 16.6; apply fero:kernel/node.ts:2813 14.8; commitOnce data:kernel/runtime.ts:222 11.7; settle data:kernel/node.ts:664 8.3; flush data:kernel/runtime.ts:181 4.1; slotOf data:kernel/store.ts:157 3.7; inbound fero:kernel/write.ts:799 3.5; #onApply fero:api/data.ts:623 3.5
- inbound-row: apply fero:kernel/node.ts:2813 12.8; stable fero:kernel/node.ts:3110 12; (garbage collector) :0 11.5; decodeUTF8 :0 9.4; value fero:kernel/codec.ts:594 9; decode node:internal/encoding:440 5.2; inbound fero:kernel/write.ts:799 4.5; str fero:kernel/codec.ts:576 4.3

### B2, B5, B6: the per-batch constants (CPU of the whole process: every thread)

| mode | runs | wall µs per op | CPU µs per op | of it user / system | voluntary context switches per op | p50 / p99 µs |
|---|---|---|---|---|---|---|
| fsync-grow | 3 | 156 (156-168) | 43.6 (41.8-44.5) | 2.42 (0.65-7.71) / 41.2 (34.1-43.8) | 3.00 (3.00-3.00) | 144 (144-156) / 400 (370-444) |
| fsync-over | 3 | 120 (116-122) | 29.7 (27.9-33.4) | 4.54 (0.27-22.33) / 28.8 (5.6-29.4) | 2.04 (2.03-2.04) | 113 (110-115) / 258 (206-295) |
| jthread | 3 | 154 (150-156) | 65.6 (63.5-67.3) | 23.9 (14.2-37.5) / 41.7 (29.8-49.3) | 4.05 (4.05-4.05) | 142 (135-142) / 345 (343-454) |
| a1 | 3 | 235 (151-241) | 82.6 (60.4-92.9) | 19.8 (15.2-19.9) / 62.8 (45.2-73.0) | 4.06 (4.05-4.07) | 198 (134-204) / 664 (339-745) |
| a2 | 3 | 233 (232-280) | 108 (105-114) | 32.5 (13.1-46.7) / 75.5 (67.1-92.2) | 6.06 (6.04-6.07) | 204 (201-246) / 609 (606-717) |
| write | 3 | 0.59 (0.58-0.81) | 0.63 (0.61-0.83) | 0.34 (0.31-0.40) / 0.31 (0.29-0.42) | 0.00 (0.00-0.00) | - |
| writev | 3 | 0.69 (0.62-0.74) | 0.71 (0.65-0.77) | 0.32 (0.29-0.35) / 0.36 (0.35-0.45) | 0.00 (0.00-0.00) | - |
| imm | 3 | 0.82 (0.74-0.91) | 0.91 (0.82-1.00) | 0.79 (0.79-0.94) / 0.05 (0.03-0.12) | 0.00 (0.00-0.00) | - |
| hop | 3 | 42.7 (38.0-43.8) | 43.4 (39.4-44.8) | 20.3 (18.5-22.4) / 21.1 (19.1-26.2) | 2.00 (2.00-2.00) | - |

| idle process, 3 s | runs | share of one core | CPU µs per tick | ticks a second | voluntary context switches a second |
|---|---|---|---|---|---|
| tick1 | 3 | 0.06 (0.05-0.06) | 65.4 (59.5-65.8) | 882 (877-887) | 874 (872-882) |
| idle | 3 | 0.00 (0.00-0.00) | - | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |

### B3: a link, per 150 B message (sender and receiver in one process), per link, and per signature

| mode | runs | CPU µs per message | of it user / system | wall µs per message | reads per message |
|---|---|---|---|---|---|
| tcp-each | 3 | 5.94 (5.91-6.20) | 3.29 (3.05-3.38) / 2.82 (2.65-2.86) | 5.58 (5.31-5.80) | 1.00 (1.00-1.00) |
| tcp-cork64 | 3 | 0.47 (0.43-0.50) | 0.38 (0.36-0.39) / 0.09 (0.07-0.11) | 0.29 (0.27-0.29) | 0.02 (0.02-0.02) |
| tcp-cat64 | 3 | 0.41 (0.34-0.43) | 0.32 (0.27-0.35) / 0.08 (0.07-0.09) | 0.23 (0.21-0.23) | 0.02 (0.02-0.02) |
| tls-each | 3 | 9.60 (9.24-9.88) | 7.00 (6.50-7.00) / 2.74 (2.60-2.88) | 9.02 (8.59-9.32) | 1.00 (1.00-1.00) |
| tls-cork64 | 3 | 0.60 (0.55-0.62) | 0.51 (0.47-0.54) / 0.08 (0.07-0.11) | 0.35 (0.33-0.40) | 0.02 (0.02-0.02) |
| tls-cat64 | 3 | 0.46 (0.42-0.48) | 0.35 (0.34-0.39) / 0.10 (0.08-0.11) | 0.28 (0.26-0.29) | 0.02 (0.02-0.02) |

| per link | runs | CPU µs per connection (both ends) | wall µs per connection |
|---|---|---|---|
| hs-tcp | 3 | 109 (107-112) | 80.0 (79.3-90.2) |
| hs-tls | 3 | 2,172 (2,057-2,259) | 2,085 (1,933-2,165) |

| per 150 B message | runs | HMAC-SHA256 µs | Ed25519 verify µs | ES256 verify µs |
|---|---|---|---|---|
| crypto | 3 | 2.45 (2.33-2.63) | 112 (106-116) | 76.5 (74.5-79.0) |

### B4: v4's record bytes, and a 1-byte length for short strings

| format | record | runs | round trip | bytes per record (frames of 256) | envelope of one frame, bytes | frame of 1 record, bytes | encode ns per record | full decode ns per record |
|---|---|---|---|---|---|---|---|---|
| v4 | row | 3 | True | 139 (139-139) | 99.1 (99.1-99.1) | 238 (238-238) | 1,799 (1,786-1,904) | 2,670 (2,666-2,846) |
| short | row | 3 | True | 111 (111-111) | 95.1 (95.1-95.1) | 206 (206-206) | 1,617 (1,592-1,666) | 2,482 (2,408-2,498) |
| v4 | field | 3 | True | 18.0 (18.0-18.0) | 99.0 (99.0-99.0) | 117 (117-117) | 246 (231-250) | 365 (363-366) |
| short | field | 3 | True | 14.0 (14.0-14.0) | 95.0 (95.0-95.0) | 109 (109-109) | 214 (212-218) | 329 (303-332) |

Same row, other forms: JSON 143 B, V8 serialize 135 B; its field names 30 B; strings per row record 14.

### B7: a small row's value as JSON, against v4's codec (frames of 256)

| form | runs | round trip | bytes per record | encode ns per record | decode ns per record |
|---|---|---|---|---|---|
| binary key, value as JSON, parsed per record | 3 | True | 138 (138-138) | 539 (536-542) | 974 (930-974) |
| binary keys, values as one JSON array per frame | 3 | True | 137 (137-137) | 363 (354-368) | 597 (596-612) |
| v4's codec (its decode includes its JS crc32c) | 3 | True | 139 (139-139) | 1,629 (1,578-1,703) | 2,697 (2,632-2,712) |

Load average before each process: median 0.79, range 0.00-3.43, n = 132.
