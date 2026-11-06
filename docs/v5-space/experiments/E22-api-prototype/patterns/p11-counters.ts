// P-11 counters and rate limits, as API.md §7 writes it (the servers of `views` and `api` are the
// check's: bare names are clients).
import { fero, op } from '../proto/index.ts'
import { limiter } from './lib/index.ts'

export const p11 = async (print: (...x: unknown[]) => void = console.log) => {
  const views = await fero<number>('views')
  const a = await views.set('page:/', op.incr(1))   // a.value is the new count; a retry never counts twice
  const api = await limiter('api', { max: 100, per: '1m' })
  const { left } = await api.take('user:42')        // past 100 a minute: 'limited', with retryAfter
  print(a.value, left)
  return { a, left }
}
