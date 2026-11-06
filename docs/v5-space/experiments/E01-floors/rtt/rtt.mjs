// Loopback TCP ping-pong in Node, Nagle off. One message in flight.
// node rtt.mjs server <port>
// node rtt.mjs client <port> <bytes> <seconds>   -> one JSON line
import net from 'node:net';

const [mode, port, bytesArg, secsArg] = process.argv.slice(2);

if (mode === 'server') {
  const srv = net.createServer((s) => {
    s.setNoDelay(true);
    s.on('data', (b) => s.write(b));
    s.on('error', () => {});
  });
  srv.listen(Number(port), '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
} else {
  const size = Number(bytesArg), secs = Number(secsArg);
  const msg = Buffer.alloc(size, 7);
  const cap = 4_000_000;
  const lat = new Float64Array(cap);
  let n = 0, got = 0, t0 = 0n, warm = true;
  const s = net.connect(Number(port), '127.0.0.1', () => {
    s.setNoDelay(true);
    setTimeout(() => { warm = false; n = 0; }, 1000);
    setTimeout(done, 1000 + secs * 1000);
    t0 = process.hrtime.bigint();
    s.write(msg);
  });
  s.on('data', (b) => {
    got += b.length;
    if (got < size) return;
    got -= size;
    const t = process.hrtime.bigint();
    if (n < cap) lat[n++] = Number(t - t0) / 1e3;
    t0 = process.hrtime.bigint();
    s.write(msg);
  });
  function done() {
    const xs = lat.subarray(0, n).sort();
    const q = (p) => xs[Math.min(n - 1, Math.floor(p * n))];
    console.log(JSON.stringify({ impl: 'node', node: process.version, bytes: size, n, rtt_per_s: Math.round(n / secs),
      p50_us: q(0.5), p99_us: q(0.99), p999_us: q(0.999), max_us: xs[n - 1] }));
    process.exit(0);
  }
}
