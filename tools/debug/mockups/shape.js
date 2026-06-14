// ════════════════════════════════════════════════════════════════════════
// shape — THE debug-model seam. One normalize(), two feeds.
//
// A fero debug snapshot stores each FACT once on its natural owner (a
// partition's owner / log / replica lags). normalize() turns that store-once
// file into the internal model the viewer renders, DERIVING every cross-cut
// — node ownership, max-lag, hosted-replica lists, epoch layouts + moves,
// per-sub lag, and ALL rollup counts — so they structurally can't drift.
//
// Both feeds import this one module: the browser viewer (tree.html) and the
// Node producers to come (the snapshot exporter, the live SSE bridge). So the
// file format and the live format converge on a single contract — change the
// derivation here and every surface that reads it moves together.
//
// Pure + environment-agnostic (no DOM, no fero deps): browser-importable over
// http AND Node-importable for the round-trip test (shape.test.ts).
// ════════════════════════════════════════════════════════════════════════
'use strict';

//! number → grouped string (1840 → "1,840"); passthrough for non-numbers
export const fmt = n => typeof n === 'number' ? n.toLocaleString() : n;

/* ── derivation helpers over a normalized resource ──────────────────────
   ownership at view T = the partition's owner at that epoch (re-projected
   from its ownerByEpoch history, falling back to the current owner). */
//! the partition's owner at a given epoch (ownerByEpoch history → current)
export function deriveOwnerAt(p, ep){ return (p.ownerByEpoch && p.ownerByEpoch[ep]) || p.owner; }

//! per-node owned-partition layout at epoch T, re-projected from ownerByEpoch
export function layoutAt(res, ep){
  const at = {}; for(const n of res.nodes) at[n.id] = [];
  for(const p of res.parts){ const o = deriveOwnerAt(p, ep); (at[o] = at[o] || []).push(p.id); }
  return at;
}

/* ════════════════════════════════════════════════════════════════════════
   NORMALIZE — turn a loaded debug-file snapshot into the internal model the
   tree + inspector read. Each FACT lives once in the file; here we DERIVE the
   cross-cuts so they can't drift: counts (partitions/keys) from the arrays;
   node ownership, max-lag and hosted-replica lists from the partitions; epoch
   layouts + moves from per-partition ownerByEpoch; client/sub lag from
   head−delivered. Missing fields get sensible defaults, so a terse file — or
   an arbitrary one dropped onto the page — still renders.
   ════════════════════════════════════════════════════════════════════════ */
//! store-once snapshot → derived model (the cross-cuts can't disagree)
export function normalize(snap){
  const view = snap.view || 'e4';
  const resources = (snap.resources || []).map(R => {
    const members = Array.isArray(R.members) ? R.members : [];
    const Rdef = R.R || 5;

    // partitions — the source of truth; fill log / replicas / owner-history defaults
    const parts = (R.partitions || []).map(p => {
      const Rp = p.R || Rdef;
      const held = p.held != null ? p.held : Rp;
      const raw = p.replicas || [];
      const lagBy = {}, missingAddrs = [];
      for(const r of raw){ if(r.lag) lagBy[r.addr] = r.lag; if(r.missing) missingAddrs.push(r.addr); }
      const order = [p.owner, ...members.filter(m=>m!==p.owner)].filter(a=>!missingAddrs.includes(a)).slice(0, held);
      const reps = [ ...order.map(addr => ({addr, owner:addr===p.owner, lag:lagBy[addr]||0})),
                     ...missingAddrs.map(addr => ({addr, missing:true})) ];
      let owners;
      if(p.ownerByEpoch){ const eps = Object.keys(p.ownerByEpoch);
        owners = eps.map((ep,i) => ({ep, o:p.ownerByEpoch[ep], cur:ep===view,
          moved: i>0 && p.ownerByEpoch[ep] !== p.ownerByEpoch[eps[i-1]]})); }
      else owners = [{ep:'e3',o:p.owner},{ep:view,o:p.owner,cur:true}];
      let log = (p.log || []).map(c => ({e:c.e,s:c.s,key:c.key,origin:c.by||c.origin,val:c.val,out:c.out,winner:c.winner,stuck:c.stuck}));
      if(!log.length) log = [{e:4,s:1200,key:p.name+'.v',origin:p.owner,val:'…',out:'local',winner:true},
                             {e:4,s:1180,key:p.name+'.meta',origin:p.owner,val:'…',out:'won'}];
      return {id:p.name, owner:p.owner, R:Rp, held, keys:p.keys||0, wps:p.wps||0,
        st:p.status||'healthy', note:p.note||'', log, reps, owners, ownerByEpoch:p.ownerByEpoch||null};
    });

    // nodes — derive owns / max-lag / hosted replicas from the partitions
    const nodeSpecs = R.nodes || members.map(a => ({addr:a}));
    const nodes = nodeSpecs.map(n => {
      let lag = 0; const hosts = [];
      for(const p of parts) for(const r of p.reps)
        if(r.addr===n.addr && !r.owner && !r.missing){ if(r.lag>lag) lag=r.lag; if(r.lag) hosts.push({id:p.id,owner:p.owner,lag:r.lag}); }
      for(const p of parts){ if(hosts.length>=4) break; if(p.owner!==n.addr && !hosts.some(h=>h.id===p.id)) hosts.push({id:p.id,owner:p.owner,lag:0}); }
      return {id:n.addr, keys:n.keys!=null?n.keys:null, wps:n.wps!=null?n.wps:null, lag,
        hosts:hosts.slice(0,4), st:n.status || (lag>0?'lagging':'healthy'), note:n.note||''};
    });

    // clients — derive per-sub lag (head − delivered) + the client's max lag
    const clients = (R.clients || []).map(c => {
      const subs = (c.subs || []).map(s => {
        const d = (s.head!=null && s.delivered!=null) ? (s.head - s.delivered) : 0;
        return {sub:s.key, own:s.owner, head:'s'+fmt(s.head), deliv:'s'+fmt(s.delivered),
          lag: s.released?'released':(d>0?'+'+fmt(d):'0'), cls: d>0?'min':'maj', released:!!s.released};
      });
      const maxLag = Math.max(0, ...(c.subs||[]).map(s => (s.head!=null&&s.delivered!=null)?(s.head-s.delivered):0));
      return {id:c.id, role:c.role||'reader', srv:c.server, lag:c.lag!=null?c.lag:maxLag,
        st:c.status||'healthy', note:c.note||'', view:c.view||view, subs};
    });

    // epochs — derive the ownership moves at each transition from ownerByEpoch
    const epSpecs = R.epochs || [{id:'e3'},{id:view,current:true}];
    const epochs = epSpecs.map(e => {
      const moves = [];
      for(const p of parts){ if(!p.ownerByEpoch) continue; const ks=Object.keys(p.ownerByEpoch); const i=ks.indexOf(e.id);
        if(i>0 && p.ownerByEpoch[ks[i]] !== p.ownerByEpoch[ks[i-1]]) moves.push([p.id, p.ownerByEpoch[ks[i-1]], p.ownerByEpoch[ks[i]]]); }
      return {ep:e.id, cur:!!e.current || e.id===view, members:e.members!=null?e.members:members.length, note:e.note||'', moves};
    });

    // rollup counts DERIVE from the arrays — they can never disagree with the children
    const keys = parts.reduce((a,p)=>a+(p.keys||0), 0);
    const wps  = parts.reduce((a,p)=>a+(p.wps||0), 0);
    return {id:R.name, members:members.length, parts, nodes, clients, epochs, keys, wps};
  });
  return {view, resources};
}
