/* E-18 placement kernels. Plain C, standard library only, our own code.
 * Called from kern.py through ctypes. Every function here has a slow pure-Python
 * twin in kern.py; selftest.py checks that both give the same answer.
 *
 * Words: an "item" is a slot (or, for the key-level reference, a partition);
 * w[i] is its load (writes a second, any unit); a "group" is one writer.
 */
#include <stdlib.h>
#include <string.h>

#ifndef EPS
#define EPS 1e-9   /* the margin a move must win by, as a share of the floor */
#endif

/* ---- a min-heap of groups by (load, index): ties go to the lower index ---- */
typedef struct { double load; int idx; } He;

static int he_less(const He *a, const He *b) {
  return a->load < b->load || (a->load == b->load && a->idx < b->idx);
}

static void sift_down(He *h, int n, int i) {
  for (;;) {
    int l = 2 * i + 1, r = l + 1, m = i;
    if (l < n && he_less(&h[l], &h[m])) m = l;
    if (r < n && he_less(&h[r], &h[m])) m = r;
    if (m == i) return;
    He t = h[i]; h[i] = h[m]; h[m] = t; i = m;
  }
}

/* Greedy packing (LPT: largest item first, each to the least loaded group).
 * w must be sorted from largest to smallest. Writes each group's load to
 * loads[G] and, when assign is not NULL, each item's group to assign[n].
 * Returns the largest group load. */
double lpt(const double *w, long n, int G, double *loads, int *assign) {
  He *h = malloc(sizeof(He) * G);
  for (int g = 0; g < G; g++) { h[g].load = 0; h[g].idx = g; }
  for (long i = 0; i < n; i++) {
    h[0].load += w[i];
    if (assign) assign[i] = h[0].idx;
    sift_down(h, G, 0);
  }
  double mx = 0;
  for (int g = 0; g < G; g++) {
    loads[h[g].idx] = h[g].load;
    if (h[g].load > mx) mx = h[g].load;
  }
  free(h);
  return mx;
}

/* How many groups a left-to-right fill needs when no group may pass cap. */
static long fill_count(const double *w, long n, double cap) {
  long groups = 1; double cur = 0;
  for (long i = 0; i < n; i++) {
    if (w[i] > cap) return n + 1;
    if (cur + w[i] > cap) { groups++; cur = w[i]; } else cur += w[i];
  }
  return groups;
}

/* Best contiguous ranges: the smallest cap such that the items, in their given
 * order, cut into at most G runs, each run's load <= cap. Bisection on cap;
 * returns a cap within a relative 1e-12 of the true optimum (from above). */
double best_contig(const double *w, long n, int G) {
  double total = 0, mx = 0;
  for (long i = 0; i < n; i++) { total += w[i]; if (w[i] > mx) mx = w[i]; }
  double lo = total / G; if (mx > lo) lo = mx;
  double hi = total / G + mx;            /* a left-to-right fill at this cap uses <= G runs */
  if (fill_count(w, n, lo) <= G) return lo;
  for (int it = 0; it < 200 && hi - lo > 1e-12 * hi; it++) {
    double mid = 0.5 * (lo + hi);
    if (fill_count(w, n, mid) <= G) hi = mid; else lo = mid;
  }
  return hi;
}

/* Water level: the even share of the groups once every item larger than the
 * share sits alone in a group of its own. With no such item it is total/G. */
static double water_level(const double *w, long n, int G, double total) {
  double level = total / G;
  for (int it = 0; it < 64; it++) {
    double big = 0; long nb = 0;
    for (long i = 0; i < n; i++) if (w[i] > level) { big += w[i]; nb++; }
    if (nb >= G) return level;
    double nl = (total - big) / (G - nb);
    if (nl == level) return level;
    level = nl;
  }
  return level;
}

