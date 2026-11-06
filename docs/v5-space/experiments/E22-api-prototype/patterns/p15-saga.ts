// P-15 transactions across partitions (a saga), as API.md §7 writes it.
import { fero, op } from '../proto/index.ts'
import { saga } from './lib/index.ts'

export const transfer = async (id = 'tx-981', cents = 5000) => {
  const accounts = await fero('accounts')
  return saga([
    { to: accounts, key: ['alice', 'cents'], value: op.incr(-cents, { min: 0 }) },
    { to: accounts, key: ['bob', 'cents'], value: op.incr(cents) },
  ], { id })   // finishes or is undone, even if this process dies mid-way; readers may see a half
}
