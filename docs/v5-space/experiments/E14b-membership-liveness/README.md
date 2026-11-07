# E-14b: membership on commit, finished (the real CommunityModules jar, the liveness sweep, the healing scenarios, the mutants)

**Question (Q-14, completion addendum).** E-14 asked: are membership changes that take effect on commit, as in etcd's raft, safe and live in fero's healing scenarios? It left four things open: its liveness sweep at 3 to 4 servers did not finish; five healing scenarios were defined but not run; the DEV-10 mutants ran only in random simulation; and local stand-ins replaced the TLA+ CommunityModules jar. E-14b closes these. Threshold (Q-14's own): on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms up to 4, each run up to 1 hour, and on append gives the stuck trace.

RESULTS-PLACEHOLDER