/* One move at a time (the controller). assign[n] holds each item's group in
 * 0..G-1 and is updated in place. Each step takes the most loaded group a and
 * the least loaded group b among the groups not yet "pinned" (ties to the
 * lower index) and moves the one item x of a with 0 < w[x] < load[a] - load[b]
 * whose load is nearest half the gap (ties to the lower item index). That move
 * always lowers the sum of squared loads, so the loop ends. If no item of a
 * qualifies (a lone hot slot, say), a is pinned: no single move can lower it,
 * and the controller goes on balancing the others. With level = water_level()
 * and floor = max(level, largest item), it stops when
 *   load[a] <= tau * floor and load[b] >= (2 - tau) * level   (reached = 1),
 *   fewer than two groups are left unpinned (reached = 0: "stuck"), or
 *   moves == maxmoves        (reached = -1).
 * rows[n] is each item's data size; out[0] = moves, out[1] = rows moved,
 * out[2] = final largest load, out[3] = reached, out[4] = level, out[5] = floor,
 * out[6] = final smallest load, out[7] = pinned groups. */
void rebalance(const double *w, const double *rows, long n, int G, int *assign,
               double tau, long maxmoves, double *out) {
  double *load = calloc(G, sizeof(double));
  char *pinned = calloc(G, 1);
  long *head = malloc(sizeof(long) * G);
  long *nxt = malloc(sizeof(long) * n), *prv = malloc(sizeof(long) * n);
  double total = 0, mxw = 0;
  for (int g = 0; g < G; g++) head[g] = -1;
  for (long i = n - 1; i >= 0; i--) {     /* lists in increasing item index */
    int g = assign[i];
    load[g] += w[i]; total += w[i]; if (w[i] > mxw) mxw = w[i];
    nxt[i] = head[g]; prv[i] = -1;
    if (head[g] >= 0) prv[head[g]] = i;
    head[g] = i;
  }
  double level = water_level(w, n, G, total);
  double floor_ = level; if (mxw > floor_) floor_ = mxw;
  long moves = 0; double rmoved = 0; int reached = 0, npinned = 0;
  for (;;) {
    int a = -1, b = -1;
    for (int g = 0; g < G; g++) {
      if (pinned[g]) continue;
      if (a < 0 || load[g] > load[a]) a = g;
      if (b < 0 || load[g] < load[b]) b = g;
    }
    if (a < 0) { reached = 0; break; }
    if (load[a] <= tau * floor_ && load[b] >= (2 - tau) * level) { reached = 1; break; }
    if (moves >= maxmoves) { reached = -1; break; }
    if (a == b) { reached = 0; break; }
    /* a move must beat the gap by a margin: with exact ties (equal pieces)
     * rounding can make w == gap look smaller, and the item would then swap
     * back and forth for ever */
    double gap = load[a] - load[b], half = gap / 2, lim = gap - EPS * floor_;
    long best = -1; double bd = 0;
    for (long i = head[a]; i >= 0; i = nxt[i]) {
      if (w[i] > 0 && w[i] < lim) {
        double d = w[i] > half ? w[i] - half : half - w[i];
        if (best < 0 || d < bd) { best = i; bd = d; }
      }
    }
    if (best < 0) { pinned[a] = 1; npinned++; continue; }
    /* unlink from a, link into b keeping increasing index order */
    if (prv[best] >= 0) nxt[prv[best]] = nxt[best]; else head[a] = nxt[best];
    if (nxt[best] >= 0) prv[nxt[best]] = prv[best];
    long p = -1, q = head[b];
    while (q >= 0 && q < best) { p = q; q = nxt[q]; }
    prv[best] = p; nxt[best] = q;
    if (p >= 0) nxt[p] = best; else head[b] = best;
    if (q >= 0) prv[q] = best;
    assign[best] = b;
    load[a] -= w[best]; load[b] += w[best];
    moves++; rmoved += rows[best];
  }
  double mx = 0, mn = load[0];
  for (int g = 0; g < G; g++) { if (load[g] > mx) mx = load[g]; if (load[g] < mn) mn = load[g]; }
  out[0] = (double)moves; out[1] = rmoved; out[2] = mx; out[3] = (double)reached;
  out[4] = level; out[5] = floor_; out[6] = mn; out[7] = (double)npinned;
  free(load); free(pinned); free(head); free(nxt); free(prv);
}
