// E-02's emulated disk for Node: fsyncDelay(fd, us, cb) runs fdatasync(fd) and then sleeps
// `us` microseconds on libuv's thread pool (the same path as fs.fdatasync), then calls cb(errno).
// Used only in the tmpfs variant, where fdatasync is free and the sleep stands in for a disk.
#define _GNU_SOURCE
#include <errno.h>
#include <node_api.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

typedef struct { napi_async_work w; napi_ref cb; int fd; int64_t us; int err; } job_t;

static void exec_job(napi_env env, void *d) {
  job_t *j = d;
  prctl(PR_SET_TIMERSLACK, 1000UL);  // 1 µs slack, as in the Rust and Go disk threads
  if (fdatasync(j->fd) != 0) j->err = errno;
  if (j->us > 0) {
    struct timespec ts = { j->us / 1000000, (j->us % 1000000) * 1000 };
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
  }
}

static void done_job(napi_env env, napi_status st, void *d) {
  job_t *j = d;
  napi_value cb, undef, arg;
  napi_get_reference_value(env, j->cb, &cb);
  napi_get_undefined(env, &undef);
  napi_create_int32(env, j->err, &arg);
  napi_call_function(env, undef, cb, 1, &arg, NULL);
  napi_delete_reference(env, j->cb);
  napi_delete_async_work(env, j->w);
  free(j);
}

static napi_value fsync_delay(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value a[3], name;
  napi_get_cb_info(env, info, &argc, a, NULL, NULL);
  job_t *j = calloc(1, sizeof *j);
  int32_t fd; int64_t us;
  napi_get_value_int32(env, a[0], &fd);
  napi_get_value_int64(env, a[1], &us);
  j->fd = fd; j->us = us;
  napi_create_reference(env, a[2], 1, &j->cb);
  napi_create_string_utf8(env, "fsyncDelay", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, exec_job, done_job, j, &j->w);
  napi_queue_async_work(env, j->w);
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "fsyncDelay", NAPI_AUTO_LENGTH, fsync_delay, NULL, &fn);
  napi_set_named_property(env, exports, "fsyncDelay", fn);
  return exports;
}
