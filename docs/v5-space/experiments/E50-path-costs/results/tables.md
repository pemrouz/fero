## bench/write

### One checksum pass: ns per pass (3 runs)

| bytes | v4's crc32c (JS, table) | crc32c slice-by-8 (JS) | zlib.crc32 (native, IEEE) | v4 MB/s | native MB/s |
|---|---|---|---|---|---|
| 128 | 284 (275-286) | 146 (144-156) | 135 (124-137) | 452 (447-465) | 949 (937-1,028) |
| 1,024 | 2,516 (2,398-2,736) | 1,181 (1,170-1,236) | 357 (329-376) | 407 (374-427) | 2,867 (2,720-3,114) |
| 65,536 | 158,752 (149,539-164,511) | 74,892 (71,377-75,136) | 12,956 (12,248-12,988) | 413 (398-438) | 5,059 (5,046-5,351) |
| 1,048,576 | 2,608,959 (2,462,114-2,669,395) | 1,220,640 (1,203,663-1,229,770) | 206,424 (201,082-206,556) | 402 (393-426) | 5,080 (5,076-5,215) |

### v4's codec per record: ns per record (3 runs)

| frame | record | wire bytes per record | encode | of it crc | scan | key | full decode | copyOf at issue | walk only |
|---|---|---|---|---|---|---|---|---|---|
| 1 | row | 147 (147-147) | 3,653 (3,626-3,828) | 326 (318-335) | 925 (899-931) | 1,045 (1,042-1,078) | 3,059 (2,804-3,101) | 381 (378-383) | 141 (136-143) |
| 1 | field | 38.0 (38.0-38.0) | 425 (417-448) | 69.8 (65.5-70.0) | 442 (438-446) | 690 (654-714) | 715 (646-742) | 12.6 (12.6-13.0) | 12.3 (12.0-12.9) |
| 16 | row | 124 (124-124) | 1,701 (1,607-1,711) | 297 (290-307) | 608 (590-624) | 755 (744-771) | 2,540 (2,519-2,628) | 364 (361-378) | 135 (134-148) |
| 16 | field | 14.4 (14.4-14.4) | 300 (280-303) | 34.1 (30.4-34.4) | 116 (115-117) | 361 (355-381) | 392 (391-394) | 8.40 (8.30-9.30) | 8.20 (8.00-8.50) |
| 256 | row | 127 (127-127) | 1,740 (1,703-1,777) | 308 (301-316) | 632 (559-651) | 720 (720-782) | 2,712 (2,706-2,815) | 364 (362-369) | 138 (135-140) |
| 256 | field | 14.6 (14.6-14.6) | 216 (211-247) | 35.2 (34.5-35.5) | 116 (110-120) | 343 (339-347) | 359 (354-378) | 8.20 (8.10-8.50) | 7.50 (7.40-7.80) |

| 1 MiB value | encode µs | crc alone µs | scan µs | full decode µs | copyOf µs | one slice copy µs |
|---|---|---|---|---|---|---|
| str | 3,406 (3,296-3,420) | 2,581 (2,562-2,617) | 2,653 (2,604-2,715) | 3,167 (3,124-3,238) | 0.00 (0.00-0.00) | 107 (99-117) |
| u8 | 2,979 (2,805-2,988) | 2,644 (2,486-2,654) | 2,407 (2,402-2,626) | 2,772 (2,618-2,801) | 73.1 (71.6-75.6) | 104 (101-107) |

### One hop when the box is idle: µs (3 runs of 19,900 round trips)

| hop | p50 | p90 | p99 |
|---|---|---|---|
| turn | 0.80 (0.80-0.90) | 2.00 (1.90-2.10) | 3.80 (3.60-4.10) |
| worker-rtt | 37.7 (36.7-38.6) | 46.2 (44.6-51.3) | 87.7 (79.8-104.1) |
| pool-write | 29.7 (28.9-29.9) | 35.2 (34.2-36.9) | 67.5 (63.2-71.9) |
| sync-write | 0.50 (0.50-0.50) | 0.60 (0.60-0.60) | 1.00 (0.90-1.00) |

### Decoding the 13 strings of a row: ns per string (3 runs)

