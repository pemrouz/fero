// wfsync: time one write plus its flush, per operation, with N writer processes
// on N files in one directory. Each child writes raw samples (two u32 per op:
// write+flush ns, flush-only ns) to <out>.<i>.bin. A Python script reads them.
//
// usage: wfsync <dir> <writers> <bs> <seconds> <mode> <layout> <out>
//   mode:   fdatasync | dsync | direct_dsync | direct | none
//   layout: grow   (new empty file, sequential appends: the size changes)
//           falloc (fallocate 1 GiB first: unwritten extents, then overwrite)
//           zero   (write 1 GiB of zeros and fsync first: pure overwrite)
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define SEG (1024L * 1024 * 1024)

static uint64_t now_ns(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000000000ull + t.tv_nsec;
}

static void die(const char *m) { perror(m); exit(1); }

static void child(const char *dir, int i, long bs, int secs, const char *mode, const char *layout,
                  const char *out, uint64_t start_at) {
  char path[4096];
  snprintf(path, sizeof path, "%s/wf.%d", dir, i);
  int flags = O_WRONLY | O_CREAT | O_TRUNC;
  int direct = !strcmp(mode, "direct") || !strcmp(mode, "direct_dsync");
  int dsync = !strcmp(mode, "dsync") || !strcmp(mode, "direct_dsync");
  int fds = !strcmp(mode, "fdatasync");
  // lay the file out with plain flags first, then reopen with the test flags
  int fd = open(path, flags, 0644);
  if (fd < 0) die("open");
  int ring = 0;
  if (!strcmp(layout, "falloc")) {
    if (fallocate(fd, 0, 0, SEG) != 0) die("fallocate");
    fsync(fd);
    ring = 1;
  } else if (!strcmp(layout, "zero")) {
    void *z = calloc(1, 1 << 20);
    for (long o = 0; o < SEG; o += 1 << 20)
      if (write(fd, z, 1 << 20) != 1 << 20) die("zero");
    fsync(fd);
    free(z);
    ring = 1;
  }
  close(fd);
  fd = open(path, O_WRONLY | (direct ? O_DIRECT : 0) | (dsync ? O_DSYNC : 0));
  if (fd < 0) die("reopen");
  void *buf;
  if (posix_memalign(&buf, 4096, bs)) die("memalign");
  memset(buf, 0xab, bs);
  long cap = (long)secs * 200000 + 1000;  // room for 200k ops/s
  uint32_t *s = malloc(sizeof(uint32_t) * 2 * cap);
  long n = 0;
  off_t off = 0;
  if (now_ns() > start_at) fprintf(stderr, "wfsync: writer %d started late\n", i);
  while (now_ns() < start_at) usleep(100);
  uint64_t end = start_at + (uint64_t)secs * 1000000000ull;
  for (;;) {
    uint64_t t0 = now_ns();
    if (t0 >= end || n >= cap) break;
    if (ring && off + bs > SEG) off = 0;
    if (pwrite(fd, buf, bs, off) != bs) die("pwrite");
    off += bs;
    uint64_t t1 = now_ns();
    if (fds && fdatasync(fd) != 0) die("fdatasync");
    uint64_t t2 = now_ns();
    s[2 * n] = (uint32_t)(t2 - t0);
    s[2 * n + 1] = (uint32_t)(t2 - t1);
    n++;
  }
  close(fd);
  unlink(path);
  char op[4096];
  snprintf(op, sizeof op, "%s.%d.bin", out, i);
  FILE *f = fopen(op, "wb");
  if (!f) die("out");
  fwrite(s, sizeof(uint32_t) * 2, n, f);
  fclose(f);
  exit(0);
}

int main(int argc, char **argv) {
  if (argc != 8) {
    fprintf(stderr, "usage: wfsync <dir> <writers> <bs> <seconds> <mode> <layout> <out>\n");
    return 2;
  }
  int w = atoi(argv[2]);
  long bs = atol(argv[3]);
  int secs = atoi(argv[4]);
  // children lay out their files first; the timed part starts together
  uint64_t start_at = now_ns() + (strcmp(argv[6], "zero") ? 300000000ull : 8000000000ull * w);
  for (int i = 0; i < w; i++)
    if (fork() == 0) child(argv[1], i, bs, secs, argv[5], argv[6], argv[7], start_at);
  int st, bad = 0;
  for (int i = 0; i < w; i++) {
    wait(&st);
    if (!WIFEXITED(st) || WEXITSTATUS(st)) bad = 1;
  }
  return bad;
}
