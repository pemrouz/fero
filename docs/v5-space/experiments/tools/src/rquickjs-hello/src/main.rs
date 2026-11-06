// Smoke test: evaluate JS inside QuickJS from Rust.
use rquickjs::{Context, Runtime};
fn main() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    ctx.with(|ctx| {
        let v: i32 = ctx.eval("[1,2,3].reduce((a,b)=>a+b, 0) * 7").unwrap();
        println!("ok rquickjs 0.14.0 eval={}", v);
    });
}
