// E-65 X4: a seeded random source and the value mixes the runs draw from.
export function rng(seed) {
  let s = seed >>> 0 || 1
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  r.int = (n) => Math.floor(r() * n)
  r.normal = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()) }
  return r
}
// a value maker for one named mix; t (0..1) is how far the run is, for the drifting mix
export function maker(r, dist) {
  const sig = 0.5 + 2.5 * r(), a = 0.8 + 2.2 * r()
  const base = {
    lognormal: () => Math.exp(sig * r.normal()),
    pareto: () => 1 / Math.pow(1 - r(), 1 / a),
    ints: () => r.int(101),
    mixed: () => (r() < 0.1 ? 0 : Math.round(1000 * r.normal() * 100) / 100),
    wide: () => (r() < 0.5 ? -1 : 1) * Math.pow(10, 600 * r() - 300),
  }
  const f = base[dist]
  return (t, dirty) => {
    if (dirty) {
      const d = r()
      if (d < 0.02) return null
      if (d < 0.03) return NaN
      if (d < 0.035) return 'x'
      if (d < 0.038) return r() < 0.5 ? Infinity : -Infinity
      if (d < 0.043) return -0
      if (d < 0.05) return -Math.exp(3 * r.normal()) // a few negative numbers in every mix
    }
    if (dist === 'drift') return Math.exp(sig * r.normal() + 6 * t)
    return f()
  }
}
export const DISTS = ['lognormal', 'pareto', 'ints', 'mixed', 'wide', 'drift']
