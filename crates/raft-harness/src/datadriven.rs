// Licensed under the Apache License, Version 2.0.

//! Port of github.com/cockroachdb/datadriven v1.0.3: the file format, the line
//! parser and the byte-for-byte comparison.
//!
//! Only reading is ported. Rewriting files (`-rewrite`) and `subtest` blocks
//! are not: etcd's files do not use subtests, and expected output is never
//! rewritten here.

use std::fmt;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

/// CmdArg contains information about an argument on the directive line. An
/// argument is specified in one of the following forms:
///   - argument
///   - argument=value
///   - argument=(values, ...)
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CmdArg {
    pub key: String,
    pub vals: Vec<String>,
}

impl fmt::Display for CmdArg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.vals.len() {
            0 => write!(f, "{}", self.key),
            1 => write!(f, "{}={}", self.key, self.vals[0]),
            _ => write!(f, "{}=({})", self.key, self.vals.join(", ")),
        }
    }
}

/// What a handler returns when it stops the test. Go's `t.Fatalf`.
pub type Fatal = String;

impl CmdArg {
    fn val(&self, i: usize) -> Result<&str, Fatal> {
        match self.vals.get(i) {
            Some(v) => Ok(v),
            None => Err(format!("cannot scan index {} of key {}", i, self.key)),
        }
    }

    /// `arg.Scan(t, i, &n)` for a `uint64`.
    pub fn scan_u64(&self, i: usize) -> Result<u64, Fatal> {
        raft::gostd::parse_uint(self.val(i)?).map_err(|e| e.to_string())
    }

    /// `arg.Scan(t, i, &n)` for an `int`.
    pub fn scan_i64(&self, i: usize) -> Result<i64, Fatal> {
        parse_int(self.val(i)?)
    }

    /// `arg.Scan(t, i, &b)` for a `bool`.
    pub fn scan_bool(&self, i: usize) -> Result<bool, Fatal> {
        parse_bool(self.val(i)?)
    }

    /// `arg.Scan(t, i, &s)` for a `string`.
    pub fn scan_string(&self, i: usize) -> Result<String, Fatal> {
        Ok(self.val(i)?.to_string())
    }
}

/// Go's `strconv.ParseInt(s, 10, 64)`, with its error text.
pub fn parse_int(s: &str) -> Result<i64, Fatal> {
    let syntax = || format!("strconv.ParseInt: parsing {}: invalid syntax", raft::gostd::Quote(s.as_bytes()));
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(syntax());
    }
    let text = if neg { format!("-{digits}") } else { digits.to_string() };
    text.parse::<i64>()
        .map_err(|_| format!("strconv.ParseInt: parsing {}: value out of range", raft::gostd::Quote(s.as_bytes())))
}

/// Go's `strconv.ParseBool`, with its error text.
pub fn parse_bool(s: &str) -> Result<bool, Fatal> {
    match s {
        "1" | "t" | "T" | "true" | "TRUE" | "True" => Ok(true),
        "0" | "f" | "F" | "false" | "FALSE" | "False" => Ok(false),
        _ => Err(format!("strconv.ParseBool: parsing {}: invalid syntax", raft::gostd::Quote(s.as_bytes()))),
    }
}

/// TestData contains information about one data-driven test case that was
/// parsed from the test file.
#[derive(Clone, Debug, Default)]
pub struct TestData {
    /// Pos is a file:line prefix for the input test file, suitable for
    /// inclusion in logs and error messages.
    pub pos: String,
    /// Cmd is the first string on the directive line (up to the first whitespace).
    pub cmd: String,
    /// CmdArgs contains the k/v arguments to the command.
    pub cmd_args: Vec<CmdArg>,
    /// Input is the text between the first directive line and the ---- separator.
    pub input: String,
    /// Expected is the value below the ---- separator. In most cases,
    /// tests need not check this, and instead return their own actual
    /// output.
    pub expected: String,
}

