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

   Fewer machines than Copies (V5-39, after card 0002).  The switch Fewer
   picks how slot-move.22 counts.  "no" is the reading before card 0002: a
   group opens its slots only with Copies voters.  "every" is the decided
   reading: a group opens with Copies voters, or with as many voters as the
   resource has machines when it has fewer; and a group places every listed
   machine while fewer than Copies are listed, then grows as machines come.
   "three" is the same count with growth as the ledger writes it (a
   placement of Copies machines, else one voter): a probe.  The resource's
   machines, as a leader can know them: the machines it may place a copy on
   now (up, holding the id) and every machine a stored placement names (the
   members in the home records), down or not.

   Lines marked  \* @rule <ledger id or name>  hold the rules. *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS M,            \* machines
          G,            \* groups the size hint asks for; group 0 is the home group
          K,            \* slots
          Copies,       \* voters a group must have
          MaxCrash,
          FirstVoter,   \* who a group record names: "creator" (the home group's
                        \* leader itself) or "quiet" (the quietest machine)
          PrefByLoad,   \* is a new group's preferred member picked by load?
          HomeFirst,    \* does the home group open its share in its first entry?
          Fewer,        \* how slot-move.22 counts: "no", "every" or "three" (above)
          Late,         \* the world: machines that open the resource only once
                        \* every group has opened its share; they never found it
          MaxShrink     \* the world: how often a voter that is down may be taken
                        \* out of its group (a group that shrinks below Copies)

VARIABLES up, store, dir, has,
          rec,      \* rec[g]: the group record in the home log: the first voter it names
          voters, place, pref, lead,
          open,     \* open[g]: the slots g's log holds open
          crashes,
          homes,    \* ghost: the ids a home group was founded for
          gfound,   \* ghost: how often each group was made
          seedn,    \* ghost: how often each slot's seed rows were applied
          wrote,    \* ghost: the groups a write to each slot committed in
          thin,     \* ghost: a placement was written while a machine was not there yet
          shrinks,  \* how often a voter was taken out of a group
          short,    \* ghost: a group opened with fewer voters than the machines there
          shrunk    \* ghost: a group opened below Copies after some placement named Copies machines

vars == <<up, store, dir, has, rec, voters, place, pref, lead, open, crashes,
          homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

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

Min(a, b) == IF a < b THEN a ELSE b

Full(g) == Cardinality(place[g]) = Copies

\* The resource's machines, as group g's leader counts them: the machines
\* it may place a copy on now (healing-self.16, .19), and every machine a
\* stored placement names, of any group, up or down (the members in the
\* home records, home-records.1).  Only Fewer # "no" reads it.
Known(g) == Avail \cup UNION {place[h] : h \in Groups}               \* @rule slot-move.22 machines

\* The voters group g needs before it opens, with Fewer # "no".
Need(g) == Min(Copies, Cardinality(Known(g)))

\* How many machines a placement names: Copies, or with Fewer = "every"
\* every listed machine while fewer than Copies are listed.
Size == IF Fewer = "every" THEN Min(Copies, Cardinality(Avail)) ELSE Copies

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
        /\ shrinks = 0
        /\ short = FALSE
        /\ shrunk = FALSE

--------------------------------------------------------------------------
(* Genesis: one id per name *)

Cand(m) ==
    /\ up[m] /\ m \notin Late                                         \* the world: a late machine never founds
    /\ dir[m].k = "none"                                             \* @rule genesis-conditional-create.2
    /\ dir' = [dir EXCEPT ![m] = [k |-> "cand", id |-> m]]
    /\ UNCHANGED <<up, store, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

Put(m) ==
    /\ up[m] /\ dir[m].k = "cand"
    /\ store = "none"                                                \* @rule genesis-conditional-create.1
    /\ store' = m
    /\ UNCHANGED <<up, dir, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

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
    /\ UNCHANGED <<up, store, rec, crashes, wrote, thin, shrinks, short, shrunk>>

Drop(m) ==
    /\ up[m] /\ dir[m].k = "cand"
    /\ store \notin {"none", m}                                       \* @rule line:drop-after-answer
    /\ dir' = [dir EXCEPT ![m] = NoDir]
    /\ UNCHANGED <<up, store, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

Adopt(m) ==
    /\ up[m]
    /\ m \in Late => \A g \in Groups : open[g] = Share(g)              \* the world: a late machine comes once every group opened
    /\ dir[m].k = "none"                                             \* @rule genesis-conditional-create.6
    /\ store # "none"                                                 \* @rule line:adopt-stored
    /\ dir' = [dir EXCEPT ![m] = [k |-> "known", id |-> store]]      \* @rule genesis-conditional-create.5
    /\ UNCHANGED <<up, store, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

--------------------------------------------------------------------------
(* The pre-split: the other groups *)

