# 30 · Chaos, then audit

Terminal 1, the story, cut to the lines that matter:

```
$ cd examples/30-fleet-audit
$ node fleet.ts
[member 565256] MEMBER 37473 — pid 565256 — life 0b9528c2~1
…
t=0s the fleet is up: members 3
…
t=5s kill -9 member 37473
[sensor 565287] ap-4 issued-unknown 109 ms
…
t=11s members 2: the dead one is voted out
[sensor 565286] us-5 issued-unknown 5223 ms
…
[sensor 565285] eu-7 persisted 3318 ms
…
t=15s members 3: 37473 is back from its disk
…
t=25s kill -9 all three
…
[member 566629] MEMBER 37473 — pid 566629 — life 0b9528c2~3
…
t=25s members 3: all three restored from their disks
…
done eu persisted 58 committed-unproven 0 issued-unknown 1
done us persisted 57 committed-unproven 0 issued-unknown 2
done ap persisted 55 committed-unproven 0 issued-unknown 4
audit convergence ok — rows on the three members: 177 177 177
audit durability ok — 170 persisted facts, 0 missing from a member
audit no phantoms ok — 0 rows no sensor attempted
info 7 unproven facts, 7 of them landed: a reject is not a rollback
info the watcher holds 0 rows no member holds
audit prune ok — 147 facts older than 10 s gone, the members hold 30 30 30
AUDIT ok
```

Terminal 2, the dashboard — one frame, as the vote comes in: `us` and `ap` are behind, their facts waited:

```
$ node dashboard.ts
FLEET 565136 — members 2 — epoch 2 — facts 19 — avg 22.8
{ us: { value: 5 }, ap: { value: 6 }, eu: { value: 8 } }
[
  { region: 'eu', temp: 23.5, at: 1790094810692 },
  { region: 'us', temp: 21.4, at: 1790094810691 },
  { region: 'ap', temp: 22.3, at: 1790094809749 },
  { region: 'eu', temp: 22.6, at: 1790094809691 },
  { region: 'ap', temp: 23.7, at: 1790094808750 },
  { region: 'eu', temp: 23.5, at: 1790094808691 },
  { region: 'eu', temp: 23.4, at: 1790094805691 },
  { region: 'ap', temp: 24.6, at: 1790094804748 }
]
```

- `node fleet.ts` is the story: three `member.ts`, each a fixed address and a disk (`./fleet-<port>`, wiped
  first; 13's rule), three `sensor.ts`, and a clock. `kill -9` is a crash, never a stop: the dead member is
  voted out once its redials give up; the same command brings it back as itself — `~3` is its third life.
- `methods: { record, prune }` is the door: a sensor can only `record` a fact, written by the member and
  awaited until two of three disks hold it; the reply is the rung it reached, one ledger line per fact.
  `us-5 … 5223 ms`: its cell was the dead member's, so it waited for the vote — past the 4 s a proof is
  given; `issued-unknown` says the sensor could prove nothing: that, or a call cut by the kill or by Ctrl-C.
- The audit asks each member itself: `fero('fleet', { hosts: [one address], rendezvous: false })` calls that
  one and nobody else. Unproven is not lost by itself — here all seven landed: a reject is not a rollback,
  and a write shows when it commits (03). The dashboard's folds are built once and redrawn on every change.

```sh
node fleet.ts | grep -v '^\['  # the story alone: the chaos log and the audit, without the roles' echo
node fleet.ts 120              # two minutes: the same chaos in the first half minute, then quiet facts
node sensor.ts sea             # another terminal while fleet.ts runs: no ledger has it, the audit fails
node member.ts 4901            # by hand: 4902 and 4903 too, a sensor.ts, a dashboard.ts — you are the chaos
```

`node check.ts` runs a thirty-second cut of this story and ends with `ok 30-fleet-audit`, in half a minute.
Next: [40 · chat rooms](../40-chat/).
