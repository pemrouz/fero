// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! The few pieces of Go's standard library that the port needs and that Rust's
//! `core` does not give in the same shape: a text error (`errors.New`,
//! `fmt.Errorf`), `strconv.ParseUint` with Go's error text, and
//! `strconv.Quote` (the `%q` verb).

use alloc::string::String;
use core::fmt;

/// A text error. Go's `errors.New(msg)` and `fmt.Errorf(...)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl Error {
    /// Go's `errors.New`.
    #[must_use]
    pub fn new(msg: &str) -> Error {
        Error(String::from(msg))
    }

    /// Go's `fmt.Errorf`, given `format_args!`.
    #[must_use]
    pub fn errorf(args: fmt::Arguments<'_>) -> Error {
        Error(alloc::fmt::format(args))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Go's `strconv.ParseUint(s, 10, 64)`, with the same error text.
pub fn parse_uint(s: &str) -> Result<u64, Error> {
    let syntax = || Error::errorf(format_args!("strconv.ParseUint: parsing {}: invalid syntax", Quote(s.as_bytes())));
    if s.is_empty() {
        return Err(syntax());
    }
    let mut n: u64 = 0;
    let mut range = false;
    for b in s.bytes() {
        if !b.is_ascii_digit() {
            return Err(syntax());
        }
        if !range {
            match n.checked_mul(10).and_then(|v| v.checked_add(u64::from(b - b'0'))) {
                Some(v) => n = v,
                None => range = true,
            }
        }
    }
    if range {
        return Err(Error::errorf(format_args!(
            "strconv.ParseUint: parsing {}: value out of range",
            Quote(s.as_bytes())
        )));
    }
    Ok(n)
}

/// Shows bytes the way Go's `%q` verb (`strconv.Quote`) does.
///
/// ASCII is exact. A valid multi-byte UTF-8 character is kept as it is, which
/// matches Go for every printable character; Go would escape the rare
/// non-printable ones (`\u....`), this does not. A byte that is not valid
/// UTF-8 is written as `\x..`, as in Go.
#[derive(Clone, Copy, Debug)]
pub struct Quote<'a>(pub &'a [u8]);

impl fmt::Display for Quote<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use fmt::Write;
        const HEX: &[u8; 16] = b"0123456789abcdef";
        f.write_char('"')?;
        let mut rest = self.0;
        while !rest.is_empty() {
            let b = rest[0];
            if b < 0x80 {
                match b {
                    b'"' => f.write_str("\\\"")?,
                    b'\\' => f.write_str("\\\\")?,
                    0x20..=0x7e => f.write_char(char::from(b))?,
                    0x07 => f.write_str("\\a")?,
                    0x08 => f.write_str("\\b")?,
                    0x0c => f.write_str("\\f")?,
                    b'\n' => f.write_str("\\n")?,
                    b'\r' => f.write_str("\\r")?,
                    b'\t' => f.write_str("\\t")?,
                    0x0b => f.write_str("\\v")?,
                    _ => {
                        f.write_str("\\x")?;
                        f.write_char(char::from(HEX[crate::num::ix(u64::from(b >> 4))]))?;
                        f.write_char(char::from(HEX[crate::num::ix(u64::from(b & 15))]))?;
                    }
                }
                rest = &rest[1..];
                continue;
            }
            // A multi-byte character: at most four bytes.
            let mut taken = false;
            for n in 2..=4 {
                if rest.len() < n {
                    break;
                }
                if let Ok(s) = core::str::from_utf8(&rest[..n]) {
                    f.write_str(s)?;
                    rest = &rest[n..];
                    taken = true;
                    break;
                }
            }
            if !taken {
                f.write_str("\\x")?;
                f.write_char(char::from(HEX[crate::num::ix(u64::from(b >> 4))]))?;
                f.write_char(char::from(HEX[crate::num::ix(u64::from(b & 15))]))?;
                rest = &rest[1..];
            }
        }
        f.write_char('"')
    }
}
