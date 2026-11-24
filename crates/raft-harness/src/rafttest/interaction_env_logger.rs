// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_logger.go`.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

pub(crate) const LVL_NAMES: [&str; 6] = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL", "NONE"];

#[derive(Debug, Default)]
struct Inner {
    builder: String,
    lvl: usize, // 0 = DEBUG, 1 = INFO, 2 = WARNING, 3 = ERROR, 4 = FATAL, 5 = NONE
}

/// Go's `RedirectLogger`: a `strings.Builder` and a level.
///
/// In Go the environment and every node hold a pointer to the one logger.
/// Here a clone is a handle to the same buffer. The raft crate wants a
/// logger that can cross threads, so the buffer sits behind a mutex.
#[derive(Clone, Debug, Default)]
pub struct RedirectLogger {
    inner: Arc<Mutex<Inner>>,
}

impl RedirectLogger {
    pub fn new() -> RedirectLogger {
        RedirectLogger::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic in a handler fails the file; the buffer is still fine to read.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn printf(&self, lvl: usize, args: fmt::Arguments<'_>) {
        if self.lvl() <= lvl {
            self.write_string(LVL_NAMES[lvl]);
            self.write_string(" ");
            let text = args.to_string();
            self.write_string(&text);
            // Go looks at the end of the format string. The format strings of
            // the raft crate take no argument at their very end that could
            // end in a newline, so the end of the text says the same.
            if !text.is_empty() && !text.ends_with('\n') {
                self.write_string("\n");
            }
        }
    }

    /// The level. Go's `Lvl` field.
    pub fn lvl(&self) -> usize {
        self.lock().lvl
    }

    pub fn set_lvl(&self, lvl: usize) {
        self.lock().lvl = lvl;
    }

    pub fn quiet(&self) -> bool {
        self.lvl() == LVL_NAMES.len() - 1
    }

    /// Go's `WriteString` (and `Write`, `WriteByte`, `WriteRune`): nothing
    /// is written while the logger is quiet.
    pub fn write_string(&self, s: &str) {
        if self.quiet() {
            return;
        }
        self.lock().builder.push_str(s);
    }

    /// Writes to the builder itself, as Go's `env.Output.Builder.WriteString`
    /// does: the quiet check does not apply.
    pub(crate) fn builder_write_string(&self, s: &str) {
        self.lock().builder.push_str(s);
    }

    /// Go's `env.Output.Builder = ...`: puts a new builder in, hands the old
    /// one back.
    pub(crate) fn swap_builder(&self, new: String) -> String {
        std::mem::replace(&mut self.lock().builder, new)
    }

    /// The builder's `Reset`.
    pub fn reset(&self) {
        self.lock().builder.clear();
    }

    /// The builder's `Len`.
    pub fn len(&self) -> usize {
        self.lock().builder.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The builder's `String`.
    pub fn string(&self) -> String {
        self.lock().builder.clone()
    }
}

impl raft::Logger for RedirectLogger {
    fn debugf(&self, args: fmt::Arguments<'_>) {
        self.printf(0, args);
    }

    fn infof(&self, args: fmt::Arguments<'_>) {
        self.printf(1, args);
    }

    fn warningf(&self, args: fmt::Arguments<'_>) {
        self.printf(2, args);
    }

    fn errorf(&self, args: fmt::Arguments<'_>) {
        self.printf(3, args);
    }

    fn fatalf(&self, args: fmt::Arguments<'_>) -> ! {
        self.printf(4, args);
        panic!("{}", args)
    }

    fn panicf(&self, args: fmt::Arguments<'_>) -> ! {
        self.printf(4, args);
        // TODO(pavelkalinnikov): catch the panic gracefully in datadriven package.
        // This would allow observing all the intermediate logging while debugging,
        // and testing the cases when panic is expected.
        panic!("{}", args)
    }
}
