// The public surface of the TS port of etcd raft (c51f010), for hosts such as E-11.
export {
  Config, raft, None, LocalAppendThread, LocalApplyThread, StateFollower, StateCandidate, StateLeader,
  StatePreCandidate, stateTypeString, ErrProposalDropped, globalRand, ReadOnlySafe, ReadOnlyLeaseBased,
  setRandomizedElectionTimeout,
} from './raft.ts'
export { RawNode, NewRawNode, ErrStepLocalMsg, ErrStepPeerNotFound, type Peer } from './rawnode.ts'
export { Ready, SoftState, IsEmptyHardState, IsEmptySnap, SnapshotFinish, SnapshotFailure } from './node.ts'
export { MemoryStorage, ErrCompacted, ErrUnavailable, ErrSnapOutOfDate, ErrSnapshotTemporarilyUnavailable, type Storage } from './storage.ts'
export * as pb from './raftpb.ts'
export { DescribeMessage, DescribeReady, DescribeEntry, IsLocalMsg, IsLocalMsgTarget, IsResponseMsg } from './util.ts'
export { type Logger, SetLogger, getLogger, defaultLogger, discardLogger, DefaultLogger } from './logger.ts'
export { type Status, type BasicStatus } from './status.ts'
