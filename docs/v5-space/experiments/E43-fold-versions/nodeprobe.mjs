// E-43: JavaScript behaviours a user's rule, method or view function might lean on, printed as "name<TAB>value",
// so the output of two Node versions can be diffed line by line. Nothing here is data's own code: data's fold
// and operators call none of these (grep in the README). TZ=UTC and LANG=C are set by run.sh.
const out = []
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer)
const bits = (x) => { f64[0] = x; return u32[1].toString(16).padStart(8, '0') + u32[0].toString(16).padStart(8, '0') }
const p = (name, fn) => { let v; try { v = fn() } catch (e) { v = 'THROWS ' + e.constructor.name } out.push(name + '\t' + (typeof v === 'string' ? v : JSON.stringify(v))) }

// versions (these differ by design; they are the cause, the rest is the effect)
for (const k of ['node', 'v8', 'icu', 'unicode', 'cldr', 'tz']) p('version.' + k, () => process.versions[k])

// numbers to text and back (the language standard fixes these)
p('num.toString', () => [0.1 + 0.2, 1e21, 1e-7, 123456789012345680000, -0, 5e-324, 2 ** 53].map(String))
p('num.toFixed', () => [(1.005).toFixed(2), (123.456).toFixed(1), (0.5).toFixed(0), (2.5).toFixed(0), (1e21).toFixed(2)])
p('num.toPrecision', () => [(123.456).toPrecision(4), (0.000123).toExponential(2), (255).toString(16), (0.1).toString(3)])
p('num.parse', () => [parseFloat('1e-7x'), Number('0x10'), parseInt('08'), Number(' 12 '), Number('1_000'), parseFloat('.5e1')].map(bits))
p('json.numbers', () => JSON.stringify([1e21, 0.1, -0, 1 / 3, 9007199254740993]) + JSON.parse('[12345678901234567890, 1e400, -1e-400]').map(bits))
p('json.strings', () => JSON.stringify(['\ud800', ' ', '\u007f', 'é', '😀']))

// Math's library functions (the standard allows the last bit to differ between engines)
const xs = [0.5, 1, 1.5, 2, 3, 10, 100, 1e-5, 0.1, 0.7, 1e10, 123.456, -2.5]
for (const fn of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'cbrt', 'sqrt'])
  p('math.' + fn, () => xs.map((x) => bits(Math[fn](x))).join(' '))
p('math.pow', () => [[2, 0.5], [10, -5], [1.1, 100], [0.3, 0.7], [7, 13.5], [1e3, 1 / 3]].map(([a, b]) => bits(a ** b)).join(' '))
p('math.atan2,hypot', () => [bits(Math.atan2(1, 3)), bits(Math.atan2(-2, 0.1)), bits(Math.hypot(3, 4, 5)), bits(Math.hypot(1e200, 1e200)), bits(Math.fround(0.1))].join(' '))
p('math.new', () => ['sumPrecise', 'f16round'].map((k) => typeof Math[k]))

// objects and arrays (the standard fixes key order and makes sort stable)
p('object.keyOrder', () => Object.keys({ b: 1, 2: 1, a: 1, 1: 1, '-1': 1, '01': 1, 4294967295: 1, 4294967294: 1, 1.5: 1 }))
p('array.sortDefault', () => [10, 9, 1, 'b', 'B', 'a', undefined, null, 'é', '😀', 'z', 2].sort().map(String))
p('array.sortStable', () => { const a = []; for (let i = 0; i < 2000; i++) a.push({ k: i % 7, i }); a.sort((x, y) => x.k - y.k); let ok = true; for (let i = 1; i < a.length; i++) if (a[i - 1].k === a[i].k && a[i - 1].i > a[i].i) ok = false; return ok })
p('array.sortBoolComparator', () => { const a = []; let s = 7; for (let i = 0; i < 600; i++) { s = (s * 1103515245 + 12345) >>> 0; a.push(s % 1000) } return a.slice().sort((x, y) => x > y).slice(0, 12) }) // a common bug: the result is up to the engine
p('array.sortNaNComparator', () => [3, 1, 2, 5, 4].sort(() => NaN))
p('array.sortMixedNumbers', () => { const a = [5, NaN, 1, -0, 0, Infinity, -1, NaN]; return a.sort((x, y) => x - y).map(String) })
p('typed.sort', () => Array.from(new Float64Array([3, NaN, -0, 0, -1]).sort()).map(String))
p('forIn.order', () => { const o = Object.create({ z: 1, 1: 1 }); o.b = 1; o[0] = 1; o.a = 1; const r = []; for (const k in o) r.push(k); return r })