| TextDecoder per string (v4) | short-ASCII fast path | fast path + field-name cache |
|---|---|---|
| 91.2 (88.7-99.0) | 57.1 (52.8-59.6) | 51.2 (48.5-51.9) |

## bench/reads

### One local read of a held row: ns per read (key-string building, `idx.only`, subtracted)

| rows | runs | snapshot.k | snapshot | lens.k | handle.k | map.get |
|---|---|---|---|---|---|---|
| 1,000 | 3 | 86,750 (86,517-103,385) | 81,978 (80,381-89,336) | 594 (551-601) | 180 (159-185) | 42.6 (41.1-42.7) |
| 100,000 | 3 | 32.5 ms (31.9-38.9) | 31.9 ms (30.1-32.2) | 3,147 (3,044-3,339) | 2,084 (1,956-2,134) | 576 (566-596) |
| 1,000,000 | 3 | 532 ms (532-551) | 540 ms (537-540) | 5,228 (5,156-5,468) | 3,883 (3,858-4,102) | 1,209 (1,173-1,259) |

### Answering one state-mode SUB of one 100-row room: µs

| rows | runs | scan | index | encode | shared, 100 subscribers | shared, 1000 subscribers |
|---|---|---|---|---|---|---|
| 100,000 | 3 | 3,221 (2,670-3,309) | 474 (471-490) | 212 (199-224) | 4.74 (4.71-4.90) | 0.47 (0.47-0.49) |
| 1,000,000 | 3 | 28,304 (26,264-29,864) | 735 (723-788) | 234 (226-249) | 7.35 (7.23-7.88) | 0.73 (0.72-0.79) |

### Routing one committed record to its followers: ns per record, frames of 256 (3 runs)

| record | followed partitions (of 100,000) | records that hit | scan + full decode | scan + key decode | scan + slot test | slot test alone |
|---|---|---|---|---|---|---|
| row | 0 | 0.0 % | 2,415 (2,265-2,459) | 482 (470-499) | 334 (327-354) | 3.90 (3.70-4.00) |
| row | 10 | 0.0 % | 2,496 (2,410-2,548) | 493 (460-522) | 340 (336-403) | 1.30 (1.20-2.00) |
| row | 1,000 | 1.2 % | 2,456 (2,430-2,708) | 502 (494-626) | 396 (394-412) | 1.50 (1.50-1.60) |
| row | 100,000 | 100.0 % | 2,470 (2,464-2,972) | 487 (483-523) | 526 (481-600) | 1.30 (1.30-1.40) |
| field | 0 | 0.0 % | 411 (409-507) | 343 (333-374) | 118 (116-118) | 1.20 (1.20-1.30) |
| field | 10 | 0.0 % | 444 (444-446) | 378 (345-391) | 127 (120-132) | 1.50 (1.30-1.90) |
| field | 1,000 | 1.2 % | 453 (451-464) | 394 (391-430) | 192 (186-212) | 1.60 (1.50-1.60) |
| field | 100,000 | 100.0 % | 493 (473-516) | 428 (393-482) | 426 (411-428) | 1.40 (1.30-1.70) |

| record | bytes per record | crc check (v4 JS crc32c) | boundary scan |
|---|---|---|---|
| row | 123.2 | 298 (290-304) | 262 (257-272) |
| field | 16.7 | 41.6 (40.0-41.6) | 52.4 (50.3-57.2) |

Cutting one subscriber's frame out of a committed batch: ns per chosen record

| record | records chosen of 256 | re-encode from objects (v4) | copy bytes + v4 JS crc | copy bytes + native crc |
|---|---|---|---|---|
| row | 1 | 3,019 (2,637-4,410) | 1,144 (961-1,498) | 789 (472-914) |
| row | 16 | 2,053 (1,913-2,100) | 381 (369-386) | 145 (113-156) |
| row | 256 | 2,112 (2,070-2,121) | 398 (387-417) | 109 (107-113) |
| field | 1 | 598 (549-844) | 549 (504-667) | 569 (526-775) |
| field | 16 | 255 (248-260) | 182 (115-185) | 90.1 (82.2-95.0) |
| field | 256 | 230 (224-241) | 102 (99-103) | 57.7 (56.8-58.6) |

