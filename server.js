// server.js — OneTime (matchmaker edition)
// - Express static host
// - PeerJS signalling (WebRTC)
// - Public/private lounge registry (unchanged)
// - NEW: Redis-backed (or in-memory) matchmaker queues per (mode, filter)
// - Redirects: /talk and /talk.html -> /

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

const { ExpressPeerServer } = require('peer');

// ---------- Optional Redis (recommended for multi-instance scale) ----------
const REDIS_URL = process.env.REDIS_URL || null;
let Redis = null, redis = null;
if (REDIS_URL) {
  try {
    Redis = require('ioredis');
    redis = new Redis(REDIS_URL, { enableAutoPipelining: true, lazyConnect: false });
    redis.on('error', (e) => console.error('[redis] error', e));
    console.log('[redis] using', REDIS_URL);
  } catch (e) {
    console.warn('[redis] ioredis not installed or failed; falling back to in-memory queues');
  }
}

// ---------- App / Server ----------
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || null;

// ---------- tiny logger ----------
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    console.log(`${req.method} ${req.url} -> ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ---------- Body parsing ----------
app.use(express.json());

// ---------- Persistent stores (lounges) ----------
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB_FILE  = path.join(DATA_DIR, 'lounges.json');
const PRIV_FILE = path.join(DATA_DIR, 'private_lounges.json');

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PUB_FILE))  fs.writeFileSync(PUB_FILE,  JSON.stringify({ lounges: {} }, null, 2));
  if (!fs.existsSync(PRIV_FILE)) fs.writeFileSync(PRIV_FILE, JSON.stringify({ lounges: {} }, null, 2));
}
function loadJson(fp) {
  ensureFiles();
  try { return JSON.parse(fs.readFileSync(fp, 'utf8') || '{}'); }
  catch { return { lounges: {} }; }
}
function saveJson(fp, obj) {
  ensureFiles();
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}

let pubRegistry  = loadJson(PUB_FILE).lounges;
let privRegistry = loadJson(PRIV_FILE).lounges;

// ---------- Crypto/ID helpers ----------
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomHex = (n=16) => crypto.randomBytes(n).toString('hex');
const hashKeyWithSalt = (key, salt) => sha256Hex(`${salt}:${key}`);
const hostIdFromSlug     = (slug)      => `onetime-${sha256Hex(`onetime:${slug}`).slice(0,24)}`;
const hostIdFromSlugKey  = (slug, key) => `onetime-${sha256Hex(`onetime:${slug}:${key}`).slice(0,24)}`;

function isoWeekKey(d = new Date()){
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay()||7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}

// ---------- Health ----------
app.get('/health', (req, res) => res.json({ ok:true }));

// ---------- Redirects for old URLs ----------
app.get(['/talk', '/talk.html'], (req, res) => res.redirect(301, '/'));

// ---------- Direct HTML routes ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- Presence / SSE for lounges (unchanged) ----------
/** Map<slug, { slug, count, lastSeen }> */
const presence = new Map();
/** Set<res> for SSE clients */
const clients = new Set();
const TTL_MS = 35_000;

function listLoungesForClient() {
  const arr = Object.values(pubRegistry).map(r => ({
    slug: r.slug, name: r.name, createdAt: r.createdAt,
    private: !!r.isPrivate, weeklyHits: r.weeklyHits || 0, count: 0, lastSeen: 0
  }));
  const bySlug = new Map(arr.map(x => [x.slug, x]));
  const cutoff = Date.now() - TTL_MS;
  for (const [slug, p] of presence) {
    if (p.lastSeen >= cutoff) {
      const t = bySlug.get(slug);
      if (t) { t.count = Math.max(t.count, p.count||0); t.lastSeen = p.lastSeen; }
    }
  }
  return Array.from(bySlug.values())
    .sort((a,b) => (b.count - a.count) || (b.lastSeen - a.lastSeen) || a.name.localeCompare(b.name));
}
function broadcastLounges() {
  const snapshot = JSON.stringify(listLoungesForClient());
  for (const res of clients) {
    try { res.write(`event: lounges\ndata: ${snapshot}\n\n`); } catch {}
  }
}
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  let changed = false;
  for (const [slug, p] of presence) {
    if (p.lastSeen < cutoff) { presence.delete(slug); changed = true; }
  }
  if (changed) broadcastLounges();
}, 15_000);

// ---------- Public/Listed lounges (unchanged APIs) ----------
app.post('/lounges', (req, res) => {
  const { slug, name, isPrivate } = req.body || {};
  if (!slug || !name) return res.status(400).json({ ok:false, error:'slug and name required' });
  const s = String(slug).toLowerCase();
  const n = String(name).slice(0,60);
  const prev = pubRegistry[s] || {};
  pubRegistry[s] = {
    slug: s, name: n, createdAt: prev.createdAt || Date.now(),
    isPrivate: !!isPrivate, weeklyHits: typeof prev.weeklyHits === 'number' ? prev.weeklyHits : 0,
    weekKey: prev.weekKey || isoWeekKey()
  };
  saveJson(PUB_FILE, { lounges: pubRegistry });
  broadcastLounges();
  res.json({ ok:true, lounge: pubRegistry[s] });
});
app.get('/lounges', (req, res) => res.json(listLoungesForClient()));
app.post('/lounges/hit', (req, res) => {
  const { slug } = req.body || {};
  if (!slug) return res.status(400).json({ ok:false, error:'slug required' });
  const s = String(slug).toLowerCase();
  const rec = pubRegistry[s];
  if (!rec) return res.status(404).json({ ok:false, error:'not found' });
  const wk = isoWeekKey();
  if (rec.weekKey !== wk) { rec.weekKey = wk; rec.weeklyHits = 0; }
  rec.weeklyHits = (rec.weeklyHits || 0) + 1;
  pubRegistry[s] = rec;
  saveJson(PUB_FILE, { lounges: pubRegistry });
  broadcastLounges();
  res.json({ ok:true, weeklyHits: rec.weeklyHits });
});
app.delete('/lounges/:slug', (req, res) => {
  if (!ADMIN_KEY) return res.status(403).json({ ok:false, error:'ADMIN_KEY not set' });
  if (req.header('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok:false, error:'unauthorized' });
  const slug = String(req.params.slug || '').toLowerCase();
  if (pubRegistry[slug]) {
    delete pubRegistry[slug];
    saveJson(PUB_FILE, { lounges: pubRegistry });
    broadcastLounges();
  }
  res.json({ ok:true });
});

// ---------- Private lounges (unchanged) ----------
app.post('/private-lounges', (req, res) => {
  const { slug, name, key } = req.body || {};
  if (!slug || !name || !key) return res.status(400).json({ ok:false, error:'slug, name, key required' });
  const s = String(slug).toLowerCase();
  const n = String(name).slice(0,60);
  const k = String(key);
  for (const [otherSlug, rec] of Object.entries(privRegistry)) {
    const cand = hashKeyWithSalt(k, rec.salt);
    if (cand === rec.hash && otherSlug !== s) {
      return res.status(409).json({ ok:false, error:'key already in use', slug: otherSlug });
    }
  }
  const existing = privRegistry[s];
  const salt = existing?.salt || randomHex(16);
  const hash = hashKeyWithSalt(k, salt);
  privRegistry[s] = { slug: s, name: n, createdAt: existing?.createdAt || Date.now(), salt, hash };
  saveJson(PRIV_FILE, { lounges: privRegistry });
  res.json({ ok:true });
});
app.post('/private-lounges/resolve', (req, res) => {
  const { slug, key } = req.body || {};
  if (!slug || !key) return res.status(400).json({ ok:false, error:'slug and key required' });
  const s = String(slug).toLowerCase();
  const rec = privRegistry[s];
  if (!rec) return res.status(404).json({ ok:false, error:'not found' });
  const cand = hashKeyWithSalt(String(key), rec.salt);
  if (cand !== rec.hash) return res.status(401).json({ ok:false, error:'bad key' });
  const hostId = hostIdFromSlugKey(s, String(key));
  res.json({ ok:true, hostId, name: rec.name, slug: s });
});
app.post('/private-lounges/resolve-by-key', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });
  const k = String(key);
  for (const [s, rec] of Object.entries(privRegistry)) {
    const cand = hashKeyWithSalt(k, rec.salt);
    if (cand === rec.hash) {
      const hostId = hostIdFromSlugKey(s, k);
      return res.json({ ok:true, hostId, slug: s, name: rec.name });
    }
  }
  return res.status(404).json({ ok:false, error:'not found' });
});

// ---------- Lounge presence (unchanged) ----------
app.post('/presence/join', (req, res) => {
  const { slug, name } = req.body || {};
  if (!slug || !name) return res.status(400).json({ ok:false, error:'slug and name required' });
  const s = String(slug).toLowerCase();
  const entry = presence.get(s) || { slug:s, count:1, lastSeen: Date.now() };
  entry.count = Math.max(1, entry.count);
  entry.lastSeen = Date.now();
  presence.set(s, entry);
  broadcastLounges();
  res.json({ ok:true });
});
app.post('/presence/heartbeat', (req, res) => {
  const { slug, count } = req.body || {};
  const s = String(slug || '').toLowerCase();
  const entry = presence.get(s) || { slug:s, count:1, lastSeen: Date.now() };
  entry.count = Math.max(1, Number(count || 1));
  entry.lastSeen = Date.now();
  presence.set(s, entry);
  broadcastLounges();
  res.json({ ok:true });
});
app.post('/presence/leave', (req, res) => {
  const { slug } = req.body || {};
  if (slug) presence.delete(String(slug).toLowerCase());
  broadcastLounges();
  res.json({ ok:true });
});
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  res.write(`event: lounges\ndata: ${JSON.stringify(listLoungesForClient())}\n\n`);
  clients.add(res);
  req.on('close', () => { clients.delete(res); });
});

// ======================================================================
//                           MATCHMAKER (NEW)
// ======================================================================
//
// API:
// POST /match   { mode: 'text'|'video', filter: 'all'|..., peerId: '...' } -> 
//   { ok:true, partnerId } OR { ok:false, wait:true } OR { ok:false, error }
//
// POST /leave   { mode, filter, peerId } -> { ok:true }
//
// Implementation:
// - If a partner is waiting in the queue q:<mode>:<filter>, pair immediately:
//      * pop partnerId
//      * store SETEX paired:<peerA>=peerB and paired:<peerB>=peerA (TTL ~ 20s)
//      * return { partnerId } to this caller
// - Else, check if this peer has already been paired (due to the other arriving later):
//      * GET paired:<peerId> -> if present, return it (and DEL the key)
// - Else, enqueue this peer (LPUSH), return { wait:true }.
// - Client polls /match every X seconds until a partner is returned.
// - /leave removes peer from queue and clears any pending pair mapping.
//

const PAIR_TTL_SEC = 20;

function qKey(mode, filter) {
  const m = (mode === 'video') ? 'video' : 'text';
  const f = (filter && typeof filter === 'string') ? filter.toLowerCase() : 'all';
  return `q:${m}:${f}`;
}
function pairKey(peerId) {
  return `paired:${peerId}`;
}

// In-memory fallback
const mmMemory = {
  queues: new Map(),      // key -> Array<peerId>
  pairs:  new Map(),      // peerId -> partnerId
  pairTimers: new Map(),  // peerId -> timeout
};
function memEnqueue(key, peerId) {
  const q = mmMemory.queues.get(key) || [];
  // ensure not duplicated
  const idx = q.indexOf(peerId);
  if (idx !== -1) q.splice(idx, 1);
  q.push(peerId);
  mmMemory.queues.set(key, q);
}
function memDequeue(key) {
  const q = mmMemory.queues.get(key) || [];
  const id = q.shift();
  mmMemory.queues.set(key, q);
  return id;
}
function memRemove(key, peerId) {
  const q = mmMemory.queues.get(key) || [];
  const idx = q.indexOf(peerId);
  if (idx !== -1) { q.splice(idx, 1); mmMemory.queues.set(key, q); }
}
function memSetPair(a, b, ttlSec) {
  mmMemory.pairs.set(a, b);
  mmMemory.pairs.set(b, a);
  // TTL
  const ta = setTimeout(() => { mmMemory.pairs.delete(a); }, ttlSec*1000);
  const tb = setTimeout(() => { mmMemory.pairs.delete(b); }, ttlSec*1000);
  mmMemory.pairTimers.set(a, ta);
  mmMemory.pairTimers.set(b, tb);
}
function memGetPair(x) { return mmMemory.pairs.get(x) || null; }
function memDelPair(x) {
  mmMemory.pairs.delete(x);
  const t = mmMemory.pairTimers.get(x);
  if (t) { clearTimeout(t); mmMemory.pairTimers.delete(x); }
}

app.post('/match', async (req, res) => {
  const { mode = 'text', filter = 'all', peerId } = req.body || {};
  if (!peerId) return res.status(400).json({ ok:false, error:'peerId required' });

  const key = qKey(mode, filter);

  try {
    if (redis) {
      // 1) If already paired, return partner immediately
      const existing = await redis.get(pairKey(peerId));
      if (existing) {
        await redis.del(pairKey(peerId));
        return res.json({ ok:true, partnerId: existing });
        // Note: partner's key will expire on TTL if not read
      }

      // 2) Try to find someone waiting
      const partnerId = await redis.rpop(key); // queue is FIFO: rpop other, we lpush ourselves later if needed
      if (partnerId && partnerId !== peerId) {
        // store both directions with TTL
        await redis.multi()
          .setex(pairKey(peerId), PAIR_TTL_SEC, partnerId)
          .setex(pairKey(partnerId), PAIR_TTL_SEC, peerId)
          .exec();
        // return partner to this caller; the partner will get theirs on next poll
        return res.json({ ok:true, partnerId });
      }

      // 3) Enqueue self (ensure no duplicates)
      // Remove any stale occurrences
      await redis.lrem(key, 0, peerId);
      await redis.lpush(key, peerId);
      return res.json({ ok:false, wait:true });
    }

    // -------- In-memory fallback --------
    const existingMem = memGetPair(peerId);
    if (existingMem) {
      memDelPair(peerId);
      return res.json({ ok:true, partnerId: existingMem });
    }
    const partnerIdMem = memDequeue(key);
    if (partnerIdMem && partnerIdMem !== peerId) {
      memSetPair(peerId, partnerIdMem, PAIR_TTL_SEC);
      return res.json({ ok:true, partnerId: partnerIdMem });
    }
    memRemove(key, peerId);
    memEnqueue(key, peerId);
    return res.json({ ok:false, wait:true });
  } catch (e) {
    console.error('[match] error', e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});

app.post('/leave', async (req, res) => {
  const { mode = 'text', filter = 'all', peerId } = req.body || {};
  if (!peerId) return res.json({ ok:true });

  const key = qKey(mode, filter);
  try {
    if (redis) {
      await redis.lrem(key, 0, peerId);
      await redis.del(pairKey(peerId));
    } else {
      memRemove(key, peerId);
      memDelPair(peerId);
    }
  } catch {}
  res.json({ ok:true });
});

// ---------- PeerJS signalling ----------
const peerOptions = {
  path: '/',
  proxied: true,
  allow_discovery: true,
  pingInterval: 25000
};
const peerMiddleware = ExpressPeerServer(server, peerOptions);
peerMiddleware.on('connection', () => {});
peerMiddleware.on('disconnect', () => {});
app.use('/peerjs', peerMiddleware);

// ---------- Static hosting (MOUNT LAST) ----------
app.use(express.static(path.resolve('.'), { extensions: ['html'] }));

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`OneTime server running at http://localhost:${PORT}`);
  console.log(`PeerJS signaling available at /peerjs`);
});
