// Copyright 2015 The etcd Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// This file is a Rust port of etcd raft (go.etcd.io/raft/v3) at commit
// c51f010c851edd0dada5af41bafbf68e54617767. See ../NOTICE (or ../../NOTICE).

//! Port of `logger.go`.
//!
//! The logger is injected: the crate does no I/O, so it has no default that
//! writes anywhere, and no global logger (Go's `SetLogger`). Output goes
//! through `core::fmt`: a call site passes `format_args!`.
//!
//! Go's twelve methods come in pairs (`Info(v...)` and `Infof(format, v...)`).
//! With `format_args!` one method per level says both.

use alloc::sync::Arc;
use core::fmt;

pub trait Logger: Send + Sync {
    fn debugf(&self, args: fmt::Arguments<'_>);
    fn errorf(&self, args: fmt::Arguments<'_>);
    fn infof(&self, args: fmt::Arguments<'_>);
    fn warningf(&self, args: fmt::Arguments<'_>);

    /// Go's default logger writes the line and exits the process. A kernel
    /// cannot exit, so the contract here is: log, then panic.
    fn fatalf(&self, args: fmt::Arguments<'_>) -> ! {
        panic!("{}", args)
    }

    /// Logs the line, then panics with it. It never returns: Raft's code
    /// relies on that, as it does in Go.
    fn panicf(&self, args: fmt::Arguments<'_>) -> ! {
        panic!("{}", args)
    }
}

/// How the log, the unstable log and the Raft state machine share one logger.
pub type LoggerRef = Arc<dyn Logger>;

/// Go's `discardLogger`: drops every line. It still panics on `panicf`.
#[derive(Clone, Copy, Debug, Default)]
pub struct DiscardLogger;

impl Logger for DiscardLogger {
    fn debugf(&self, _args: fmt::Arguments<'_>) {}
    fn errorf(&self, _args: fmt::Arguments<'_>) {}
    fn infof(&self, _args: fmt::Arguments<'_>) {}
    fn warningf(&self, _args: fmt::Arguments<'_>) {}
}
