// Package entry point: single import site for fero() + value + fileStorage (layers live under fero/internals).

export { fero, value, fileStorage } from './resource/index.ts'
export type { Fero, Cluster, Context, Method, Storage, FeroOpts } from './resource/index.ts'
