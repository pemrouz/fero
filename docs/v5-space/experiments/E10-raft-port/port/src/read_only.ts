// Port of go.etcd.io/raft/v3/read_only.go at c51f010.
import type { Message } from './raftpb.ts'
import { type JointConfig, type Index, type AckedIndexer, jointCommittedIndex } from './quorum.ts'

export const ReadOnlySafe = 0
export const ReadOnlyLeaseBased = 1
export type ReadOnlyOption = number

export type ReadState = { Index: number; RequestCtx: Uint8Array | undefined }

export type readIndexRequest = { req: Message; index: number }

function readU64LE(b: Uint8Array): number {
  let x = 0
  for (let i = 7; i >= 0; i--) x = x * 256 + b[i]
  return x
}

export class readOnly implements AckedIndexer {
  option: ReadOnlyOption
  acks = new Map<number, number>()
  unconfirmedReads: readIndexRequest[] = []
  confirmedReads = 0
  constructor(option: ReadOnlyOption) {
    this.option = option
  }
  addRequest(commitIndex: number, req: Message): void {
    this.unconfirmedReads.push({ req, index: commitIndex })
  }
  recvAck(from: number, ctx: Uint8Array | undefined): void {
    if (ctx && ctx.length !== 0) this.acks.set(from, Math.max(this.acks.get(from) ?? 0, readU64LE(ctx)))
  }
  AckedIndex(voterID: number): [Index, boolean] {
    const idx = this.acks.get(voterID)
    return idx === undefined ? [0, false] : [idx, true]
  }
  maybeAdvance(c: JointConfig): readIndexRequest[] {
    const newConfirmedReads = jointCommittedIndex(c, this)
    if (newConfirmedReads <= this.confirmedReads) return []
    const n = newConfirmedReads - this.confirmedReads
    const readStates = this.unconfirmedReads.slice(0, n)
    this.unconfirmedReads = this.unconfirmedReads.slice(n)
    this.confirmedReads = newConfirmedReads
    return readStates
  }
  heartbeatCtx(): Uint8Array | undefined {
    if (this.unconfirmedReads.length === 0) return undefined
    let pos = this.confirmedReads + this.unconfirmedReads.length
    const enc = new Uint8Array(8)
    for (let i = 0; i < 8; i++) {
      enc[i] = pos % 256
      pos = Math.floor(pos / 256)
    }
    return enc
  }
}
