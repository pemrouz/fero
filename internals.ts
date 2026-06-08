//! Power-user escape hatch: re-export L0/L1 building blocks + wire codec, each independently usable.
// The power-user escape hatch: `import { transport, log, view } from 'fero/internals'`.
//
// Each layer is independently usable. A project that wants a bare append-only
// log, the log→$() projection, or a custom transport — without the fero() verb
// wrapper — imports the building blocks here instead of forking. The wire codec
// is exposed too, for anyone implementing an alternative transport against the
// same change-record frames.

//! L0 — transport
export { transport } from './transport/index.ts'
export type { Mesh, TransportOpts } from './transport/index.ts'
export {
  VERB,
  partitionOf,
  encodeFrame,
  encodeFrames,
  decodeFrame,
  Framer,
  Frame,
  RecordView,
} from './transport/message.ts'
export type { ChangeRecord } from './transport/message.ts'

//! L1 — log + view
export { log, view, distribute, applyRecord, Log } from './log/index.ts'
export { originKey } from './log/log.ts'
export type { DistributeOpts } from './log/index.ts'
export type { LogOpts, AppendListener } from './log/log.ts'
