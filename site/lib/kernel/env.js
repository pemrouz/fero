//! ── kernel/env — the ONLY doorway between the kernel and the world ───────────
// The v3 organizing idea (plan-v3.md §2): the entire distributed core is a
// single-threaded deterministic kernel advanced only by explicit Events and
// emitting only explicit Effects. This file is the whole contract. The kernel
// may import NOTHING from node:* (enforced by kernel/purity.test.ts) — real
// sockets/timers (shell/) and the simulator (sim/) are both just implementations
// of the interfaces below, which is what makes every protocol behaviour a
// seeded, reproducible trajectory instead of a wall-clock race.
//
// Design note: Effects are a typed METHOD-PER-KIND sink rather than a pushed
// tagged-union object. Pushing `{kind:'send', ...}` objects would allocate one
// wrapper per effect on the hottest path (v2 ate a 3x GC regression from exactly
// one per-write object); methods with scalar args allocate nothing. Events stay
// a closed tagged union — they are allocated by the I/O boundary anyway (one per
// socket chunk / timer fire), so the union costs nothing extra and keeps
// node.step() a single fail-closed dispatch site.

//! One inbound stimulus. The closed union node.step() dispatches on — nothing else moves the kernel.
                   
                                                                                                           
                     
                                                                                                             
                                                                                                    
                     
                                                                                                                                        
                                                                  
                                                                                                                         
                                                        
                                                                                                                                                                                                                        
                                                                   
                                                                                                                 
                                                                                                         
                                                                         
                                         
                                                                                                                      
                                   
                                   
                                                                                                             
                                              
                                                                                                                                                                                                            
                                  
                                                                                                    
                                                                                                     
                                        
                                                          
                                                                                                     
                                                                                                     
                                                                                                       
                                                                                                  
                                                                             
                                                                                              
                                         
                                                                                                      
                                                                                                        
                                                                                                     
                                                                                                      
                                                                                                   
                                                     
                                                        
                                                                                                  
                                                                                                  
                                                                                                 
                                                                                                      
                                                                                      
                                                                                                    
                                                                                                    
                                                                                   
                                                                             
                                                             

//! One outbound consequence. Typed methods (not pushed objects) so the steady-state path allocates no effect
// WRAPPERS by construction (frame buffers and Applied records still allocate; the full alloc-counter
// verification with --expose-gc heap deltas is an M8 pinned-runner deliverable, per plan §7 — not yet a test).
                             
                                                                                                               
                           
                                                                                                                                                                                                                                            
                                             
                                                                                                                    
                                           
                                                                                                                              
                                                  
                                                                                                                                       
                          
                                                                                                                                                                                                                                                                 
                           
                                                                                                       
                                                                                                       
                                                                                                     
                                                                                                     
                                                                                                   
                                                                                                   
                                                                                
                                                               
                                                                                                       
                                                                                                      
                                                                                                      
                                
                                                                                                      
                                                                                                           
                                                       
                                                                  
                                                                                                      
                                                                                                        
                                                                             
                                                                                                      
                                                                                                       
                                                                                                      
                                                                                              
                                                                       
                                                                                          
                                        
                                                                                                         
                                                                                                       
                                                                                                   
                             
                                                                                                         
                                                                                                        
                                                                                                      
                                                                                                       
                                                                                                       
                                                        
                                                                                   
                                                                                                             
                                                                                                            
                                                                                                             
                                                                                                              
                                                                                                          
                                                                                                          
                                                                          
                                                                                    
                                                                                                      
                                                                                                       
                                                                                                    
                                                                                               
                                                                                                        
                                                                                       
                                                                            
 