Self-check (a cut frame decodes back to exactly the chosen records): True

### A live subscription's changes: v4's one control frame per change against one frame per 256: ns per change (3 runs)

| record | step | v4 SUBREC per change | one frame per 256 |
|---|---|---|---|
| row | serve, 1 subscriber, per subscriber | 4,357 (4,153-4,452) | 2,037 (1,888-2,038) |
| row | serve, 100 subscribers, per subscriber | 4,357 (4,153-4,452) | 20.4 (18.9-20.4) |
| row | apply on the client (decode + data) | 4,380 (4,062-5,165) | 2,677 (2,590-2,817) |
| row | wire bytes per change | 181.1 | 117.2 |
| field | serve, 1 subscriber, per subscriber | 1,956 (1,924-2,230) | 227 (213-260) |
| field | serve, 100 subscribers, per subscriber | 1,956 (1,924-2,230) | 2.27 (2.13-2.60) |
| field | apply on the client (decode + data) | 1,894 (1,864-2,492) | 527 (523-552) |
| field | wire bytes per change | 79.6 | 14.7 |

## bench/upkeep

### b1: a checksum and a copy, per byte (32 MB; 100 B records, 256 to a batch; 3 runs)

| case | ns per byte | ns per 100 B record | MB/s |
|---|---|---|---|
| v4-js-crc32c/record | 2.17 (2.03-2.30) | 217 (203-230) | 439 (415-471) |
| v4-js-crc32c/batch | 2.21 (2.16-2.23) | 221 (216-222) | 431 (429-441) |
| zlib-crc32/record | 2.13 (2.07-2.21) | 213 (207-221) | 447 (432-461) |
| zlib-crc32/batch | 0.45 (0.45-0.46) | 45.1 (44.7-45.7) | 2,114 (2,086-2,134) |
| zlib-crc32/1MiB | 0.48 (0.47-0.49) | 47.6 (47.4-48.7) | 2,004 (1,957-2,014) |
| zlib-crc32/batch-cached | 0.20 (0.17-0.20) | 19.7 (17.5-19.7) | 4,853 (4,842-5,462) |
| v4-js-crc32c/batch-cached | 2.36 (2.23-2.49) | 236 (223-249) | 404 (383-427) |
| copy-set/batch | 0.05 (0.05-0.06) | 5.00 (4.60-5.70) | 18,893 (16,853-20,649) |
| copy-slice/batch | 0.23 (0.18-0.27) | 22.6 (18.3-26.9) | 4,213 (3,548-5,221) |
| copy-slice/record | 9.13 (9.08-9.21) | 913 (908-921) | 104 (104-105) |
| copy-set/1MiB | 0.06 (0.06-0.07) | 6.40 (5.50-6.60) | 14,794 (14,406-17,352) |

### b2: each level of reading a batch, µs per record (200,000 small rows, 256 to a batch; 3 runs)

| form | level | µs per record, wall | µs per record, CPU | bytes per row |
|---|---|---|---|---|
| v4 | encode | 2.36 (2.33-2.40) | 2.85 (2.53-2.96) | 136.3 |
| json | encode | 0.41 (0.40-0.46) | 0.57 (0.55-0.61) | 138.2 |
| v8 | encode | 0.64 (0.63-0.67) | 0.86 (0.85-0.90) | 124.2 |
| v4 | crc | 0.35 (0.34-0.35) | 0.47 (0.46-0.49) |  |
| v4 | scan | 0.68 (0.66-0.69) | 0.91 (0.89-0.93) |  |
| v4 | key | 1.25 (1.25-1.35) | 1.55 (1.55-1.66) |  |
| v4 | full | 3.46 (3.45-3.50) | 3.79 (3.78-3.81) |  |
| v4 | crc-native | 0.07 (0.06-0.07) | 0.19 (0.17-0.19) |  |
| v4 | full-crc-native | 2.58 (2.51-2.62) | 2.95 (2.86-3.00) |  |
| v4 | scan-no-crc | 0.34 (0.32-0.36) | 0.58 (0.56-0.59) |  |
| v4 | full-no-crc | 2.54 (2.44-2.55) | 2.85 (2.80-2.89) |  |
| json | full | 0.99 (0.92-1.00) | 1.12 (1.04-1.13) |  |
| v8 | full | 0.84 (0.83-0.88) | 1.29 (1.28-1.33) |  |
| json | full-crc-native | 1.01 (0.99-1.02) | 1.13 (1.12-1.15) |  |
| v8 | full-crc-native | 0.91 (0.85-0.93) | 1.36 (1.26-1.37) |  |

