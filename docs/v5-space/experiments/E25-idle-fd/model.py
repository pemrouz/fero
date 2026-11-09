#!/usr/bin/env python3
"""E-25 (a): idle frames per second at n = 100 members, per candidate and per failure-detector scheme.

A placement model, not a measurement: groups are placed at random (copies 3, a seeded RNG), leaders spread evenly.
It counts, for an idle cluster (no writes):
  hb      per-group heartbeats: every group's leader sends a heartbeat to each follower every `tick` and gets a reply.
          messages/s = groups x 2 followers x 2 / tick. Frames/s: either one frame per message, or "coalesced"
          (all heartbeats from one member to another in one tick share one frame, as E-11's hosts and CockroachDB's
          coalesced heartbeats do): directed member pairs with at least one leader->follower relation x 2 / tick.
  pings   quiet groups (no group traffic when idle) plus one ping per linked member pair per `ping` in each
          direction. A pair is linked if it shares at least one group (it must notice the other's failure).
  ctrl    sessions to a controller: each member heartbeats the controller every `session` and gets a reply;
          plus, for ISR, Kafka's idle follower fetches: one fetch session per (follower, leader) member pair
          that shares a partition, answered after replica.fetch.wait.max.ms (500 ms) when idle.
  obj     OBJ: no member links; each awake group's leader renews its lease by a conditional PUT every `lease`.
The output is results/model.md. Usage: python3 model.py [seed]
"""
import random, sys, os

N = 100
TICK_MS, PING_MS, SESSION_MS, FETCH_WAIT_MS, LEASE_MS = 500, 500, 500, 500, 2000
KRAFT_HB_MS = 2000  # Kafka KRaft broker.heartbeat.interval.ms default (cited from Kafka's docs, from memory)

# candidate -> (groups per (resources R, projects P), failure detector when idle). SPACE §4.1; resources per project 20.
CANDS = [
    ('MIN, RUST, MIN-TS, LEAN, SRV, EMB-V8, SIDE', lambda R, P: R, 'pings'),
    ('DRAFT', lambda R, P: R, 'pings'),
    ('MIN-P (16 groups per project)', lambda R, P: 16 * P, 'pings'),
    ('CELL (16 cells per resource)', lambda R, P: 16 * R, 'pings'),
    ('LANE (64 lanes per project)', lambda R, P: 64 * P, 'pings'),
    ('SPLIT (1 range per resource at rest)', lambda R, P: R, 'pings'),
    ('RLOG (groups on log members)', lambda R, P: R, 'pings'),
    ('ISR (1 partition per resource)', lambda R, P: R, 'ctrl+fetch'),
    ('SLOG (log groups, sessions to a controller)', lambda R, P: R, 'ctrl'),
    ('OBJ (leases by conditional PUT)', lambda R, P: R, 'obj'),
]


def place(G, rng):
    """random placement of G groups, 3 replicas each, leader = replica 0; returns linked pairs and leader->follower pairs"""
    linked, lf = set(), set()
    for _ in range(G):
        r = rng.sample(range(N), 3)
        for i in range(3):
            for j in range(i + 1, 3):
                a, b = min(r[i], r[j]), max(r[i], r[j])
                linked.add((a, b))
        lf.add((r[0], r[1])); lf.add((r[0], r[2]))
    return linked, lf


def count(G, fd, rng):
    linked, lf = place(min(G, 200000), rng)   # pair sets saturate long before 200,000 groups
    out = {}
    out['hb_msgs'] = G * 2 * 2 * 1000 / TICK_MS
    out['hb_frames_coalesced'] = len(lf) * 2 * 1000 / TICK_MS
    out['hb_frames_100ms_coalesced'] = len(lf) * 2 * 1000 / 100
    out['linked_pairs'] = len(linked)
    if fd == 'pings':
        out['idle_frames'] = len(linked) * 2 * 1000 / PING_MS
    elif fd == 'ctrl':
        out['idle_frames'] = N * 2 * 1000 / SESSION_MS
    elif fd == 'ctrl+fetch':
        fetch_pairs = len(lf)   # (follower, leader) pairs that share a partition
        out['idle_frames'] = N * 2 * 1000 / KRAFT_HB_MS + fetch_pairs * 2 * 1000 / FETCH_WAIT_MS
    elif fd == 'obj':
        out['idle_frames'] = 0
        out['store_puts_s'] = G * 1000 / LEASE_MS
    return out


def main():
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    rng = random.Random(seed)
    L = ['# E-25 (a): idle frames per second at n = 100 (placement model, seed %d)' % seed, '',
         'Settings: n = %d members, copies 3, random placement, leaders spread; tick and ping %d ms; controller session %d ms; '
         'Kafka fetch wait %d ms and KRaft broker heartbeat %d ms; OBJ lease %d ms. Resources per project: 20.' % (N, TICK_MS, SESSION_MS, FETCH_WAIT_MS, KRAFT_HB_MS, LEASE_MS), '',
         '| candidate | resources | groups | idle scheme | idle frames/s, all members | per member (sent) | linked member pairs | without quiet groups: heartbeat messages/s | frames/s coalesced (500 ms tick) | coalesced at a 100 ms tick | object-store PUTs/s |',
         '|---|---|---|---|---|---|---|---|---|---|---|']
    for R in (1000, 10000, 100000):
        P = max(1, R // 20)
        for name, gf, fd in CANDS:
            G = gf(R, P)
            c = count(G, fd, rng)
            L.append('| %s | %d | %d | %s | %s | %s | %d | %s | %s | %s | %s |' % (name, R, G, fd, '{:,.0f}'.format(c['idle_frames']), '{:,.0f}'.format(c['idle_frames'] / N),
                     c['linked_pairs'], '{:,.0f}'.format(c['hb_msgs']), '{:,.0f}'.format(c['hb_frames_coalesced']), '{:,.0f}'.format(c['hb_frames_100ms_coalesced']),
                     '{:,.0f}'.format(c.get('store_puts_s', 0))))
    # the bound: per-pair pings as n grows, and with a bound of k peers per member
    L += ['', '## Per-pair pings as n grows (full mesh, %d ms)' % PING_MS, '', '| n | frames/s, all | per member |', '|---|---|---|']
    for n in (3, 10, 30, 100, 101, 200, 300, 1000):
        f = n * (n - 1) * 1000 / PING_MS
        L.append('| %d | %s | %s |' % (n, '{:,.0f}'.format(f), '{:,.0f}'.format(f / n)))
    L += ['', 'With a bound of k linked peers per member (one more mechanism: placement keeps each member\'s groups within k peers), frames/s = n x k x 2: '
          'k = 32 gives %s at n = 100 and %s at n = 1,000.' % ('{:,.0f}'.format(100 * 32 * 2), '{:,.0f}'.format(1000 * 32 * 2))]
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results'), exist_ok=True)
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results', 'model.md'), 'w').write('\n'.join(L) + '\n')
    print('\n'.join(L))


main()