//! BootRecord: the durable facts a restart derives its boot mode from (plan §5 membership, verbatim).
// votedFor durability is what makes crash-inside-a-ballot double-votes unrepresentable (the M2 debt).
// `lamport` is a clock CEILING, not the current value — a LEASE (kernel/node.ts LAMPORT_LEASE): no
// stamp beyond it ever existed, so a restore resumes AT the ceiling and can never re-issue a seq its
// previous life spent (the durable+restart sweep caught exactly that: a stale per-ballot floor let a
// reborn node re-stamp seqs whose originals still lived at peers — silent loss both ways). Crossing
// the ceiling re-persists the record first; the cold path stays cold, amortized per LEASE stamps.
// The M6 fields are ARMED-ONLY (absent unscoped — R=∞ boot bytes stay byte-identical with M4):
// heldPartitions = the data-authoritative HELD set (plus an open latch's pre-latch held base);
// orphanParts = the FROZEN half, split from held by the M6 review (finding 48 — a merged list let a
// boot rescope silently un-freeze a restored orphan the ring re-assigned; restored orphans re-enter
// ONLY through the latch); dirtyParts = partitions holding a spliced interior record no WAL snapshot
// has captured yet — their replay-rebuilt floors would OVERCLAIM (row maxes cover seqs the rows
// provably miss), so restore zeroes those floors and the handshake re-heals honestly-low; floors =
// the per-(origin, partition) possession/durable floors at the last boot write — the replay SEED the
// pp chain-rebuild advances from (the panel's compaction hole: chain bases below a compacted or
// pre-pp span would otherwise collapse every floor to 0 on restart; a stale seed is honest-low).
                             
                                                                                                 
                                                                                                      
                                                                                                       
                                                                                                 
                                                                                                 
                                                                                                        
               
                                                                                               
                                                                                                  
                                                                                                   
               
               
                             
                 
                     
                                               
                           
                        
                       
                                                           
 

//! Env: what the kernel is allowed to know about the world — a clock, a seeded rng, and the sink. Nothing else.
                      
                                                                                                                                                
               
                                                                                                                               
               
                  
 

//! ── the change record — memory format, log entry, and wire payload at once ───
// Carried over from v2 verbatim (the one day-0 hypothesis that proved out):
// {type, key, value, at?} is what `data` emits, what the log stores, and what
// crosses the wire — no translation layer anywhere.

//! REC: record type discriminants (3 bits on the wire — see kernel/codec.ts).
export const REC = { update: 0, insert: 1, remove: 2 }         

//! Rec: one change record. `key` is a path (['user42','active']); `at` is the ordered-insert position key —
// and for a NEW top-level row it IS the row key: the record arrives as { type: insert, key: [], value, at: '<row>' }
// (partitionOf below reads it as the partition of a keyless insert), while a rewrite or a remove of that row
// carries it in key[0]. A tap sees the same shape (api/types.ts Fero.data).
                      
              
               
                 
             
 

//! Applied: a record + the provenance it committed under — what sink.apply() delivers downstream and what monitors/replay hash.
// `iss`/`cid` (M5a) are the ATTEMPT IDENTITY when the committed record carried one (forwarded/relayed
// runs always do; FLAG_ATTEMPT rides replication and the WAL, so inbound and replay applies carry it
// too) — the api layer joins its own issued cids against the apply stream to resolve write promises
// and drop its settlement-index entries. Absent on fast-path local commits (epoch-0 genesis writes), which the
// embedder observes synchronously inside its own write() call instead.
                                      
                
             
               
              
              
 

//! partitionOf: the routing/segmentation unit — key[0], or `at` for a root insert (v2's BI0 case, kept).
export const partitionOf = (r     )         => r.key.length ? r.key[0] : (r.at ?? '')

//! TAG: timer discriminants. A closed set so step()'s timer dispatch is a flat switch that fails closed.
// prove (DESIGN-DOOR §3): the one-shot proving deadline a secured node arms per link at `tune.proveMs` —
// a timer, not a heartbeat sweep, because heartbeat.ms 0 is a documented opt-out. Append-only.
export const TAG = { redial: 1, heartbeat: 2, prove: 3 }         