### b3: one decode pass with the rows kept or not, µs per row (256 to a frame; no checksum)

| shape | rows decoded | form | the rows | runs | bytes per row | µs per row, wall | µs per row, CPU | GC µs per row | heap after, MB |
|---|---|---|---|---|---|---|---|---|---|
| field | 1,000,000 | v4's codec | not kept | 3 | 24 | 0.43 (0.42-0.45) | 0.47 (0.46-0.51) | 0.01 (0.01-0.01) | 21.0 (20.0-21.0) |
| field | 1,000,000 | v4's codec | kept | 3 | 24 | 0.85 (0.74-0.89) | 1.36 (1.10-1.41) | 0.31 (0.27-0.38) | 202 (198-203) |
| field | 1,000,000 | binary key, value as JSON, per record | not kept | 3 | 19.7 | 0.41 (0.36-0.46) | 0.42 (0.37-0.47) | 0.01 (0.01-0.01) | 9.00 (8.00-9.00) |
| field | 1,000,000 | binary key, value as JSON, per record | kept | 3 | 19.7 | 0.64 (0.63-0.81) | 0.88 (0.84-1.09) | 0.14 (0.13-0.17) | 116 (114-116) |
| field | 1,000,000 | one JSON array per frame | not kept | 3 | 25.7 | 0.42 (0.40-0.45) | 0.43 (0.42-0.47) | 0.01 (0.01-0.01) | 42.0 (33.0-44.0) |
| field | 1,000,000 | one JSON array per frame | kept | 3 | 25.7 | 0.70 (0.70-0.73) | 1.10 (1.10-1.16) | 0.23 (0.22-0.24) | 130 (129-131) |
| field | 1,000,000 | V8's format per frame | not kept | 3 | 25.9 | 0.17 (0.16-0.19) | 0.26 (0.26-0.30) | 0.05 (0.05-0.06) | 16.0 (15.0-16.0) |
| field | 1,000,000 | V8's format per frame | kept | 3 | 25.9 | 0.27 (0.26-0.34) | 0.64 (0.64-0.67) | 0.15 (0.14-0.19) | 131 (131-133) |
| small | 1,000,000 | v4's codec | not kept | 3 | 127.5 | 2.33 (2.20-2.34) | 2.38 (2.24-2.40) | 0.04 (0.04-0.04) | 10.0 (6.0-16.0) |
| small | 1,000,000 | v4's codec | kept | 3 | 127.5 | 2.92 (2.78-3.11) | 4.01 (3.83-4.54) | 0.59 (0.55-0.77) | 410 (409-412) |
| small | 1,000,000 | binary key, value as JSON, per record | not kept | 3 | 127.3 | 0.95 (0.85-1.12) | 0.96 (0.86-1.13) | 0.02 (0.01-0.02) | 16.0 (9.0-17.0) |
| small | 1,000,000 | binary key, value as JSON, per record | kept | 3 | 127.3 | 1.30 (1.29-1.38) | 2.00 (1.81-2.00) | 0.35 (0.32-0.41) | 295 (294-297) |
| small | 1,000,000 | one JSON array per frame | not kept | 3 | 131.3 | 0.91 (0.85-0.96) | 0.90 (0.87-0.96) | 0.02 (0.02-0.02) | 30.0 (25.0-35.0) |
| small | 1,000,000 | one JSON array per frame | kept | 3 | 131.3 | 1.38 (1.17-1.50) | 2.12 (1.73-2.45) | 0.40 (0.32-0.48) | 317 (317-318) |
| small | 1,000,000 | V8's format per frame | not kept | 3 | 117.4 | 0.85 (0.85-1.02) | 1.17 (1.13-1.30) | 0.17 (0.17-0.20) | 20.0 (19.0-21.0) |
| small | 1,000,000 | V8's format per frame | kept | 3 | 117.4 | 1.15 (1.11-1.36) | 2.23 (2.17-2.53) | 0.43 (0.42-0.64) | 358 (358-360) |
| big | 250,000 | v4's codec | not kept | 3 | 2037.5 | 3.80 (3.53-3.86) | 4.00 (3.73-4.07) | 0.12 (0.10-0.12) | 5.00 (5.00-16.00) |
| big | 250,000 | v4's codec | kept | 3 | 2037.5 | 5.41 (5.01-5.73) | 8.46 (8.00-9.29) | 1.55 (1.51-1.94) | 594 (591-594) |
| big | 250,000 | binary key, value as JSON, per record | not kept | 3 | 2037 | 2.61 (2.46-2.99) | 2.63 (2.49-3.04) | 0.07 (0.06-0.08) | 6.00 (6.00-9.00) |
| big | 250,000 | binary key, value as JSON, per record | kept | 3 | 2037 | 3.93 (3.90-4.78) | 6.17 (6.12-7.67) | 1.44 (1.36-1.75) | 560 (560-561) |
| big | 250,000 | one JSON array per frame | not kept | 3 | 2040 | 3.49 (3.14-3.67) | 3.54 (3.18-3.70) | 0.19 (0.19-0.21) | 5.00 (5.00-39.00) |
| big | 250,000 | one JSON array per frame | kept | 3 | 2040 | 4.95 (4.79-5.30) | 7.09 (6.94-7.93) | 1.43 (1.39-1.66) | 576 (575-581) |
| big | 250,000 | V8's format per frame | not kept | 3 | 2025.4 | 1.69 (1.53-1.70) | 2.45 (2.24-2.51) | 0.48 (0.44-0.50) | 19.0 (13.0-41.0) |
| big | 250,000 | V8's format per frame | kept | 3 | 2025.4 | 2.57 (2.40-2.95) | 4.96 (4.32-5.67) | 1.38 (1.21-1.53) | 579 (10-579) |
| big | 1,000,000 | v4's codec | kept | 3 | 2038.5 | 6.08 (5.80-6.24) | 8.95 (8.65-9.09) | 2.45 (2.35-2.45) | 2,352 (2,351-2,355) |
| big | 1,000,000 | binary key, value as JSON, per record | kept | 3 | 2038.3 | 5.06 (4.36-5.47) | 7.72 (6.67-7.97) | 2.15 (2.07-2.42) | 2,225 (2,223-2,225) |
| big | 1,000,000 | one JSON array per frame | kept | 3 | 2041.3 | 6.52 (5.48-6.60) | 9.49 (7.78-9.71) | 2.22 (1.86-2.31) | 2,266 (2,263-2,304) |
| big | 1,000,000 | V8's format per frame | kept | 3 | 2026.4 | 3.49 (3.48-3.56) | 5.98 (5.84-6.08) | 1.88 (1.87-1.94) | 2,305 (2,303-2,305) |

