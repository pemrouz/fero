// Tiny read-only FUSE 3 filesystem: one file /hello with "hello fuse\n". Checks FUSE works here.
#define FUSE_USE_VERSION 31
#include <fuse.h>
#include <string.h>
#include <errno.h>
static const char *msg = "hello fuse\n";
static int fs_getattr(const char *p, struct stat *st, struct fuse_file_info *fi) {
  memset(st, 0, sizeof *st);
  if (!strcmp(p, "/")) { st->st_mode = 0040755; st->st_nlink = 2; return 0; }
  if (!strcmp(p, "/hello")) { st->st_mode = 0100444; st->st_nlink = 1; st->st_size = strlen(msg); return 0; }
  return -ENOENT;
}
static int fs_readdir(const char *p, void *buf, fuse_fill_dir_t fill, off_t off, struct fuse_file_info *fi, enum fuse_readdir_flags fl) {
  if (strcmp(p, "/")) return -ENOENT;
  fill(buf, ".", NULL, 0, 0); fill(buf, "..", NULL, 0, 0); fill(buf, "hello", NULL, 0, 0); return 0;
}
static int fs_read(const char *p, char *buf, size_t n, off_t off, struct fuse_file_info *fi) {
  size_t len = strlen(msg);
  if (strcmp(p, "/hello")) return -ENOENT;
  if ((size_t)off >= len) return 0;
  if (off + n > len) n = len - off;
  memcpy(buf, msg + off, n);
  return n;
}
static const struct fuse_operations ops = { .getattr = fs_getattr, .readdir = fs_readdir, .read = fs_read };
int main(int argc, char **argv) { return fuse_main(argc, argv, &ops, NULL); }
