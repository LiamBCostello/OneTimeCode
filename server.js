// server.js — OneTime
// Static host (mounted LAST) + public directory (+private badge) + private keys (key-only join)
// + presence + SSE + weekly popularity + local PeerJS signaling

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

// --- PeerJS server (local) ---
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || null; // optional: for deleting public lounges

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

// ---------- Persistent stores ----------
const DATA_DIR  = path.join(__dirname, 'data');
const PUB_FILE  = path.join(DATA_DIR, 'lounges.json');          // public/listed directory (no messages)
const PRIV_FILE = path.join(DATA_DIR, 'private_lounges.json');  // private lounges (salt+hash of key)

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

let pubRegistry  = loadJson(PUB_FILE).lounges;   // { [slug]: {slug,name,createdAt,isPrivate,weeklyHits,weekKey} }
let privRegistry = loadJson(PRIV_FILE).lounges;  // { [slug]: {slug,name,createdAt,salt,hash} }

// ---------- Crypto/ID helpers ----------
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomHex = (n=16) => crypto.randomBytes(n).toString('hex');
const hashKeyWithSalt = (key, salt) => sha256Hex(`${salt}:${key}`);

const hostIdFromSlug     = (slug)       => `onetime-${sha256Hex(`onetime:${slug}`).slice(0,24)}`;
const hostIdFromSlugKey  = (slug, key)  => `onetime-${sha256Hex(`onetime:${slug}:${key}`).slice(0,24)}`;

// ISO week key for weekly popularity counters, e.g., "2025-W36"
function isoWeekKey(d = new Date()){
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay()||7)); // Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}

// ---------- Health ----------
app.get('/health', (req, res) => res.json({ ok:true }));

// ---------- Direct HTML routes ----------
app.get('/lounge', (req, res) => res.sendFile(path.join(__dirname, 'lounge.html')));
app.get('/talk',   (req, res) => res.sendFile(path.join(__dirname, 'talk.html')));

// ---------- Ephemeral presence (listed rooms) ----------
/** Map<slug, { slug, count, lastSeen }> */
const presence = new Map();
/** Set<res> for SSE clients */
const clients = new Set();
const TTL_MS = 35_000;

function listLoungesForClient() {
  const arr = Object.values(pubRegistry).map(r => ({
    slug: r.slug,
    name: r.name,
    createdAt: r.createdAt,
    private: !!r.isPrivate,          // shown as badge
    weeklyHits: r.weeklyHits || 0,   // for "Most Popular"
    count: 0,
    lastSeen: 0
  }));
  const bySlug = new Map(arr.map(x => [x.slug, x]));
  const cutoff = Date.now() - TTL_MS;

  for (const [slug, p] of presence) {
    if (p.lastSeen >= cutoff) {
      const t = bySlug.get(slug);
      if (t) {
        t.count    = Math.max(t.count, p.count || 0);
        t.lastSeen = p.lastSeen;
      }
    }
  }
  // Server ordering is not critical; clients sort locally.
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

// ---------- Public/Listed lounges (persistent directory) ----------
app.post('/lounges', (req, res) => {
  const { slug, name, isPrivate } = req.body || {};
  if (!slug || !name) return res.status(400).json({ ok:false, error:'slug and name required' });
  const s = String(slug).toLowerCase();
  const n = String(name).slice(0,60);
  const prev = pubRegistry[s] || {};
  pubRegistry[s] = {
    slug: s,
    name: n,
    createdAt: prev.createdAt || Date.now(),
    isPrivate: !!isPrivate,
    weeklyHits: typeof prev.weeklyHits === 'number' ? prev.weeklyHits : 0,
    weekKey: prev.weekKey || isoWeekKey()
  };
  saveJson(PUB_FILE, { lounges: pubRegistry });
  console.log('[lounges] upsert', pubRegistry[s]);
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
  if (rec.weekKey !== wk) {
    rec.weekKey = wk;
    rec.weeklyHits = 0;
  }
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

// ---------- Private lounges (persist salted hash; join by KEY ONLY) ----------
app.post('/private-lounges', (req, res) => {
  const { slug, name, key } = req.body || {};
  if (!slug || !name || !key) return res.status(400).json({ ok:false, error:'slug, name, key required' });
  const s = String(slug).toLowerCase();
  const n = String(name).slice(0,60);
  const k = String(key);

  // Enforce key uniqueness across ALL private lounges
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

// (Legacy) verify by slug+key — kept for compatibility
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

// NEW: resolve by KEY ONLY
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

// ---------- Presence endpoints (for any listed lounge: public or listed-private) ----------
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

// ---------- SSE (public list updates) ----------
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  res.write(`event: lounges\ndata: ${JSON.stringify(listLoungesForClient())}\n\n`);
  clients.add(res);
  req.on('close', () => { clients.delete(res); });
});

// ---------- Local PeerJS server (WebSocket + HTTP signalling) ----------
const peerOptions = {
  path: '/',            // client path is the mount path below, e.g. '/peerjs'
  proxied: true,        // trust X-Forwarded-* (useful behind proxies)
  allow_discovery: true,
  pingInterval: 25000   // keep connections alive
};
const peerMiddleware = ExpressPeerServer(server, peerOptions);
peerMiddleware.on('connection', (client) => {
  // console.log('[peer] connection', client.getId());
});
peerMiddleware.on('disconnect', (client) => {
  // console.log('[peer] disconnect', client.getId());
});
app.use('/peerjs', peerMiddleware);

// ---------- Static hosting (MOUNT LAST so it doesn't intercept API routes) ----------
app.use(express.static(path.resolve('.'), { extensions: ['html'] }));

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`OneTime server running at http://localhost:${PORT}`);
  console.log(`PeerJS signaling available at /peerjs`);
});