## bench/core

### B1: one write and one received record through fero v4 (solo runtime, no I/O)

| mode | runs | ns per op | bytes allocated per op |
|---|---|---|---|
| write-num | 3 | 4,704 (4,677-4,830) | 4,804 (4,801-4,825) |
| write-row | 3 | 7,714 (7,458-7,729) | 8,085 (8,070-8,087) |
| inbound-num | 3 | 2,491 (2,414-2,647) | 2,404 (2,402-2,409) |
| inbound-row | 3 | 7,567 (7,563-7,964) | 7,050 (7,047-7,054) |

Where the time goes: self time by area, % (one CPU profile per mode)

| area | write-num | write-row | inbound-num | inbound-row |
|---|---|---|---|---|
| fero api/data.ts (Bind: issue, outcome, settle) | 36.3 | 22.9 | 9.2 | 3.5 |
| gc | 23.2 | 19.5 | 16.4 | 12.2 |
| data (fold, views) | 15.3 | 12.1 | 33.7 | 12.1 |
| fero kernel other (node, write, link, journal) | 14.9 | 30.1 | 24.9 | 34.1 |
| bench driver | 9.4 | 5.4 | 0.7 | 0.2 |
| fero api/substrate.ts (lens, applyRec) | 0.6 | 1.3 | 0.2 | 0 |
| fero kernel/codec.ts | 0.1 | 8.6 | 11.3 | 23.6 |
| node internals | 0.1 | 0.1 | 1.4 | 5.1 |
| native/builtins | 0 | 0.1 | 2.4 | 9.3 |

