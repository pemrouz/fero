// Day 0 demo — side A (the source of truth).
//
// Connects to the replica, wraps some state in $(), and mutates it the way any
// `data` consumer would: assignment, nested assignment, insert, delete. Each
// mutation flows to B as a single change record. Watch B's terminal converge.

import net from 'node:net'
import { $ } from '../../data/index.ts'
import { publish, value } from './replicate.ts'

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5170)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const socket = net.connect(PORT, 'localhost', async () => {
  console.log(`[A] connected to localhost:${PORT}`)

  const sessions = $({ user42: { name: 'P', active: true } })
  const host = publish(sessions, socket) // retain this — dropping it stops replication

  const step = async (label: string, mutate: () => void) => {
    mutate()
    console.log(`[A] ${label}  →  ${JSON.stringify(sessions[value])}`)
    await wait(600)
  }

  await wait(400)
  await step('user99 joins', () => { sessions.user99 = { name: 'Q', active: false } })
  await step('user42 goes inactive', () => { sessions.user42.active = false })
  await step('user42 scores', () => { sessions.user42.score = 10 })
  await step('user99 leaves', () => { delete sessions.user99 })

  console.log('[A] done — holding connection for 500ms')
  void host
  await wait(500)
  socket.end()
})

socket.on('close', () => process.exit(0))
