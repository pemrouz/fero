// P-21 request and reply, as API.md §7 writes it. `resize` is the app's; passed in.
import { service } from './lib/index.ts'

// ── worker.ts, on each answerer
export const worker = async (resize: (url: string) => Promise<string>) => {
  const thumbs = await service<{ url: string }, { url: string }>('thumbs')
  return thumbs.answer(async (req) => ({ url: await resize(req.url) }), { group: 'workers' })
}

// ── app.ts, an asker
export const app = async (url = 'a.png', print: (x: unknown) => void = console.log) => {
  const thumbs = await service<{ url: string }, { url: string }>('thumbs')
  const out = await thumbs.ask({ url }, { timeout: '5s', group: 'workers' })   // one answer, 'timeout', or 'no-answerer'
  print(out.url)
  return out
}
