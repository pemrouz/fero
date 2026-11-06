// Port of confchange/datadriven_test.go at c51f010.
import { Changer, type Result } from '../src/confchange.ts'
import { ProgressTracker, progressMapString } from '../src/tracker.ts'
import {
  ConfChangeSingle, ConfChangeAddNode, ConfChangeAddLearnerNode, ConfChangeRemoveNode, ConfChangeUpdateNode,
} from '../src/raftpb.ts'
import { type TestData, scanBool } from './datadriven.ts'

export function newConfChangeHandler(): (d: TestData) => string {
  const tr = new ProgressTracker(10, 0)
  const c = new Changer(tr, 0)
  return (d: TestData): string => {
    try {
      const ccs: ConfChangeSingle[] = []
      let toks = d.Input.trim().split(' ')
      if (toks[0] === '') toks = []
      for (const tok of toks) {
        if (tok.length < 2) return `unknown token ${tok}`
        const cc = new ConfChangeSingle()
        switch (tok[0]) {
          case 'v': cc.Type = ConfChangeAddNode; break
          case 'l': cc.Type = ConfChangeAddLearnerNode; break
          case 'r': cc.Type = ConfChangeRemoveNode; break
          case 'u': cc.Type = ConfChangeUpdateNode; break
          default: return `unknown input: ${tok}`
        }
        if (!/^\d+$/.test(tok.slice(1))) return `strconv.ParseUint: parsing "${tok.slice(1)}": invalid syntax`
        cc.NodeId = Number(tok.slice(1))
        ccs.push(cc)
      }
      let res: Result
      switch (d.Cmd) {
        case 'simple': res = c.Simple(...ccs); break
        case 'enter-joint': {
          let autoLeave = false
          if (d.CmdArgs.length > 0) {
            const a = d.Arg('autoleave')
            if (!a) throw new Error('missing argument: autoleave')
            autoLeave = scanBool(a, 0)
          }
          res = c.EnterJoint(autoLeave, ...ccs)
          break
        }
        case 'leave-joint':
          if (ccs.length > 0) res = [c.Tracker.Config, null, new Error('this command takes no input')]
          else res = c.LeaveJoint()
          break
        default: return 'unknown command'
      }
      const [cfg, trk, err] = res
      if (err) return err.message + '\n'
      c.Tracker.Config = cfg
      c.Tracker.Progress = trk!
      return `${c.Tracker.Config.String()}\n${progressMapString(c.Tracker.Progress)}`
    } finally {
      c.LastIndex++
    }
  }
}