Top functions (self time, %):

- write-num: (garbage collector) :0 23.2; apply fero:kernel/node.ts:2813 10.5; #issue fero:api/data.ts:501 10.2; run core/api.ts:57 9.4; #forget fero:api/data.ts:607 7.8; cellOf fero:api/data.ts:283 6.9; commitOnce data:kernel/runtime.ts:222 5; settle data:kernel/node.ts:664 4.3
- write-row: (garbage collector) :0 19.5; apply fero:kernel/node.ts:2813 13.3; stable fero:kernel/node.ts:3110 10.2; copy fero:kernel/codec.ts:475 6.6; #issue fero:api/data.ts:501 6.5; #forget fero:api/data.ts:607 5.7; run core/api.ts:57 5.4; commit fero:kernel/node.ts:1175 5
- inbound-num: (garbage collector) :0 16.4; apply fero:kernel/node.ts:2813 15.8; commitOnce data:kernel/runtime.ts:222 10.7; settle data:kernel/node.ts:664 8.9; flush data:kernel/runtime.ts:181 4.8; cellOf fero:api/data.ts:283 3.8; #onApply fero:api/data.ts:623 3.6; slotOf data:kernel/store.ts:157 3.4
- inbound-row: apply fero:kernel/node.ts:2813 13.9; (garbage collector) :0 12.2; stable fero:kernel/node.ts:3110 11.7; decodeUTF8 :0 9.3; value fero:kernel/codec.ts:594 8.5; inbound fero:kernel/write.ts:799 5.6; decode node:internal/encoding:440 5.1; str fero:kernel/codec.ts:576 4.7

### B2, B5, B6: the per-batch constants (CPU of the whole process: every thread)

| mode | runs | wall µs per op | CPU µs per op | of it user / system | voluntary context switches per op | p50 / p99 µs |
|---|---|---|---|---|---|---|
| fsync-grow | 3 | 161 (154-169) | 43.5 (42.5-44.2) | 7.53 (6.36-9.39) / 34.9 (34.1-37.9) | 3.00 (3.00-3.01) | 141 (140-143) / 486 (363-542) |
| fsync-over | 3 | 127 (112-152) | 32.7 (28.7-37.8) | 12.9 (5.3-15.5) / 22.4 (19.8-23.4) | 2.05 (2.04-2.05) | 112 (104-138) / 303 (215-483) |
| jthread | 3 | 178 (167-207) | 71.9 (67.7-77.9) | 26.8 (17.2-38.9) / 51.1 (28.8-54.7) | 4.06 (4.05-4.07) | 158 (150-176) / 453 (430-534) |
| a1 | 3 | 191 (177-233) | 66.9 (66.9-87.9) | 25.3 (21.1-28.4) / 45.8 (41.6-59.5) | 4.06 (4.05-4.06) | 167 (156-208) / 574 (570-613) |
| a2 | 3 | 246 (195-361) | 104 (100-121) | 22.2 (21.4-42.5) / 78.2 (62.0-98.6) | 6.07 (6.06-6.07) | 194 (179-250) / 731 (425-913) |
| write | 3 | 0.62 (0.60-0.67) | 0.63 (0.57-0.66) | 0.29 (0.25-0.36) / 0.32 (0.29-0.34) | 0.00 (0.00-0.00) | - |
| writev | 3 | 0.68 (0.67-0.69) | 0.70 (0.69-0.70) | 0.33 (0.27-0.38) / 0.37 (0.32-0.42) | 0.00 (0.00-0.00) | - |
| imm | 3 | 0.85 (0.84-1.17) | 0.91 (0.90-1.23) | 0.82 (0.81-1.07) / 0.11 (0.08-0.16) | 0.00 (0.00-0.00) | - |
| hop | 3 | 41.6 (39.9-41.8) | 42.5 (40.8-42.8) | 21.5 (18.7-21.7) / 21.1 (21.0-22.1) | 2.00 (2.00-2.00) | - |