impl TestData {
    /// HasArg checks whether the CmdArgs array contains an entry for the given key.
    pub fn has_arg(&self, key: &str) -> bool {
        self.arg(key).is_some()
    }

    /// Arg retrieves the first CmdArg matching the given key.
    pub fn arg(&self, key: &str) -> Option<&CmdArg> {
        self.cmd_args.iter().find(|a| a.key == key)
    }

    /// Go's `d.Fatalf`: the message with the position in front.
    pub fn fatalf(&self, msg: &str) -> Fatal {
        format!("{}: {}", self.pos, msg)
    }

    fn scan_one<T>(&self, key: &str, scan: impl Fn(&CmdArg, usize) -> Result<T, Fatal>) -> Result<T, Fatal> {
        let Some(arg) = self.arg(key) else {
            return Err(self.fatalf(&format!("missing argument: {key}")));
        };
        if arg.vals.len() != 1 {
            // Go's scanAllErr: one destination needs exactly one value.
            return Err(format!(
                "{}: {}: failed to scan argument {}: unsupported type for {} (might be easy to add it)",
                self.pos,
                arg.key,
                0,
                raft::gostd::Quote(arg.key.as_bytes())
            ));
        }
        scan(arg, 0).map_err(|e| format!("{}: {}: failed to scan argument {}: {}", self.pos, arg.key, 0, e))
    }

    /// `d.ScanArgs(t, key, &n)` for one `uint64`.
    pub fn scan_args_u64(&self, key: &str) -> Result<u64, Fatal> {
        self.scan_one(key, CmdArg::scan_u64)
    }

    /// `d.ScanArgs(t, key, &n)` for one `int`.
    pub fn scan_args_i64(&self, key: &str) -> Result<i64, Fatal> {
        self.scan_one(key, CmdArg::scan_i64)
    }

    /// `d.ScanArgs(t, key, &b)` for one `bool`.
    pub fn scan_args_bool(&self, key: &str) -> Result<bool, Fatal> {
        self.scan_one(key, CmdArg::scan_bool)
    }

    /// `d.ScanArgs(t, key, &s)` for one `string`.
    pub fn scan_args_string(&self, key: &str) -> Result<String, Fatal> {
        self.scan_one(key, CmdArg::scan_string)
    }
}

/// Go's `strings.TrimSpace`.
pub fn trim_space(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{85}')
}

/// ParseLine parses a datadriven directive line and returns the parsed command
/// and CmdArgs.
///
/// An input directive line is a command optionally followed by a list of
/// arguments. Arguments may or may not have values and are specified with one
/// of the forms:
///   - `<argname>`                            // No values.
///   - `<argname>=<value>`                    // Single value.
///   - `<argname>=(<value1>, <value2>, ...)`  // Multiple values.
///
/// Note that in the last case, we allow the values to contain parens; the
/// parsing will take nesting into account.
pub fn parse_line(line: &str) -> Result<(String, Vec<CmdArg>), String> {
    let orig_line = trim_space(line);
    let mut line = orig_line;
    if line.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    fn err_at(orig_line: &str, line: &str) -> String {
        let column = orig_line.len() - line.len() + 1;
        format!("cannot parse directive at column {column}: {orig_line}")
    }

    // until returns the prefix of line up to (and not including) the first
    // occurrence of any of the given characters, and cuts it off the line.
    fn until<'a>(line: &mut &'a str, chars: &str) -> &'a str {
        let idx = line.find(|c: char| chars.contains(c)).unwrap_or(line.len());
        let res = &line[..idx];
        *line = &line[idx..];
        res
    }

    let cmd = until(&mut line, " ").to_string();
    if cmd.is_empty() {
        return Err(err_at(orig_line, line));
    }
    line = trim_space(line);

    let mut cmd_args = Vec::new();
    while !line.is_empty() {
        let mut arg = CmdArg { key: until(&mut line, " =").to_string(), vals: Vec::new() };
        if arg.key.is_empty() {
            return Err(err_at(orig_line, line));
        }
        if line.starts_with('=') {
            // Skip the '='.
            line = &line[1..];

            if line.is_empty() || line.starts_with(' ') {
                // Empty value.
                arg.vals = vec![String::new()];
            } else if !line.starts_with('(') {
                // Single value.
                let val = until(&mut line, " ");
                arg.vals = vec![val.to_string()];
            } else {
                // Skip the '('.
                let bytes = line.as_bytes();
                let mut pos = 1;
                let mut nest = 1;
                let mut last_val_start = pos;
                // Run through the characters on the line, keeping track of the nesting
                // level. Every time we find a comma at the top nesting level, we add a
                // value. The separators are all ASCII, so walking bytes is safe.
                while nest > 0 {
                    if pos == bytes.len() {
                        // The string ended before we found the final ')'.
                        return Err(err_at(orig_line, line));
                    }
                    let r = bytes[pos];
                    pos += 1;
                    match r {
                        b',' => {
                            if nest == 1 {
                                // Found a top-level comma.
                                arg.vals.push(line[last_val_start..pos - 1].to_string());
                                // Skip any spaces after the comma.
                                while pos < bytes.len() && bytes[pos] == b' ' {
                                    pos += 1;
                                }
                                last_val_start = pos;
                            }
                        }
                        b'(' => nest += 1,
                        b')' => nest -= 1,
                        _ => {}
                    }
                }
                arg.vals.push(line[last_val_start..pos - 1].to_string());
                line = trim_space(&line[pos..]);
            }
        }
        cmd_args.push(arg);
        line = trim_space(line);
    }
    Ok((cmd, cmd_args))
}