\* The home group's leader writes a group record that names the group's
\* first voter.  As the ledger read before V5-38, that is the leader's own
\* process ("creator", way A).  Way B, which the owner took ("quiet"): once
\* enough machines are there, it names the machine that was named for the
\* fewest groups.  "Enough" is Copies; with Fewer # "no" it is Copies, or
\* the resource's machines when it has fewer.
Wait(g) == IF Fewer = "no" THEN Copies ELSE Need(g)                 \* @rule line:record-waits
Named(g, m) == IF FirstVoter = "creator"
            THEN m = lead[0]                                         \* @rule growth.5 record
            ELSE /\ m \in Avail /\ Cardinality(Avail) >= Wait(g)
                 /\ \A q \in Avail : RLoad(m) <= RLoad(q)            \* @rule growth.5

Record(g, m) ==
    /\ g # 0 /\ rec[g] = "none"                                       \* @rule line:record-once
    /\ Works(0)
    /\ Named(g, m)
    /\ rec' = [rec EXCEPT ![g] = m]
    /\ thin' = (thin \/ (FirstVoter = "quiet" /\ Avail # M))
    /\ UNCHANGED <<up, store, dir, has, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, shrinks, short, shrunk>>

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
    /\ UNCHANGED <<up, store, dir, rec, open, crashes, homes, seedn, wrote, thin, shrinks, short, shrunk>>

\* A group whose placement names fewer than Copies machines writes a full
\* one.  It takes the quieter machines.  A new group also names its
\* preferred member here: the machine in the placement that should lead
\* the fewest groups.  With Fewer = "every" a placement names every listed
\* machine while fewer than Copies are listed, and it is written again,
\* keeping the voters, when more machines come.
Quiet(S, C) == \A a \in S, b \in C \ S : Load(a) <= Load(b)          \* @rule healing-self.19
Fewest(p, S, g) == \A q \in S : PLoad(p, g) <= PLoad(q, g)           \* @rule move-policy.6

Place(g, S, p) ==
    /\ Works(g)
    /\ Cardinality(place[g]) < Copies                                \* @rule growth.1
    /\ Cardinality(place[g]) < Size /\ Cardinality(S) = Size - 1      \* @rule growth.1 fewer
    /\ S \subseteq Avail \ {lead[g]}                                 \* @rule healing-self.16
    /\ voters[g] \subseteq S \cup {lead[g]}                           \* @rule line:place-keeps-voters
    /\ Quiet(S \ voters[g], Avail \ ({lead[g]} \cup voters[g]))
    /\ place' = [place EXCEPT ![g] = S \cup {lead[g]}]                \* @rule line:place-leader
    /\ IF PrefByLoad /\ g # 0 /\ FirstVoter = "creator"
       THEN p \in S \cup {lead[g]} /\ Fewest(p, S \cup {lead[g]}, g)
       ELSE p = pref[g]                                              \* @rule handback.5
    /\ pref' = [pref EXCEPT ![g] = p]
    /\ thin' = (thin \/ Avail # M)
    /\ UNCHANGED <<up, store, dir, has, rec, voters, lead, open, crashes, homes, gfound, seedn, wrote, shrinks, short, shrunk>>

\* From one voter straight to all the placed machines, once they are up.
\* With Fewer = "every", from the voters it has to all the placed machines.
Grow(g) ==
    /\ Works(g)
    /\ IF Fewer = "every"
       THEN voters[g] # place[g]                                     \* @rule growth.2 fewer
       ELSE Cardinality(voters[g]) = 1 /\ Cardinality(place[g]) = Copies
    /\ \A m \in place[g] : up[m]                                     \* @rule growth.2
    /\ voters' = [voters EXCEPT ![g] = place[g]]
    /\ has' = [m \in M |-> IF m \in place[g] THEN has[m] \cup {g} ELSE has[m]]
    /\ dir' = [m \in M |-> IF m \in place[g] THEN [k |-> "copy", id |-> dir[m].id] ELSE dir[m]]
    /\ UNCHANGED <<up, store, rec, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

\* A group opens its share of the slots, as the first entry's table gives
\* it, once it has all its voters.  The open carries the seed rows of
\* those slots.  "All its voters": Copies (Fewer = "no"), or Copies or the
\* resource's machines when it has fewer (Fewer # "no", V5-39).
MySlots(g) == Share(g)                                               \* @rule genesis-conditional-create.8 table
Open(g) ==
    /\ Works(g)
    /\ open[g] = {} /\ Share(g) # {}                                  \* @rule line:open-once
    /\ IF Fewer = "no"
       THEN Cardinality(voters[g]) >= Copies                         \* @rule slot-move.22
       ELSE Cardinality(voters[g]) >= Min(Copies, Cardinality(Known(g))) \* @rule slot-move.22 fewer
    /\ open' = [open EXCEPT ![g] = MySlots(g)]
    /\ seedn' = [s \in Slots |-> IF s \in MySlots(g) THEN seedn[s] + 1 ELSE seedn[s]]
    /\ short' = (short \/ Cardinality(voters[g]) < Min(Copies, Cardinality(Avail)))
    /\ shrunk' = (shrunk \/ ((\E h \in Groups : Full(h)) /\ Cardinality(voters[g]) < Copies))
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, lead, crashes, homes, gfound, wrote, thin, shrinks>>

