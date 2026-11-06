// Minimal N-API addon: exports hello() -> "hello from C" and add(a,b).
#include <node_api.h>
static napi_value Hello(napi_env env, napi_callback_info info) {
  napi_value s; napi_create_string_utf8(env, "hello from C", NAPI_AUTO_LENGTH, &s); return s;
}
static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; double a, b; napi_value r;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_get_value_double(env, argv[0], &a); napi_get_value_double(env, argv[1], &b);
  napi_create_double(env, a + b, &r); return r;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value f;
  napi_create_function(env, "hello", NAPI_AUTO_LENGTH, Hello, NULL, &f); napi_set_named_property(env, exports, "hello", f);
  napi_create_function(env, "add", NAPI_AUTO_LENGTH, Add, NULL, &f); napi_set_named_property(env, exports, "add", f);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