| idle process, 3 s | runs | share of one core | CPU µs per tick | ticks a second | voluntary context switches a second |
|---|---|---|---|---|---|
| tick1 | 3 | 0.05 (0.05-0.06) | 60.8 (58.4-66.2) | 886 (873-886) | 880 (868-883) |
| idle | 3 | 0.00 (0.00-0.00) | - | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |

### B3: a link, per 150 B message (sender and receiver in one process), per link, and per signature

| mode | runs | CPU µs per message | of it user / system | wall µs per message | reads per message |
|---|---|---|---|---|---|
| tcp-each | 3 | 6.20 (5.92-6.35) | 3.38 (3.36-3.81) / 2.56 (2.54-2.82) | 5.75 (5.38-5.89) | 1.00 (1.00-1.00) |
| tcp-cork64 | 3 | 0.47 (0.45-0.48) | 0.36 (0.34-0.38) / 0.10 (0.09-0.13) | 0.28 (0.27-0.29) | 0.02 (0.02-0.02) |
| tcp-cat64 | 3 | 0.36 (0.35-0.42) | 0.28 (0.28-0.33) / 0.09 (0.07-0.09) | 0.22 (0.20-0.27) | 0.02 (0.02-0.02) |
| tls-each | 3 | 8.70 (8.65-8.86) | 6.34 (5.78-6.36) / 2.52 (2.35-2.87) | 8.19 (8.04-8.27) | 1.00 (1.00-1.00) |
| tls-cork64 | 3 | 0.58 (0.53-0.63) | 0.51 (0.42-0.52) / 0.10 (0.06-0.12) | 0.37 (0.34-0.39) | 0.02 (0.02-0.02) |
| tls-cat64 | 3 | 0.43 (0.40-0.51) | 0.34 (0.33-0.44) / 0.07 (0.07-0.09) | 0.27 (0.24-0.31) | 0.02 (0.02-0.02) |

| per link | runs | CPU µs per connection (both ends) | wall µs per connection |
|---|---|---|---|
| hs-tcp | 3 | 100 (89-104) | 72.4 (66.1-79.6) |
| hs-tls | 3 | 2,008 (1,735-2,106) | 1,888 (1,626-1,982) |

| per 150 B message | runs | HMAC-SHA256 µs | Ed25519 verify µs | ES256 verify µs |
|---|---|---|---|---|
| crypto | 3 | 2.52 (2.45-2.53) | 104 (87-105) | 77.4 (73.9-80.9) |

### B4: v4's record bytes, and a 1-byte length for short strings

| format | record | runs | round trip | bytes per record (frames of 256) | envelope of one frame, bytes | frame of 1 record, bytes | encode ns per record | full decode ns per record |
|---|---|---|---|---|---|---|---|---|
| v4 | row | 3 | True | 139 (139-139) | 99.1 (99.1-99.1) | 238 (238-238) | 1,746 (1,694-1,748) | 2,846 (2,739-2,893) |
| short | row | 3 | True | 111 (111-111) | 95.1 (95.1-95.1) | 206 (206-206) | 1,566 (1,506-1,613) | 2,450 (2,348-2,534) |
| v4 | field | 3 | True | 18.0 (18.0-18.0) | 99.0 (99.0-99.0) | 117 (117-117) | 235 (225-238) | 338 (331-368) |
| short | field | 3 | True | 14.0 (14.0-14.0) | 95.0 (95.0-95.0) | 109 (109-109) | 216 (197-224) | 347 (326-355) |

Same row, other forms: JSON 143 B, V8 serialize 135 B; its field names 30 B; strings per row record 14.

### B7: a small row's value as JSON, against v4's codec (frames of 256)

| form | runs | round trip | bytes per record | encode ns per record | decode ns per record |
|---|---|---|---|---|---|
| binary key, value as JSON, parsed per record | 3 | True | 138 (138-138) | 539 (484-548) | 885 (842-964) |
| binary keys, values as one JSON array per frame | 3 | True | 137 (137-137) | 362 (347-366) | 621 (617-623) |
| v4's codec (its decode includes its JS crc32c) | 3 | True | 139 (139-139) | 1,632 (1,574-1,700) | 2,761 (2,727-2,763) |

