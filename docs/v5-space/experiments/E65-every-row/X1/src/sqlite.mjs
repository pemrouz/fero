// E-65 X1: the asker's rows spilled to local disk with node:sqlite (Node 22's built-in SQLite; experimental).
// The rows are the asker's own cache, rebuilt from the cluster after a crash, so the file is opened with no
// journal and no disk sync. Each row is one JSON text keyed by its row key; with { index: 'score' } a generated
// column and an index on score let a median be read by walking the index.
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'

export class SqliteStore {
  constructor(file, { cacheMB = 64, index = null } = {}) {
    rmSync(file, { force: true })
    this.file = file
    const db = (this.db = new DatabaseSync(file))
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${cacheMB * 1024}; PRAGMA mmap_size=0;`)
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID')
    if (index) { db.exec(`ALTER TABLE t ADD COLUMN ${index} REAL GENERATED ALWAYS AS (json_extract(v, '$.${index}')) VIRTUAL`); db.exec(`CREATE INDEX ix ON t(${index})`) }
    this.index = index
    this.put = db.prepare('INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)')
    this.del = db.prepare('DELETE FROM t WHERE k = ?')
    this.setF = db.prepare("UPDATE t SET v = json_set(v, '$.' || ?, json(?)) WHERE k = ?")
    this.delF = db.prepare("UPDATE t SET v = json_remove(v, '$.' || ?) WHERE k = ?")
    this.getQ = db.prepare('SELECT v FROM t WHERE k = ?')
    this.countQ = db.prepare('SELECT count(*) AS n FROM t')
  }
  apply(recs) {
    this.db.exec('BEGIN')
    for (const r of recs) {
      if (r.type === 1) { this.put.run(r.at, JSON.stringify(r.value)); continue }
      const k = r.key[0]
      if (r.key.length === 1) { if (r.type === 0) this.put.run(k, JSON.stringify(r.value)); else this.del.run(k); continue }
      if (r.type === 0) this.setF.run(r.key[1], JSON.stringify(r.value), k); else this.delF.run(r.key[1], k)
    }
    this.db.exec('COMMIT')
  }
  get(k) { const x = this.getQ.get(k); return x ? JSON.parse(x.v) : undefined }
  count() { return this.countQ.get().n }
  each(fn) { for (const x of this.db.prepare('SELECT k, v FROM t').iterate()) fn(x.k, JSON.parse(x.v)) }
  field(f, fn) { for (const x of this.db.prepare(`SELECT json_extract(v, '$.${f}') AS x FROM t`).iterate()) if (x.x !== null) fn(x.x) }
  sumSql(f) { return this.db.prepare(`SELECT sum(json_extract(v, '$.${f}')) AS s FROM t`).get().s }
  medianIx() { // walk the index to the middle (an OFFSET walk: O(n))
    const f = this.index
    const n = this.db.prepare(`SELECT count(${f}) AS n FROM t`).get().n
    if (!n) return undefined
    const lo = Math.floor((n - 1) / 2)
    const rows = this.db.prepare(`SELECT ${f} AS x FROM t WHERE ${f} IS NOT NULL ORDER BY ${f} LIMIT 2 OFFSET ?`).all(lo)
    return n % 2 ? rows[0].x : (rows[0].x + rows[1].x) / 2
  }
  close() { this.db.close(); rmSync(this.file, { force: true }) }
}
