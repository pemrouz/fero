// P-12 leaderboards, live aggregates, as API.md §7 writes it. `render` is the app's; passed in.
import { fero } from '../proto/index.ts'
type Score = { player: string; room: string; points: number }

// ── server.ts
export const methods = {
  top: (n: number, ctx: any) => ctx.data.za('points', n),        // returns a view: a client can open it live
}
export const server = async (render: (x: unknown) => void) => {
  const scores = await fero<Score>('scores', { methods })
  const top10 = scores.data.za('points', 10)                     // a server that holds every row
  top10.tap(() => render(top10.snapshot()))
  const perRoom = scores.data.group((r: Score) => r.room)
  render(perRoom.snapshot())
  return { scores, top10, perRoom }
}

// ── screen.ts: a client, typed by the server's methods
export const screen = async (render: (x: unknown) => void) => {
  const fan = await fero<Score>('scores')
  const live = fan.methods.top(10).open()                        // served live by a server that folds the rows
  live.tap(() => render(live.snapshot()))
  return { fan, live }
}