/// Reads every directive of a file's text, as Go's `testDataReader.Next`
/// does in a loop.
pub fn read_test_data(text: &str, source_name: &str) -> Result<Vec<TestData>, String> {
    // bufio.Scanner: lines end at \n, a trailing \r is dropped, and a last
    // line without \n still counts.
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    for l in lines.iter_mut() {
        if let Some(s) = l.strip_suffix('\r') {
            *l = s;
        }
    }
    let mut ln = 0usize;
    let mut out = Vec::new();

    macro_rules! scan {
        () => {
            if ln < lines.len() {
                ln += 1;
                Some(lines[ln - 1])
            } else {
                None
            }
        };
    }

    while let Some(raw) = scan!() {
        let mut d = TestData { pos: format!("{source_name}:{ln}"), ..TestData::default() };

        let mut line = trim_space(raw).to_string();
        if line.starts_with('#') {
            // Skip comment lines.
            continue;
        }

        // Support wrapping directive lines using \, for example:
        //   build-scalar \
        //   vars(int)
        while line.ends_with('\\') {
            let Some(next_line) = scan!() else { break };
            line.pop();
            line.push(' ');
            line.push_str(trim_space(next_line));
        }

        let (cmd, cmd_args) = parse_line(&line).map_err(|e| format!("{}: {}", d.pos, e))?;
        if cmd.is_empty() {
            // Nothing to do here.
            continue;
        }
        d.cmd = cmd;
        d.cmd_args = cmd_args;

        let mut buf = String::new();
        let mut separator = false;
        while let Some(l) = scan!() {
            if l == "----" {
                separator = true;
                break;
            }
            buf.push_str(l);
            buf.push('\n');
        }
        d.input = trim_space(&buf).to_string();

        if separator {
            // readExpected
            let mut exp = String::new();
            let mut l = scan!();
            let allow_blank_lines = l == Some("----");

            if allow_blank_lines {
                // Look for two successive lines of "----" before terminating.
                loop {
                    l = scan!();
                    let Some(cur) = l else { break };
                    if cur == "----" {
                        if let Some(l2) = scan!() {
                            if l2 == "----" {
                                // Read the following blank line (if we don't do this, we will
                                // emit an extra blank line when rewriting).
                                if let Some(l3) = scan!() {
                                    if !l3.is_empty() {
                                        return Err(format!(
                                            "{}: non-blank line after end of double ---- separator section",
                                            d.pos
                                        ));
                                    }
                                }
                                break;
                            }
                            exp.push_str(cur);
                            exp.push('\n');
                            exp.push_str(l2);
                            exp.push('\n');
                            continue;
                        }
                    }
                    exp.push_str(cur);
                    exp.push('\n');
                }
            } else {
                // Terminate on first blank line.
                while let Some(cur) = l {
                    if trim_space(cur).is_empty() {
                        break;
                    }
                    exp.push_str(cur);
                    exp.push('\n');
                    l = scan!();
                }
            }
            d.expected = exp;
        }
        out.push(d);
    }
    Ok(out)
}

