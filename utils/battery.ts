//! ── utils/battery — the test battery's process pins, one import ─────────────────────────────────
// Every suite that composes a real fero() imports this FIRST (and the npm scripts pass it as
// `--import ./utils/battery.ts`), so a single-file `node --test` and the whole battery run under the
// same two pins:
//   FERO_RENDEZVOUS=off — the directory is OFF: an explicit-topology test never meets a live box
//     directory (V4-3). Discovery tests opt in with a free port each.
//   FERO_CONFIG=off — the config layer is OFF (V4-10): fero() reads the call and nothing else — no
//     `--fero.*` flag, no FERO_* variable, no fero.opt.ts in the checkout or in $HOME can reach a
//     test. The layer's own suites inject their sources explicitly (api/config.test.ts) or spawn
//     children with FERO_CONFIG deleted (tests/config.test.ts).
// Plain assignment, not `??=`: the pins must win over whatever the parent shell exports (the old npm
// script forced FERO_RENDEZVOUS=off the same way); a suite that wants a value sets it AFTER this
// import, inside its tests. Children spawned with process.env inherit both (the examples tier), so a
// check.ts and its roles are pinned by the environment alone.

process.env.FERO_RENDEZVOUS = 'off'
process.env.FERO_CONFIG = 'off'
