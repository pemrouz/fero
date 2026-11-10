// E-29(a): what does LazyFS model? Each probe does one thing, cuts the power (clear-cache), and looks.
//   node a_probe.mjs <work dir>      (LazyFS must be mounted there: lazyfs.sh up <work dir>)
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const [L] = process.argv.slice(2)
const SH = new URL('.', import.meta.url).pathname + 'lazyfs.sh'
const M = L + '/mnt', R = L + '/root'
const clear = () => execFileSync(SH, ['clear', L])
const st = (p) => { try { return 'size ' + fs.statSync(p).size } catch (e) { return e.code } }
const rd = (p) => { try { return JSON.stringify(fs.readFileSync(p, 'latin1').replace(/\0/g, '0')) } catch (e) { return e.code } }
const out = (probe, after, modelled) => console.log(JSON.stringify({ probe, afterPowerLoss: after, lossModelled: modelled }))
let fd
fs.writeFileSync(M + '/p1', 'unsynced'); clear(); out('write, no sync', st(M + '/p1'), st(M + '/p1') === 'size 0')
fd = fs.openSync(M + '/p2', 'w'); fs.writeSync(fd, 'synced'); fs.fsyncSync(fd); fs.closeSync(fd); clear(); out('write, fsync', rd(M + '/p2'), rd(M + '/p2') === '"synced"')
fd = fs.openSync(M + '/p3', 'w'); fs.writeSync(fd, 'datasynced'); fs.fdatasyncSync(fd); fs.closeSync(fd); clear(); out('write that grows the file, fdatasync', st(M + '/p3') + ' ' + rd(M + '/p3'), rd(M + '/p3') === '"datasynced"')
fd = fs.openSync(M + '/p4', 'w'); fs.writeSync(fd, 'AAAA'); fs.fdatasyncSync(fd); fs.writeSync(fd, 'BBBB'); fs.closeSync(fd); clear(); out('fdatasync, then more writes', rd(M + '/p4'), rd(M + '/p4') === '"AAAA"')
fd = fs.openSync(M + '/p5', 'w'); fs.writeSync(fd, 'AAAAAAAA'); fs.fsyncSync(fd); fs.writeSync(fd, 'bb', 2); fs.closeSync(fd); clear(); out('unsynced overwrite inside a synced file', rd(M + '/p5'), rd(M + '/p5') === '"AAAAAAAA"')
fd = fs.openSync(M + '/p9', 'w'); fs.writeSync(fd, 'AAAAAAAA'); fs.fsyncSync(fd); fs.ftruncateSync(fd, 2); fs.closeSync(fd); clear(); out('truncate, no sync', st(M + '/p9'), st(M + '/p9') === 'size 8')
fd = fs.openSync(M + '/p10', 'w'); fs.writeSync(fd, 'AAAA'); const fd2 = fs.openSync(M + '/p10', 'r+'); fs.fsyncSync(fd2); fs.closeSync(fd2); fs.closeSync(fd); clear(); out('fsync through a second descriptor', rd(M + '/p10'), rd(M + '/p10') === '"AAAA"')
fd = fs.openSync(M + '/p6.tmp', 'w'); fs.writeSync(fd, 'new'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(M + '/p6.tmp', M + '/p6'); clear(); out('rename, no directory fsync', 'new name: ' + rd(M + '/p6') + ', old name: ' + st(M + '/p6.tmp'), false)
fs.closeSync(fs.openSync(M + '/p7', 'w')); clear(); out('create, no fsync', st(M + '/p7'), false)
fs.writeFileSync(M + '/p8', 'x'); fd = fs.openSync(M + '/p8', 'r+'); fs.fsyncSync(fd); fs.closeSync(fd); fs.unlinkSync(M + '/p8'); clear(); out('unlink, no directory fsync', st(M + '/p8'), false)
fs.mkdirSync(M + '/d14'); fd = fs.openSync(M + '/d14/f', 'w'); fs.writeSync(fd, 'x'); fs.fsyncSync(fd); fs.closeSync(fd); clear(); out('mkdir, a synced file inside, no directory fsync', rd(M + '/d14/f'), false)
try { execFileSync('fallocate', ['-l', '65536', M + '/p11'], { stdio: 'pipe' }); out('fallocate', st(M + '/p11'), null) } catch (e) { out('fallocate', 'not supported: ' + String(e.stderr).trim(), null) }
try { const s = fs.statfsSync(M); out('statfs through the mount', 'block size ' + s.bsize + ', ' + Math.round(Number(s.bavail) * s.bsize / 1048576) + ' MB free reported', null) } catch (e) { out('statfs', e.code, null) }
