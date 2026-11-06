// lib — the L5 libraries (API.md §3), each built only from what ../../proto/index.ts exports (the
// verbs and fero()), plus one shim for the write option L4 lacks (ids.ts, API-NOTES D3). Timers are
// plain setTimeout; under a world, ../timers.ts (fero test's fake timers) makes them virtual.
export { queue, type Queue, type Msg, type QueueOpts } from './queue.ts'
export { lock, type Lock, type LockOpts } from './lock.ts'
export { group, derive, SHARES, type Group } from './group.ts'
export { saga, type Step } from './saga.ts'
export { limiter, service, migrate, tape } from './small.ts'
