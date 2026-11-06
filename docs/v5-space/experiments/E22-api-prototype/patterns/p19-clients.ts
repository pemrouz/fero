// P-19 clients everywhere, as API.md §7 writes it. The prototype has no transport: `hosts` and
// `token` are accepted and not acted on (API-NOTES A). The token is minted by the check.
import { fero } from '../proto/index.ts'

export const p19 = async (token: string, render: (x: unknown) => void) => {
  const shop = await fero('shop', { hosts: ['wss://shop.example.com'], token, cache: { memory: '20MB' } })
  const cart = shop.follow({ prefix: 'ada' })
  await cart.ready
  cart.tap(() => render(cart.snapshot()))
  return { shop, cart }
}