/// Why a file failed.
#[derive(Clone, Debug)]
pub struct Failure {
    /// file:line of the directive that failed.
    pub pos: String,
    pub cmd: String,
    pub expected: String,
    pub actual: String,
    /// Set when the handler stopped the test or panicked, or when the file
    /// could not be read. Empty for a plain output mismatch.
    pub error: String,
}

/// The outcome of one file.
#[derive(Clone, Debug)]
pub struct FileResult {
    pub file: String,
    /// Directives in the file.
    pub directives: usize,
    /// Directives that matched before the first mismatch.
    pub passed: usize,
    pub failure: Option<Failure>,
}

impl FileResult {
    pub fn ok(&self) -> bool {
        self.failure.is_none()
    }
}

/// RunTest invokes a data-driven test on one file. The handler gets each
/// directive and returns the actual output, or a fatal message.
///
/// As in Go, the first mismatch ends the file. The output must equal the
/// expected text byte for byte.
pub fn run_test(path: &Path, source_name: &str, mut f: impl FnMut(&TestData) -> Result<String, Fatal>) -> FileResult {
    let mut res = FileResult { file: source_name.to_string(), directives: 0, passed: 0, failure: None };
    let fail = |pos: &str, error: String| Failure {
        pos: pos.to_string(),
        cmd: String::new(),
        expected: String::new(),
        actual: String::new(),
        error,
    };
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            res.failure = Some(fail(source_name, format!("cannot read the file: {e}")));
            return res;
        }
    };
    let directives = match read_test_data(&text, source_name) {
        Ok(d) => d,
        Err(e) => {
            res.failure = Some(fail(source_name, e));
            return res;
        }
    };
    res.directives = directives.len();
    for d in &directives {
        let got = catch_unwind(AssertUnwindSafe(|| f(d)));
        let mut actual = match got {
            Ok(Ok(a)) => a,
            Ok(Err(fatal)) => {
                res.failure = Some(Failure { cmd: d.cmd.clone(), expected: d.expected.clone(), ..fail(&d.pos, fatal) });
                return res;
            }
            Err(p) => {
                let msg = if let Some(s) = p.downcast_ref::<&str>() {
                    (*s).to_string()
                } else if let Some(s) = p.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic".to_string()
                };
                res.failure = Some(Failure {
                    cmd: d.cmd.clone(),
                    expected: d.expected.clone(),
                    ..fail(&d.pos, format!("panic: {msg}"))
                });
                return res;
            }
        };
        if !actual.is_empty() && !actual.ends_with('\n') {
            actual.push('\n');
        }
        if d.expected != actual {
            res.failure = Some(Failure {
                pos: d.pos.clone(),
                cmd: d.cmd.clone(),
                expected: d.expected.clone(),
                actual,
                error: String::new(),
            });
            return res;
        }
        res.passed += 1;
    }
    res
}

/// Walk lists the files of a directory, sorted by name. Go's
/// `datadriven.Walk` visits them in this order. Hidden files and files that
/// are not `.txt` are skipped (the vendored tree keeps notes next to them).
pub fn walk(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let p = entry?.path();
        if p.is_file() && p.extension().is_some_and(|e| e == "txt") {
            files.push(p);
        }
    }
    files.sort();
    Ok(files)
}