\* Leadership goes to the preferred member, only if it is a voter.
Handback(g) ==
    /\ Works(g)
    /\ pref[g] # lead[g] /\ up[pref[g]]                               \* @rule line:handback-up
    /\ pref[g] \in voters[g]                                         \* @rule handback.2
    /\ lead' = [lead EXCEPT ![g] = pref[g]]                          \* @rule handback.1
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

\* A group whose leader is down elects a voter that is up (Raft, abstract).
Elect(g, m) ==
    /\ lead[g] # "none" /\ ~up[lead[g]]
    /\ m \in voters[g] /\ up[m]
    /\ 2 * Cardinality({v \in voters[g] : up[v]}) > Cardinality(voters[g])
    /\ lead' = [lead EXCEPT ![g] = m]
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

\* A group takes a write only for a slot its log holds open.
Write(s, g) ==
    /\ Works(g)
    /\ s \in open[g]                                                 \* @rule slot-table.1
    /\ g \notin wrote[s]
    /\ wrote' = [wrote EXCEPT ![s] = @ \cup {g}]
    /\ UNCHANGED <<up, store, dir, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, thin, shrinks, short, shrunk>>

--------------------------------------------------------------------------
(* Faults *)

Crash(m) ==
    /\ up[m] /\ crashes < MaxCrash
    /\ up' = [up EXCEPT ![m] = FALSE] /\ crashes' = crashes + 1
    /\ UNCHANGED <<store, dir, has, rec, voters, place, pref, lead, open, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

Start(m) ==
    /\ ~up[m]
    /\ up' = [up EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<store, dir, has, rec, voters, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, shrinks, short, shrunk>>

\* A group shrinks below Copies: a voter that is down, not the leader, is
\* taken out of its config (an operator's removal, say).  Its stored
\* placement still names it.  Only on bounds with MaxShrink > 0.
Shrink(g, m) ==
    /\ shrinks < MaxShrink /\ Works(g)
    /\ m \in voters[g] /\ ~up[m] /\ m # lead[g]
    /\ voters' = [voters EXCEPT ![g] = @ \ {m}]
    /\ shrinks' = shrinks + 1
    /\ UNCHANGED <<up, store, dir, has, rec, place, pref, lead, open, crashes, homes, gfound, seedn, wrote, thin, short, shrunk>>

Calm == \/ \E m \in M : Cand(m) \/ Put(m) \/ First(m) \/ Drop(m) \/ Adopt(m)
        \/ \E g \in Groups : Grow(g) \/ Open(g) \/ Handback(g)
        \/ \E g \in Groups, m \in M : Record(g, m) \/ Make(g, m) \/ Elect(g, m)
        \/ \E g \in Groups, S \in SUBSET M, p \in M : Place(g, S, p)
        \/ \E s \in Slots, g \in Groups : Write(s, g)

Rough == \/ \E m \in M : Crash(m) \/ Start(m)
         \/ \E g \in Groups, m \in M : Shrink(g, m)

Next == Calm \/ Rough

Spec == Init /\ [][Next]_vars

\* The machines are alike: no rule names one.  A bound may check one state
\* per way of naming them (TLC's SYMMETRY), with M as model values.
Sym == Permutations(M)

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

\* With fewer machines than Copies (V5-39), AllVoters cannot hold: a group
\* opens with the machines there.  Two properties take its place:
\* OpenFull: no group opens with fewer voters than Copies, or than the
\* machines that are up and hold the id when they are fewer.
OpenFull == ~short
\* NoShrinkOpen: once some stored placement has named Copies machines, the
\* resource has enough machines, and no group opens with fewer than Copies
\* voters, though a machine is down or a group has shrunk.
NoShrinkOpen == ~shrunk

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

\* Spread, judged only when every machine was there at each placement and
\* group record.  With Fewer # "no" a record may be written before the
\* other machines come, so Spread itself is not a property there.
SpreadAll == ~thin => Spread

\* H7 with more groups than one placement has machines: the preferred
\* members are spread as evenly as they can be.  Judged when every machine
\* was there at each placement.
SpreadEven == (AllFull /\ ~thin) => \A a, b \in M : PLoad(a, G) <= PLoad(b, G) + 1

\* A group is grown: its placement is full; with Fewer # "no", it names
\* Copies machines, or every listed machine when fewer, and all of them are
\* voters.
Grown(g) == IF Fewer = "no" THEN Full(g)
            ELSE Cardinality(place[g]) = Min(Copies, Cardinality(Avail)) /\ voters[g] = place[g]

Done == /\ store # "none"
        /\ \A g \in Groups : open[g] = Share(g) /\ lead[g] = pref[g] /\ Grown(g)
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
\* A group shrank below Copies before it opened: its placement names Copies
\* machines, it has fewer voters, and its slots are not open.
NotShrunkShut == ~(\E g \in Groups : shrinks > 0 /\ Full(g) /\ open[g] = {}
                                     /\ Share(g) # {} /\ Cardinality(voters[g]) = Copies - 1)
\* Founding is done with every machine there, the late ones too: the groups
\* opened before a late machine came and then grew to it.
NotDoneAll == ~(Done /\ \A m \in M : dir[m].k \in {"known", "copy"})
=============================================================================