### B8: a field record (one number), v4's codec against a binary key and the value as JSON (frames of 256, hot loop, not kept)

| form | runs | round trip | bytes per record | encode ns per record | decode ns per record |
|---|---|---|---|---|---|
| v4's codec | 3 | True | 24.1 | 333 (330-340) | 406 (392-409) |
| binary key and field, value as JSON | 3 | True | 16.4 | 312 (272-314) | 377 (365-384) |

### B9: PA-1b's tagged escape, ns per record

Self-check (every escaped class round-trips; plain values get no flag): True

| shape | runs | JSON bytes | JSON.stringify | the walk alone | walk + stringify | stringify with a replacer | JSON.parse | JSON.parse with a reviver |
|---|---|---|---|---|---|---|---|---|
| field | 3 | 5.4 | 98.0 (88.3-98.2) | 6.50 (6.40-6.60) | 94.9 (92.8-96.5) | 230 (229-234) | 69.0 (65.8-69.6) | 346 (328-366) |
| small | 3 | 108.5 | 301 (297-318) | 58.9 (58.1-64.8) | 415 (384-420) | 884 (833-887) | 582 (577-582) | 4,602 (4,157-4,811) |
| big | 3 | 2018.5 | 5,296 (5,270-5,323) | 74.4 (70.2-77.5) | 5,438 (5,255-5,480) | 5,928 (5,723-6,070) | 1,270 (1,248-1,365) | 5,497 (5,032-5,604) |

### B10: the flush split: one 128 B write and one flush, preallocated file (CPU of the whole process)

| mode | runs | CPU µs per op | p50 µs | p99 µs |
|---|---|---|---|---|
| writeSync + fdatasyncSync (in place) | 3 | 29.7 (25.4-31.4) | 118 (89-118) | 245 (137-361) |
| writeSync + fsyncSync (in place) | 3 | 32.5 (30.8-32.7) | 117 (115-124) | 335 (255-344) |
| writeSync + async fdatasync (one pool hop) | 3 | 80.4 (74.4-86.8) | 191 (148-200) | 522 (490-646) |
| writeSync + async fsync (one pool hop) | 3 | 76.1 (71.5-96.6) | 158 (149-244) | 598 (438-780) |
| async write + async fdatasync (two pool hops) | 3 | 106 (106-115) | 185 (175-234) | 575 (541-610) |
| async write + async fsync (two pool hops: v4's way) | 3 | 94.8 (86.7-111.3) | 173 (161-204) | 465 (412-541) |

### B11: E-10's TypeScript Raft port in E-11's host, three processes on loopback, one Raft entry per 100 B write

| groups | offered writes/s | runs | committed/s | cluster cores | CPU µs per write (cluster) | busiest process, cores | fsyncs/s per process | commit p50 ms | commit p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 10,000 | 3 | 9,992 (9,991-9,995) | 1.87 (1.87-1.87) | 187 (187-187) | 0.71 (0.70-0.71) | 1,096 (926-1,114) | 3.43 (3.42-3.94) | 14.9 (11.7-25.8) |
| 1 | 50,000 | 3 | 49,906 (49,880-49,916) | 2.35 (2.32-2.36) | 47.2 (46.4-47.3) | 0.92 (0.92-0.95) | 229 (229-233) | 14.3 (14.1-14.5) | 83.7 (81.2-92.4) |
| 16 | 10,000 | 3 | 9,996 (9,996-9,997) | 1.43 (1.41-1.49) | 143 (141-149) | 0.48 (0.47-0.51) | 2,701 (2,334-2,746) | 1.81 (1.77-2.03) | 10.6 (7.4-33.9) |
| 16 | 50,000 | 3 | 49,851 (49,807-49,854) | 2.72 (2.66-2.77) | 54.6 (53.4-55.6) | 0.92 (0.90-0.94) | 285 (185-288) | 18.1 (16.7-24.3) | 127 (119-191) |

Load average before each process: median 1.20, range 0.25-4.45, n = 249.
