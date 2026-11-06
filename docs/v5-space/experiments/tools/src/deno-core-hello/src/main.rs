// Smoke test: run JS in a deno_core JsRuntime (V8) and call one Rust op from JS.
use deno_core::{extension, op2, v8, JsRuntime, RuntimeOptions};

#[op2(fast)]
fn op_fero_add(a: u32, b: u32) -> u32 { a + b }

extension!(hello_ext, ops = [op_fero_add]);

fn main() {
    let mut rt = JsRuntime::new(RuntimeOptions { extensions: vec![hello_ext::init()], ..Default::default() });
    let v = rt.execute_script("<smoke>", "Deno.core.ops.op_fero_add(40, 2)").unwrap();
    deno_core::scope!(scope, &mut rt);
    let local = v8::Local::new(scope, v);
    println!("ok deno_core 0.413.0 op_fero_add={}", local.to_rust_string_lossy(scope));
}
