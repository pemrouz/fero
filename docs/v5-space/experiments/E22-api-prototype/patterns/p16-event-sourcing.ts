// P-16 event sourcing, CQRS, as API.md §7 writes it, with `server: true` (C1). The live projection
// and the rebuild are two functions; a rebuild reads until it has seen `n` facts (C10).
import { fero } from '../proto/index.ts'
type Fact = { account: string; cents: number }

export const record = async (k: string, f: Fact) => {
  const facts = await fero<Fact>('facts', { server: true, rows: false, history: 'all' })   // every fact, forever
  await facts.set(k, f)
}
export const rebuild = async (n: number) => {
  const facts = await fero<Fact>('facts')
  const balance = new Map<string, number>()
  for await (const e of facts.read({ from: 'earliest' })) {                  // rebuild from the start
    if (e.row) balance.set(e.row.account, (balance.get(e.row.account) ?? 0) + e.row.cents)
    if (--n <= 0) break
  }
  return balance
}
