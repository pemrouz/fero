const P = new URL('../proto/lens.mjs', import.meta.url).href
const { fero, VALUE } = await import(P)
const f = fero('f', { data: { '1': { n: 7 } } })
console.log(JSON.stringify({ viaProxy: f.data[1].n[VALUE], viaAtNumber: f.at(1, 'n')[VALUE], viaAtString: f.at('1', 'n')[VALUE], viaGet: await f.at(1, 'n').get() }))
