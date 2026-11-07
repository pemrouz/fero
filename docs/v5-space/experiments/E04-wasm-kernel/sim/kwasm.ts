// The WASM twin behind the same interface as k-ts's tsKernel(): create, step, dump, destroy.
// Every call crosses JS -> WASM: the event bytes are copied into linear memory, the kernel runs,
// and the effects come back as a view into linear memory (valid until the next call).
import { readFileSync } from 'node:fs'

export const compileK = (path: string): WebAssembly.Module => new WebAssembly.Module(readFileSync(path))

export const wasmKernel = (mod: WebAssembly.Module) => {
  const inst = new WebAssembly.Instance(mod, {})
  const ex = inst.exports as any
  const memory: WebAssembly.Memory = ex.memory
  let mem = new Uint8Array(memory.buffer)
  // a grown memory detaches the old buffer, and a view of a detached buffer has length 0
  const view = () => (mem.length ? mem : (mem = new Uint8Array(memory.buffer)))
  let inPtr = 0, inCap = 0
  const put = (b: Uint8Array) => {
    if (b.length > inCap) { inCap = Math.max(b.length, 4096); inPtr = ex.k_in(inCap) }
    view().set(b, inPtr)
  }
  return {
    name: 'wasm',
    create(id: number, n: number, journal: Uint8Array): number { put(journal); return ex.k_create(id, n, journal.length) },
    step(h: number, ev: Uint8Array): Uint8Array {
      put(ev)
      const len = ex.k_step(h, ev.length)
      const o = ex.k_out()
      return view().subarray(o, o + len)
    },
    dump(h: number): Uint8Array { const len = ex.k_dump(h); const o = ex.k_out(); return view().slice(o, o + len) },
    destroy(h: number) { ex.k_destroy(h) },
    reset() { ex.k_reset() },
    memoryBytes: () => memory.buffer.byteLength,
  }
}
