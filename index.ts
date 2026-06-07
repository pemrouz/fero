// The public entry point: `import { fero, value } from 'fero'`.
//
// The whole user-facing surface is one call — fero(name, opts) → { data,
// methods, cluster, destroy } (see plan.md §1). This file is the canonical home
// for `value` (re-exported from `data`) and `fileStorage`, so the package has a
// single import site instead of a deep relative path into resource/index.ts.
//
// Power users who want the layers without the fero() verb wrapper (a bare log, a
// custom transport) reach for `fero/internals` — see ./internals.ts.

export { fero, value, fileStorage } from './resource/index.ts'
export type { Fero, Cluster, Context, Method, Storage, FeroOpts } from './resource/index.ts'