// strings and Unicode (these follow the Unicode version the Node build ships)
p('str.case', () => ['ß'.toUpperCase(), 'İ'.toLowerCase().length, 'ǆ'.toUpperCase(), 'ꟶ'.toUpperCase(), '𐲀'.toLowerCase(), 'ᲊ'.toUpperCase(), 'ꟑ'.toLowerCase()].map((s) => typeof s === 'string' ? [...s].map((c) => c.codePointAt(0).toString(16)).join('+') : s))
p('str.normalize', () => ['é', 'Å', 'ﬁ', '①', 'ẛ̣'].map((s) => ['NFC', 'NFD', 'NFKC'].map((f) => [...s.normalize(f)].map((c) => c.codePointAt(0).toString(16)).join('+')).join('/')))
p('str.wellFormed', () => [typeof ''.isWellFormed, typeof ''.toWellFormed, typeof ''.at])
p('regexp.props', () => ['\u{1FAE9}', '\u{1CC00}', '\u{10D40}', '\u{1FADC}', '\u{16D40}', '\u{11BC0}', '\u{1FAEA}', '\u{1CCFA}', 'a'].map((c) => [/\p{L}/u.test(c), /\p{Emoji}/u.test(c), /\p{Assigned}/u.test(c)].map(Number).join('')))
p('regexp.flags', () => { const r = []; for (const f of ['v', 'd', 's', 'y']) { try { new RegExp('a', f); r.push(f) } catch { r.push('!' + f) } } return r.concat(typeof RegExp.escape) })
p('str.localeCompare', () => [['a', 'B'], ['ä', 'z'], ['é', 'f'], ['10', '9'], ['Z', 'a'], ['ǆ', 'dz'], ['\u{1FAE9}', '\u{1FADC}'], ['ꟶ', 'z'], ['ss', 'ß']].map(([a, b]) => a.localeCompare(b)))
p('collator.en', () => { const c = new Intl.Collator('en'); return ['z', 'ä', 'a', 'Z', 'é', '10', '9', '\u{1FAE9}', '\u{10D40}', 'ꟶ', '_', '-', ' '].sort(c.compare).map((s) => [...s].map((ch) => ch.codePointAt(0).toString(16)).join('+')) })
p('collator.sv', () => { const c = new Intl.Collator('sv'); return ['z', 'ä', 'a', 'ö', 'å', 'w', 'v'].sort(c.compare) })
p('segmenter.graphemes', () => { const s = new Intl.Segmenter('en', { granularity: 'grapheme' }); return ['👨‍👩‍👧‍👦', '🇺🇸🇬🇧', 'é', '🧑🏽‍🦽‍➡️', 'क्षि', '\u{1FAE9}\u{1F3FD}'].map((t) => [...s.segment(t)].length) })
p('segmenter.words', () => { const s = new Intl.Segmenter('en', { granularity: 'word' }); return [...s.segment("can't stop 3.14 日本語のテキスト")].filter((x) => x.isWordLike).length })

// dates, time zones and locale text
const D0 = new Date(Date.UTC(2026, 10, 10, 12, 34, 56))
p('date.parse', () => ['2026-11-10', '2026-11-10T12:00', '2026-11-10 12:00', 'Nov 10, 2026', '10 November 2026 12:00 UTC', '2026/11/10', '11/10/2026', '2026-11-10T12:00:00+0100', 'Tue Nov 10 2026', '2026-W46', '10.11.2026'].map((s) => Date.parse(s)))
p('date.toString', () => [D0.toString(), D0.toISOString(), D0.toUTCString(), D0.toLocaleDateString('en-US'), D0.toLocaleTimeString('en-US'), D0.toLocaleString('en-GB'), D0.toLocaleString('de-DE'), D0.toLocaleString('ja-JP')])
p('date.defaultLocale', () => [Intl.DateTimeFormat().resolvedOptions().locale, Intl.DateTimeFormat().resolvedOptions().timeZone, D0.toLocaleString(), (1234567.891).toLocaleString()])
p('date.zoneOffsets2027', () => ['Europe/Kyiv', 'America/Nuuk', 'Asia/Almaty', 'Africa/Casablanca', 'America/Mexico_City', 'Asia/Amman', 'Europe/Moscow', 'America/Sao_Paulo', 'Asia/Tehran', 'Pacific/Fiji', 'Africa/Cairo', 'America/Asuncion', 'Asia/Manila', 'America/Coyhaique']
  .map((z) => { try { return z + '=' + [0, 3, 6, 9].map((m) => new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'longOffset' }).formatToParts(new Date(Date.UTC(2027, m, 15, 12))).find((x) => x.type === 'timeZoneName').value).join(',') } catch { return z + '=UNKNOWN' } }))
