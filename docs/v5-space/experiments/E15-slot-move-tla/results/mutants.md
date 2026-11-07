| id | kind | line | mutant | verdict | caught by (bound: property) |
|---|---|---|---|---|---|
| m001 | G | 64 | drop guard: IsOpen(sh.com, x = 0) | survived |  |
| m002 | G | 65 | drop guard: IsOpen(FG(sh), x = 0) | caught | write0: Inv6 |
| m003 | G | 77 | drop guard: a \in DOMAIN d.out | ill-formed | write0: None |
| m004 | G | 78 | drop guard: a > fl | equivalent |  |
| m005 | G | 88 | drop guard: WSlot(b) = "s" | equivalent |  |
| m006 | G | 89 | drop guard: b > fl | equivalent |  |
| m007 | G | 94 | drop guard: ~mv[n].open | equivalent |  |
| m008 | G | 95 | drop guard: ~mv[n].ab | survived |  |
| m009 | G | 99 | drop guard: ~mv[n].can | equivalent |  |
| m010 | G | 100 | drop guard: mv[n].unf = <<>> | equivalent |  |
| m011 | G | 105 | drop guard: ~mv[k].can | survived |  |
| m012 | G | 106 | drop guard: mv[k].unf = <<>> | survived |  |
| m013 | G | 107 | drop guard: ~mv[k].set | equivalent |  |
| m014 | G | 112 | drop guard: ~m.open | equivalent |  |
| m015 | G | 113 | drop guard: ~m.ab | survived |  |
| m016 | G | 114 | drop guard: m.end = <<>> | survived |  |
| m017 | G | 117 | drop guard: ~m.open | equivalent |  |
| m018 | G | 118 | drop guard: ~m.ab | survived |  |
| m019 | G | 119 | drop guard: m.end = <<>> | survived |  |
| m020 | G | 120 | drop guard: m.seen | survived |  |
| m021 | G | 123 | drop guard: ~m.open | equivalent |  |
| m022 | G | 124 | drop guard: ~m.ab | equivalent |  |
| m023 | G | 125 | drop guard: m.end # <<>> | caught | move: Inv9 |
| m024 | G | 128 | drop guard: ~m.open | equivalent |  |
| m025 | G | 129 | drop guard: m.ab | caught | move: Inv9 |
| m026 | G | 132 | drop guard: ~m.open | equivalent |  |
| m027 | G | 133 | drop guard: m.ab | caught | move: Inv9 |
| m028 | G | 134 | drop guard: <<"tack", 0, vr, x>> \in nt | caught | move: Inv9 |
| m029 | G | 172 | drop guard: \/ WSlot(a) = "t"         \/ Serving(sh, d) | caught | write0: Inv4 |
| m030 | G | 182 | drop guard: IsOpen(FG(A), TRUE) | equivalent |  |
| m031 | G | 183 | drop guard: IsOpen(A.com, TRUE) | equivalent |  |
| m032 | G | 184 | drop guard: ~UnderWay(FG(A)) | equivalent |  |
| m033 | G | 193 | drop guard: ~LiveImport(fg) | equivalent |  |
| m034 | G | 194 | drop guard: ~IsOpen(fg, FALSE) | equivalent |  |
| m035 | G | 195 | drop guard: n \notin DOMAIN TMoves(fg) | caught | move: Inv9 |
| m036 | G | 204 | drop guard: n \in DOMAIN mv | ill-formed | move: None |
| m037 | G | 205 | drop guard: mv[n].tgt = tgt | equivalent |  |
| m038 | G | 206 | drop guard: mv[n].N = <<>> | equivalent |  |
| m039 | G | 207 | drop guard: ~mv[n].can | survived |  |
| m040 | G | 208 | drop guard: mv[n].unf = <<>> | equivalent |  |
| m041 | G | 209 | drop guard: IsOpen(A.com, TRUE) | equivalent |  |
| m042 | G | 224 | drop guard: n \in DOMAIN cmv | ill-formed | move: None |
| m043 | G | 225 | drop guard: cmv[n].tgt = tgt | equivalent |  |
| m044 | G | 226 | drop guard: lm.N = <<>> | survived |  |
| m045 | G | 227 | drop guard: ~lm.can | survived |  |
| m046 | G | 228 | drop guard: lm.unf = <<>> | equivalent |  |
| m047 | G | 229 | drop guard: IsOpen(fg, TRUE) | equivalent |  |
| m048 | G | 230 | drop guard: IsOpen(A.com, TRUE) | equivalent |  |
| m049 | G | 235 | drop guard: n \in DOMAIN mv | ill-formed | move: None |
| m050 | G | 236 | drop guard: mv[n].N # <<>> | ill-formed | move: None |
| m051 | G | 237 | drop guard: mv[n].unf = <<>> | survived |  |
| m052 | G | 238 | drop guard: ~mv[n].can | equivalent |  |
| m053 | G | 239 | drop guard: ~mv[n].set | survived |  |
| m054 | G | 248 | drop guard: PLt(p, w[2]) | equivalent |  |
| m055 | G | 249 | drop guard: PLe(w[2], F[1]) | equivalent |  |
| m056 | G | 251 | drop guard: F # <<>> | ill-formed | move: None |
| m057 | G | 252 | drop guard: F[2] = tgt | equivalent |  |
| m058 | G | 253 | drop guard: ~PLt(F[1], p) | equivalent |  |
| m059 | G | 272 | drop guard: n \in DOMAIN cm | survived |  |
| m060 | G | 273 | drop guard: n \in DOMAIN lmv | equivalent |  |
| m061 | G | 274 | drop guard: ~lmv[n].open | equivalent |  |
| m062 | G | 275 | drop guard: ~lmv[n].ab | survived |  |
| m063 | G | 276 | drop guard: lmv[n].end = <<>> | unbounded | move: more than 474,570 states |
| m064 | G | 278 | drop guard: lmv[n].seen | caught | move: 7 |
| m065 | G | 279 | drop guard: PLe(q, pos) | survived |  |
| m066 | G | 281 | drop guard: ~PLt(pos, p) | equivalent |  |
| m067 | G | 282 | drop guard: \/ PLt(pos, q)                 \/ end # <<>> | equivalent |  |
| m068 | G | 284 | drop guard: car[3] = Epoch(FG(sh)) | caught | move: Inv9 |
| m069 | G | 291 | drop guard: ~VLt(ver, table.v) | caught | move: Inv9 |
| m070 | G | 292 | drop guard: ~(/\ ver = table.v           /\ val # table.h) | equivalent |  |
| m071 | G | 292 | drop guard: ver = table.v | caught | move: 7 |
| m072 | G | 293 | drop guard: val # table.h | survived |  |
| m073 | G | 306 | drop guard: n \in DOMAIN mv | ill-formed | move: None |
| m074 | G | 307 | drop guard: mv[n].tgt = tgt | equivalent |  |
| m075 | G | 308 | drop guard: ~mv[n].can | unbounded | move: more than 474,570 states |
| m076 | G | 309 | drop guard: mv[n].unf = <<>> | equivalent |  |
| m077 | G | 310 | drop guard: ~mv[n].set | equivalent |  |
| m078 | G | 311 | drop guard: mv[n].N = <<>> | survived |  |
| m079 | G | 313 | drop guard: mv[n].N # <<>> | equivalent |  |
| m080 | G | 314 | drop guard: ~IsOpen(fg, TRUE) | survived |  |
| m081 | G | 315 | drop guard: F # <<>> | equivalent |  |
| m082 | G | 316 | drop guard: F[2] = tgt | equivalent |  |
| m083 | G | 317 | drop guard: tep >= F[3] | caught | move: Inv9 |
| m084 | G | 325 | drop guard: n \in DOMAIN lmv | ill-formed | move: None |
| m085 | G | 326 | drop guard: ~lmv[n].open | survived |  |
| m086 | G | 327 | drop guard: ~lmv[n].ab | unbounded | move: more than 474,570 states |
| m087 | G | 335 | drop guard: mv[n].N = <<>> | survived |  |
| m088 | G | 336 | drop guard: ~mv[n].can | unbounded | move: more than 474,570 states |
| m089 | G | 337 | drop guard: mv[n].unf = <<>> | equivalent |  |
| m090 | G | 347 | drop guard: n \in DOMAIN lm | equivalent |  |
| m091 | G | 348 | drop guard: cm[n].end # <<>> | equivalent |  |
| m092 | G | 349 | drop guard: cm[n].pos = cm[n].end | equivalent |  |
| m093 | G | 350 | drop guard: ~lm[n].open | unbounded | move: more than 474,570 states |
| m094 | G | 351 | drop guard: ~lm[n].ab | caught | move: Inv9 |
| m095 | G | 352 | drop guard: <<"tack", x, <<0, n, Epoch(Pre(com, cm[n].endi)), 1>>, x>> \in net | caught | move: Inv9 |
| m096 | G | 360 | drop guard: ~lm[n].ab | unbounded | move: more than 474,570 states |
| m097 | G | 361 | drop guard: ~lm[n].open | survived |  |
| m098 | G | 362 | drop guard: ~IsOpen(FG(sh), FALSE) | equivalent |  |
| m099 | G | 368 | drop guard: y # 0 | equivalent |  |
| m100 | G | 369 | drop guard: LiveImport(FG(sh)) | survived |  |
| m101 | G | 375 | drop guard: mv[n].N = <<>> | equivalent |  |
| m102 | G | 376 | drop guard: ~mv[n].can | equivalent |  |
| m103 | G | 377 | drop guard: mv[n].unf = <<>> | equivalent |  |
| m104 | G | 380 | drop guard: ~mv[n].open | equivalent |  |
| m105 | G | 381 | drop guard: ~mv[n].ab | survived |  |
| m106 | G | 399 | drop guard: mv[n].end # <<>> | equivalent |  |
| m107 | G | 400 | drop guard: mv[n].pos = mv[n].end | equivalent |  |
| m108 | G | 401 | drop guard: ~mv[n].ab | survived |  |
| m109 | G | 403 | drop guard: table.h = x | caught | move: Inv1 |
| m110 | G | 404 | drop guard: rows | survived |  |
| m111 | G | 405 | drop guard: others | survived |  |
| m112 | C | 71 | > -> >= in: ep == IF Epoch(le) > p[1] THEN Epoch(le) ELSE p[1] | equivalent |  |
| m113 | C | 78 | > -> >= in: /\ a > fl | equivalent |  |
| m114 | C | 80 | <= -> < in: ELSE IF a <= fl THEN [r /-> "stale", wait /-> d.hw] | equivalent |  |
| m115 | C | 89 | > -> >= in: /\ b > fl}}, | equivalent |  |
| m116 | C | 223 | < -> <= in: N == IF N0[1] < Epoch(fg) THEN <<Epoch(fg), N0[2]>> ELSE N0 | equivalent |  |
| m117 | C | 248 | PLt -> PLe in: ws == {w \in WritesOf(A.com) : /\ PLt(p, w[2]) | equivalent |  |
| m118 | C | 249 | PLe -> PLt in: /\ PLe(w[2], F[1])} | caught | write0: Inv3 |
| m119 | C | 253 | PLt -> PLe in: /\ ~PLt(F[1], p) | caught | move: 7 |
| m120 | C | 269 | PLt -> PLe in: Do(c2) == LET top == IF PLt(pos, q) THEN q ELSE pos | equivalent |  |
| m121 | C | 270 | PLt -> PLe in: e == <<"imp", n, top, {w \in ws : PLt(pos, w[2])}, end, c2>> | survived |  |
| m122 | C | 279 | PLe -> PLt in: /\ PLe(q, pos)) | unbounded | move: more than 474,570 states |
| m123 | C | 281 | PLt -> PLe in: ELSE /\ ~PLt(pos, p) | caught | move: 7 |
| m124 | C | 282 | PLt -> PLe in: /\ \/ PLt(pos, q) | equivalent |  |
| m125 | C | 291 | VLt -> VLe in: IN /\ ~VLt(ver, table.v) | survived |  |
| m126 | C | 305 | > -> >= in: N == Upd(F[1], IF tep > F[1][1] THEN <<tep, F[1][2]>> ELSE F[1]) | equivalent |  |
| m127 | C | 317 | >= -> > in: /\ tep >= F[3] | caught | move: 7 |
| m128 | U | 169 | drop update: Upd(sh, ...) keeps sh | caught | write0: Inv4 |
| m129 | U | 170 | drop update: Upd(sh, ...) keeps sh | equivalent |  |
| m130 | U | 305 | drop update: Upd(F[1], ...) keeps F[1] | caught | write0: Inv6-step |
| m131 | U | 386 | drop update: Upd(net, ...) keeps net | survived |  |
| m132 | U | 402 | drop update: Upd(shut, ...) keeps shut | caught | move: Inv9 |
| m133 | U | 407 | drop update: Upd(table, ...) keeps table | caught | move: Inv9 |
| m134 | U | 175 | drop update of shards: Set(d, res.sh) -> shards | survived |  |
| m135 | U | 175 | drop update of cl: c2 -> cl | survived |  |
| m136 | U | 185 | drop update of shards: Set(0, App(A, <<"exporting", tgt>>)) -> shards | survived |  |
| m137 | U | 196 | drop update of shards: Set(tgt, App(sh, <<"importing", n>>)) -> shards | caught | move: 7 |
| m138 | U | 211 | drop update of net: net \cup {d} -> net | caught | move: 7 |
| m139 | U | 231 | drop update of shards: Set(0, App(A, <<"fenced", n, N, tgt, tep>>)) -> shards | caught | move: 7 |
| m140 | U | 255 | drop update of net: net \cup {d} -> net | caught | move: 7 |
| m141 | U | 271 | drop update of shards: Set(tgt, App(sh, e)) -> shards | caught | move: 7 |
| m142 | U | 295 | drop update of table: [h /-> val, v /-> ver] -> table | caught | move: Inv9 |
| m143 | U | 295 | drop update of net: net \cup {ack} -> net | caught | move: 7 |
| m144 | U | 312 | drop update of shards: Set(0, App(A, <<"cancel", n>>)) -> shards | caught | move: 7 |
| m145 | U | 318 | drop update of shards: Set(0, App(A, <<"unfenced", n, N>>)) -> shards | caught | move: 7 |
| m146 | U | 328 | drop update of shards: Set(tgt, App(sh, <<"abort", n>>)) -> shards | caught | move: 7 |
| m147 | U | 338 | drop update of shards: Set(0, App(A, <<"cancel", n>>)) -> shards | survived |  |
| m148 | U | 353 | drop update of shards: Set(x, App(sh, <<"open", n, cm[n].end>>)) -> shards | caught | move: 7 |
| m149 | U | 363 | drop update of shards: Set(x, App(sh, <<"abort", n>>)) -> shards | survived |  |
| m150 | U | 402 | drop update of shards: Set(x, New(Upd(shut, EndMoves(shut, x)))) -> shards | survived |  |
| m151 | U | 402 | drop update of net: net2 -> net | survived |  |
| m152 | U | 406 | drop update of shards: Set(x, New(Append(pre, <<"rec", "open">>))) -> shards | survived |  |
| m153 | U | 406 | drop update of table: Upd(table, [h /-> x, v /-> <<1, -1, 0, 0>>]) -> table | caught | move: Inv9 |
| m154 | U | 406 | drop update of net: net2 -> net | survived |  |

Tally: caught 35, equivalent 64, ill-formed 8, survived 40, unbounded 7 (of 154 run, 154 made)
