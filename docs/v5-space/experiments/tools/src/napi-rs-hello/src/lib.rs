use napi_derive::napi;

#[napi]
pub fn hello() -> String { "hello from Rust".to_string() }

#[napi]
pub fn sum(a: f64, b: f64) -> f64 { a + b }

/// Sum a Buffer's bytes without copying it (checks the zero-copy path E-03 needs).
#[napi]
pub fn byte_sum(buf: napi::bindgen_prelude::Buffer) -> u32 { buf.iter().map(|&b| b as u32).sum() }