p('intl.zones', () => Intl.supportedValuesOf('timeZone').length)
p('intl.numberFormat', () => [new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5), new Intl.NumberFormat('de-DE').format(1234567.891), new Intl.NumberFormat('en', { notation: 'compact' }).format(1234567), new Intl.NumberFormat('en-IN').format(1234567.891), new Intl.NumberFormat('ar-EG').format(123), new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(1234.5)])
p('intl.plural,list,relative', () => [new Intl.PluralRules('ru').select(21), new Intl.ListFormat('en', { type: 'conjunction' }).format(['a', 'b', 'c']), new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'), new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(D0)])
p('temporal', () => typeof globalThis.Temporal)

// error text (an app may store a caught error's message in a row)
const msg = (fn) => { try { fn(); return 'no throw' } catch (e) { return e.constructor.name + ': ' + e.message } }
p('error.messages', () => [msg(() => undefined.x), msg(() => null.f()), msg(() => ({}).f()), msg(() => JSON.parse('{bad')), msg(() => JSON.parse('')), msg(() => new Array(-1)), msg(() => x.y), msg(() => BigInt(1.5)), msg(() => 'a'.repeat(-1)), msg(() => structuredClone(() => 1)), msg(() => { const o = {}; o.o = o; JSON.stringify(o) }), msg(() => decodeURIComponent('%')), msg(() => new Intl.Collator('xx-invalid-locale-tag-zzzz')), msg(() => (1).toFixed(101))])

// built-ins that exist in one and not the other (code that checks for them takes another path)
p('builtins', () => ['Iterator', 'Float16Array', 'Promise.try', 'Promise.withResolvers', 'Array.fromAsync', 'Set.prototype.union', 'Object.groupBy', 'Map.groupBy', 'Array.prototype.toSorted', 'Uint8Array.fromBase64', 'Uint8Array.prototype.toHex', 'Error.isError', 'Atomics.pause', 'JSON.rawJSON', 'Math.sumPrecise', 'RegExp.escape', 'Intl.DurationFormat', 'Temporal', 'WebSocket', 'navigator', 'Array.prototype.group', 'Symbol.dispose', 'DisposableStack', 'Iterator.concat', 'Map.prototype.getOrInsert', 'Error.captureStackTrace']
  .map((path) => { let o = globalThis; for (const s of path.split('.')) o = o?.[s]; return path + ':' + typeof o }))
p('structuredClone', () => { const v = structuredClone({ a: new Date(0), b: /x/gi, c: new Map([[1, 2]]), d: [, 1], e: -0, f: new Error('m', { cause: 1 }) }); return [v.a.getTime(), String(v.b), [...v.c], 0 in v.d, Object.is(v.e, -0), v.f.message, 'cause' in v.f] })
p('text.encode', () => [Array.from(new TextEncoder().encode('\ud800x')), new TextDecoder().decode(new Uint8Array([0xff, 0x41, 0xc3])).length, Buffer.from('\ud800', 'utf8').toString('hex'), Buffer.byteLength('😀'), Buffer.from('aGk', 'base64').toString(), Buffer.from('a-b_c', 'base64url').toString('hex')])
p('hash.string', () => { let h = 0; const s = 'the quick brown fox'; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h })
p('float.sum', () => { let a = 0; for (let i = 1; i <= 1000; i++) a += 1 / i; let b = 0; for (let i = 1000; i >= 1; i--) b += 1 / i; return [bits(a), bits(b), bits([0.1, 0.2, 0.3].reduce((x, y) => x + y)), bits(0.1 * 3), bits(1e16 + 1 - 1e16)] })
console.log(out.join('\n'))
