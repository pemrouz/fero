---------------------------- MODULE Found ----------------------------
(* Founding, row 3: a resource founded with several groups (a pre-split),
   each group placed by load, with its preferred member on another machine.

   Founding is the study's four steps: an opener writes a candidate id to
   its disk, asks the object store to create it, founds only if the stored
   id is its own, else drops it and adopts the stored id.  The founder
   makes the home group (group 0) with itself as the only voter.  Its first
   entry holds the slot table for ALL the groups the size hint asks for.
   The home group's leader then writes one group record per other group;
   the machine a record names makes that group as its first voter.  Each
   group writes a placement of Copies machines, grows to them, and only
   then opens its share of the slots.

   The world (not counted as rules).  Machines go down and come back with
   their disks.  A group is an abstract Raft group: it works while its
   leader and a majority of its voters are up.  Only committed state is
   kept (no lost tails: Raft's own models cover those).  An id is named by
   the machine that made it.

   Lines marked  \* @rule <ledger id or name>  hold the rules. *)
EXTENDS Naturals, FiniteSets

CONSTANTS M,            \* machines
          G,            \* groups the size hint asks for; group 0 is the home group
          K,            \* slots
          Copies,       \* voters a group must have
          MaxCrash,
          FirstVoter,   \* who a group record names: "creator" (the home group's
                        \* leader itself) or "quiet" (the quietest machine)
          PrefByLoad,   \* is a new group's preferred member picked by load?
          HomeFirst     \* does the home group open its share in its first entry?

VARIABLES up, store, dir, has,
          rec,      \* rec[g]: the group record in the home log: the first voter it names
          voters, place, pref, lead,
          open,     \* open[g]: the slots g's log holds open
          crashes,
          homes,    \* ghost: the ids a home group was founded for
          gfound,   \* ghost: how often each group was made
          seedn,    \* ghost: how often each slot's seed rows were applied
          wrote,    \* ghost: the groups a write to each slot committed in
          thin      \* ghost: a placement was written while a machine was not there yet

vars == <<up, store, dir, has, rec, voters, place, pref, lead, open, crashes,
          homes, gfound, seedn, wrote, thin>>

Groups == 0..(G - 1)
Slots  == 0..(K - 1)
Tab(s)   == s % G                       \* the slot table of the first entry
Share(g) == {s \in Slots : Tab(s) = g}

NoDir == [k |-> "none", id |-> "none"]

\* A group works: it has a leader that is up and a majority of voters up.
Works(g) == /\ lead[g] # "none" /\ up[lead[g]]
            /\ 2 * Cardinality({m \in voters[g] : up[m]}) > Cardinality(voters[g])

\* The machines a leader can place a copy on: up, and holding the id.
Avail == {m \in M : up[m] /\ dir[m].k \in {"known", "copy"}}

Load(m)     == Cardinality({g \in Groups : m \in place[g]})        \* copies it is placed for
RLoad(m)    == Cardinality({g \in Groups : rec[g] = m \/ (g = 0 /\ pref[0] = m)})   \* groups it was named for
PLoad(m, x) == Cardinality({g \in Groups \ {x} : pref[g] = m})     \* groups it should lead

Init == /\ up = [m \in M |-> TRUE]
        /\ store = "none"
        /\ dir = [m \in M |-> NoDir]
        /\ has = [m \in M |-> {}]
        /\ rec = [g \in Groups |-> "none"]
        /\ voters = [g \in Groups |-> {}]
        /\ place = [g \in Groups |-> {}]
        /\ pref = [g \in Groups |-> "none"]
        /\ lead = [g \in Groups |-> "none"]
        /\ open = [g \in Groups |-> {}]
        /\ crashes = 0
        /\ homes = {}
        /\ gfound = [g \in Groups |-> 0]
        /\ seedn = [s \in Slots |-> 0]
        /\ wrote = [s \in Slots |-> {}]
        /\ thin = FALSE

--------------------------------------------------------------------------
(* Genesis: one id per name *)

Cand(m) ==
    /\ up[m]
    /\ dir[m].k = "none"                                             \* @rule genesis-conditional-create.2
    /\ dir' = [dir EXCEPT ![m] = [k |-> "cand", id |-> m]]
    /\ UNCHANGED <<up, store, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin>>

Put(m) ==
    /\ up[m] /\ dir[m].k = "cand"
    /\ store = "none"                                                \* @rule genesis-conditional-create.1
    /\ store' = m
    /\ UNCHANGED <<up, dir, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin>>

\* The slots the first entry opens in the home group, and seeds.
FirstOpen == IF HomeFirst THEN Share(0) ELSE {}                      \* @rule genesis-conditional-create.8 share
FirstSeed == IF HomeFirst THEN Share(0) ELSE {}                      \* @rule genesis-conditional-create.4 seed

\* The founder makes the home group with itself as the only voter.
First(m) ==
    /\ up[m] /\ dir[m].k = "cand"
    /\ store = m                                                     \* @rule genesis-conditional-create.3
    /\ dir' = [dir EXCEPT ![m] = [k |-> "copy", id |-> m]]
    /\ has' = [has EXCEPT ![m] = {0}]
    /\ voters' = [voters EXCEPT ![0] = {m}]                          \* @rule genesis-conditional-create.4
    /\ place' = [place EXCEPT ![0] = {m}]
    /\ pref' = [pref EXCEPT ![0] = m]
    /\ lead' = [lead EXCEPT ![0] = m]
    /\ open' = [open EXCEPT ![0] = FirstOpen]
    /\ seedn' = [s \in Slots |-> IF s \in FirstSeed THEN seedn[s] + 1 ELSE seedn[s]]
    /\ homes' = homes \cup {m}
    /\ gfound' = [gfound EXCEPT ![0] = @ + 1]
    /\ UNCHANGED <<up, store, rec, crashes, wrote, thin>>

Drop(m) ==
    /\ up[m] /\ dir[m].k = "cand"
    /\ store \notin {"none", m}                                       \* @rule line:drop-after-answer
    /\ dir' = [dir EXCEPT ![m] = NoDir]
    /\ UNCHANGED <<up, store, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin>>

Adopt(m) ==
    /\ up[m]
    /\ dir[m].k = "none"                                             \* @rule genesis-conditional-create.6
    /\ store # "none"                                                 \* @rule line:adopt-stored
    /\ dir' = [dir EXCEPT ![m] = [k |-> "known", id |-> store]]      \* @rule genesis-conditional-create.5
    /\ UNCHANGED <<up, store, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin>>

--------------------------------------------------------------------------
(* The pre-split: the other groups *)

\* The home group's leader writes a group record that names the group's
\* first voter.  As the ledger reads, that is the leader's own process
\* ("creator").  The other way tried here ("quiet"): once Copies machines
\* are there, it names the machine that was named for the fewest groups.
Named(m) == IF FirstVoter = "creator"
            THEN m = lead[0]                                         \* @rule growth.5 record
            ELSE /\ m \in Avail /\ Cardinality(Avail) >= Copies
                 /\ \A q \in Avail : RLoad(m) <= RLoad(q)            \* @rule new:first-voter-by-load

Record(g, m) ==
    /\ g # 0 /\ rec[g] = "none"                                       \* @rule line:record-once
    /\ Works(0)
    /\ Named(m)
    /\ rec' = [rec EXCEPT ![g] = m]
    /\ thin' = (thin \/ (FirstVoter = "quiet" /\ Avail # M))
    /\ UNCHANGED <<up, store, dir, has, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote>>

\* Only the machine the record names makes the group, and only once.
Make(g, m) ==
    /\ up[m] /\ dir[m].k \in {"known", "copy"}
    /\ rec[g] = m                                                    \* @rule growth.5 first-voter
    /\ g \notin has[m]                                               \* @rule growth.5 once
    /\ has' = [has EXCEPT ![m] = @ \cup {g}]                          \* @rule line:make-keeps
    /\ voters' = [voters EXCEPT ![g] = {m}]
    /\ place' = [place EXCEPT ![g] = {m}]
    /\ pref' = [pref EXCEPT ![g] = m]                                 \* @rule handback.6
    /\ lead' = [lead EXCEPT ![g] = m]
    /\ gfound' = [gfound EXCEPT ![g] = @ + 1]
    /\ UNCHANGED <<up, store, dir, rec, open, crashes, homes, seedn, wrote, thin>>

\* A group whose placement names fewer than Copies machines writes a full
\* one.  It takes the quieter machines.  A new group also names its
\* preferred member here: the machine in the placement that should lead
\* the fewest groups.
Quiet(S, C) == \A a \in S, b \in C \ S : Load(a) <= Load(b)          \* @rule healing-self.19
Fewest(p, S, g) == \A q \in S : PLoad(p, g) <= PLoad(q, g)           \* @rule move-policy.6

Place(g, S, p) ==
    /\ Works(g)
    /\ Cardinality(place[g]) < Copies                                \* @rule growth.1
    /\ S \subseteq Avail \ {lead[g]}                                 \* @rule healing-self.16
    /\ Cardinality(S) = Copies - 1
    /\ Quiet(S, Avail \ {lead[g]})
    /\ place' = [place EXCEPT ![g] = S \cup {lead[g]}]                \* @rule line:place-leader
    /\ IF PrefByLoad /\ g # 0 /\ FirstVoter = "creator"
       THEN p \in S \cup {lead[g]} /\ Fewest(p, S \cup {lead[g]}, g)
       ELSE p = pref[g]                                              \* @rule handback.5
    /\ pref' = [pref EXCEPT ![g] = p]
    /\ thin' = (thin \/ Avail # M)
    /\ UNCHANGED <<up, store, dir, has, rec, voters, lead, open, crashes, homes, gfound, seedn, wrote>>

\* From one voter straight to all the placed machines, once they are up.
Grow(g) ==
    /\ Works(g)
    /\ Cardinality(voters[g]) = 1 /\ Cardinality(place[g]) = Copies
    /\ \A m \in place[g] : up[m]                                     \* @rule growth.2
    /\ voters' = [voters EXCEPT ![g] = place[g]]
    /\ has' = [m \in M |-> IF m \in place[g] THEN has[m] \cup {g} ELSE has[m]]
    /\ dir' = [m \in M |-> IF m \in place[g] THEN [k |-> "copy", id |-> dir[m].id] ELSE dir[m]]
    /\ UNCHANGED <<up, store, rec, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin>>

\* A group opens its share of the slots, as the first entry's table gives
\* it, once it has all its voters.  The open carries the seed rows of
\* those slots.
MySlots(g) == Share(g)                                               \* @rule genesis-conditional-create.8 table
Open(g) ==
    /\ Works(g)
    /\ open[g] = {} /\ Share(g) # {}                                  \* @rule line:open-once
    /\ Cardinality(voters[g]) >= Copies                              \* @rule slot-move.22
    /\ open' = [open EXCEPT ![g] = MySlots(g)]
    /\ seedn' = [s \in Slots |-> IF s \in MySlots(g) THEN seedn[s] + 1 ELSE seedn[s]]
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, lead, crashes, homes, gfound, wrote, thin>>

\* Leadership goes to the preferred member, only if it is a voter.
Handback(g) ==
    /\ Works(g)
    /\ pref[g] # lead[g] /\ up[pref[g]]                               \* @rule line:handback-up
    /\ pref[g] \in voters[g]                                         \* @rule handback.2
    /\ lead' = [lead EXCEPT ![g] = pref[g]]                          \* @rule handback.1
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, open, crashes, homes, gfound, seedn, wrote, thin>>

\* A group whose leader is down elects a voter that is up (Raft, abstract).
Elect(g, m) ==
    /\ lead[g] # "none" /\ ~up[lead[g]]
    /\ m \in voters[g] /\ up[m]
    /\ 2 * Cardinality({v \in voters[g] : up[v]}) > Cardinality(voters[g])
    /\ lead' = [lead EXCEPT ![g] = m]
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, open, crashes, homes, gfound, seedn, wrote, thin>>

\* A group takes a write only for a slot its log holds open.
Write(s, g) ==
    /\ Works(g)
    /\ s \in open[g]                                                 \* @rule slot-table.1
    /\ g \notin wrote[s]
    /\ wrote' = [wrote EXCEPT ![s] = @ \cup {g}]
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, thin>>

--------------------------------------------------------------------------
(* Faults *)

Crash(m) ==
    /\ up[m] /\ crashes < MaxCrash
    /\ up' = [up EXCEPT ![m] = FALSE] /\ crashes' = crashes + 1
    /\ UNCHANGED <<store, dir, has, rec, voters, place, pref, lead, open, homes, gfound, seedn, wrote, thin>>

Start(m) ==
    /\ ~up[m]
    /\ up' = [up EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<store, dir, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin>>

Calm == \/ \E m \in M : Cand(m) \/ Put(m) \/ First(m) \/ Drop(m) \/ Adopt(m)
        \/ \E g \in Groups : Grow(g) \/ Open(g) \/ Handback(g)
        \/ \E g \in Groups, m \in M : Record(g, m) \/ Make(g, m) \/ Elect(g, m)
        \/ \E g \in Groups, S \in SUBSET M, p \in M : Place(g, S, p)
        \/ \E s \in Slots, g \in Groups : Write(s, g)

Rough == \E m \in M : Crash(m) \/ Start(m)

Next == Calm \/ Rough

Spec == Init /\ [][Next]_vars

--------------------------------------------------------------------------
(* Properties *)

\* One resource is founded at most once under one name.
OneHome == Cardinality(homes) <= 1

\* Each group is made once: one log, one first voter.
OneLog == \A g \in Groups : gfound[g] <= 1

\* Each slot is open in at most one group, the one the table names.
OnceSlot == \A s \in Slots : \A g \in Groups : s \in open[g] => Tab(s) = g

\* No slot is open in a group that lacks its voters.
AllVoters == \A g \in Groups :
               (open[g] # {} /\ ~(g = 0 /\ HomeFirst)) => Cardinality(voters[g]) >= Copies

\* A write commits only in the group the table names for its slot.
WriteRight == \A s \in Slots : wrote[s] \subseteq {Tab(s)}

\* Each slot's seed rows land once, in the group that holds the slot, and
\* before any write to it.
SeedOnce == \A s \in Slots : /\ seedn[s] <= 1
                             /\ seedn[s] = 1 => s \in open[Tab(s)]
                             /\ wrote[s] # {} => seedn[s] = 1

\* A copy holds only the stored id.
OneId == \A m \in M : dir[m].k \in {"known", "copy"} => dir[m].id = store

\* The preferred member is one of the placed machines.
PrefPlaced == \A g \in Groups : pref[g] # "none" => pref[g] \in place[g]

\* A group's leader is one of its voters, and every voter holds its log.
LeadVoter == \A g \in Groups : lead[g] # "none" => lead[g] \in voters[g]
VoterHas  == \A g \in Groups : \A m \in voters[g] : g \in has[m]

Full(g) == Cardinality(place[g]) = Copies
AllFull == \A g \in Groups : Full(g)

\* Copies are spread by load.  Judged only on bounds with no crash and at
\* most 3 groups, and only when every machine was there at each placement
\* (a machine that opens the resource later gets no copy at founding).
\* Even: the machines that did not make the groups hold about the same
\* number of copies.
Even == (AllFull /\ ~thin) => \A a, b \in M \ {pref[0]} : Load(a) <= Load(b) + 1

\* A finding, not a goal: when the home group's leader makes every group
\* itself, its machine holds a copy of every group, always.
MakerHoldsAll == AllFull => \E m \in M : Load(m) = G

\* H7: no machine is the preferred member of two fully placed groups.
\* Judged only on bounds with no crash and at least G machines.
Spread == \A g, h \in Groups : (g # h /\ Full(g) /\ Full(h)) => pref[g] # pref[h]

\* H7 with more groups than one placement has machines: the preferred
\* members are spread as evenly as they can be.  Judged when every machine
\* was there at each placement.
SpreadEven == (AllFull /\ ~thin) => \A a, b \in M : PLoad(a, G) <= PLoad(b, G) + 1

Done == /\ store # "none"
        /\ \A g \in Groups : open[g] = Share(g) /\ lead[g] = pref[g] /\ Full(g)
        /\ \A s \in Slots : wrote[s] = {Tab(s)}

\* No stuck state: with every machine up, when no step of the design can
\* run, founding is done.
NoStuck == ((\A m \in M : up[m]) /\ ~ENABLED Calm) => Done

\* For the "always can finish" check (see Live.tla and agef.py).
Goal   == Done
Judged == \A m \in M : up[m]

\* Reach checks ("never reached": TLC must find each violated).
NotDone   == ~Done
NotSpread == ~(Done /\ \A g, h \in Groups : g # h => lead[g] # lead[h])
\* Founding is done and no machine holds a copy of every group.
NotSpared == ~(Done /\ \A m \in M : Load(m) < G)
=============================================================================
