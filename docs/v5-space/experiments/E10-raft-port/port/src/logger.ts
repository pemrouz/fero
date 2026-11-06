// Port of go.etcd.io/raft/v3/logger.go at c51f010. Panic and Fatal throw.
import { sprintf, sprint } from './gofmt.ts'

export interface Logger {
  Debug(...v: unknown[]): void
  Debugf(format: string, ...v: unknown[]): void
  Error(...v: unknown[]): void
  Errorf(format: string, ...v: unknown[]): void
  Info(...v: unknown[]): void
  Infof(format: string, ...v: unknown[]): void
  Warning(...v: unknown[]): void
  Warningf(format: string, ...v: unknown[]): void
  Fatal(...v: unknown[]): never
  Fatalf(format: string, ...v: unknown[]): never
  Panic(...v: unknown[]): never
  Panicf(format: string, ...v: unknown[]): never
}

export class RaftPanic extends Error {}

export class DefaultLogger implements Logger {
  debug = false
  out: (line: string) => void
  constructor(out: (line: string) => void) { this.out = out }
  EnableDebug(): void { this.debug = true }
  private header(lvl: string, msg: string): void { this.out(`raft ${lvl}: ${msg}`) }
  Debug(...v: unknown[]): void { if (this.debug) this.header('DEBUG', sprint(...v)) }
  Debugf(f: string, ...v: unknown[]): void { if (this.debug) this.header('DEBUG', sprintf(f, ...v)) }
  Info(...v: unknown[]): void { this.header('INFO', sprint(...v)) }
  Infof(f: string, ...v: unknown[]): void { this.header('INFO', sprintf(f, ...v)) }
  Error(...v: unknown[]): void { this.header('ERROR', sprint(...v)) }
  Errorf(f: string, ...v: unknown[]): void { this.header('ERROR', sprintf(f, ...v)) }
  Warning(...v: unknown[]): void { this.header('WARN', sprint(...v)) }
  Warningf(f: string, ...v: unknown[]): void { this.header('WARN', sprintf(f, ...v)) }
  Fatal(...v: unknown[]): never { this.header('FATAL', sprint(...v)); throw new RaftPanic(sprint(...v)) }
  Fatalf(f: string, ...v: unknown[]): never { this.header('FATAL', sprintf(f, ...v)); throw new RaftPanic(sprintf(f, ...v)) }
  Panic(...v: unknown[]): never { throw new RaftPanic(sprint(...v)) }
  Panicf(f: string, ...v: unknown[]): never { throw new RaftPanic(sprintf(f, ...v)) }
}

export const defaultLogger = new DefaultLogger(line => process.stderr.write(line + '\n'))
export const discardLogger = new DefaultLogger(() => {})
let raftLogger: Logger = defaultLogger

export function SetLogger(l: Logger): void { raftLogger = l }
export function ResetDefaultLogger(): void { SetLogger(defaultLogger) }
export function getLogger(): Logger { return raftLogger }
