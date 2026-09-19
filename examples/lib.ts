export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// poll every 25 ms until check() is truthy, or give up after ms
export const until = async (check: () => unknown, ms = 10_000): Promise<boolean> => {
    for (const t0 = Date.now(); ; await sleep(25)) {
        try { if (await check()) return true } catch {}
        if (Date.now() - t0 > ms) return false
    }
}
