opts
  dht (implements .lookup)
  retries
    base = 100
    max = Infinity
    jitter = 0.5
    cap = 60000 (1min)
    // can be fn (args: retry attempt)

events
  checksum

notes
  - api: promise creation dog slow, callbacks for now
  - proxies much slower