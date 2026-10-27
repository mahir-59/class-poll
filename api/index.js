// Class Poll API — shared by the local server (server.js) and Vercel (serverless function).
// No npm packages. Storage: Upstash Redis when its env vars are set (Vercel), otherwise a local JSON file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Static admin credentials (set ADMIN_USER / ADMIN_PASS env vars when hosting) ----
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin@123';
const SESSION_HOURS = 12;

const DEFAULT_SETTINGS = {
  title: 'Class Representative Election',
  subtitle: 'Choose one candidate. You can vote only once.',
  voterMode: 'code', // 'code' = one-time codes handed out by admin, 'id' = voter types own ID
  idLabel: 'Roll Number',
  codes: [], // [{ code: 'K7P-29Q', label: 'optional student name' }]
  candidates: [
    { id: 'c1', name: 'Candidate A', note: '' },
    { id: 'c2', name: 'Candidate B', note: '' },
  ],
  open: true,
  allowAnonymous: true,
  requireName: false,
  restrictIds: false,
  allowedIds: [],
  showResultsToVoters: false,
};

// ---------------- Storage ----------------

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = process.env.POLL_KEY || 'poll';

// Upstash Redis over its REST API (plain fetch, no client library).
const redisStore = {
  async run(commands) {
    const res = await fetch(REDIS_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error('Database error: ' + res.status);
    return (await res.json()).map((r) => {
      if (r.error) throw new Error('Database error: ' + r.error);
      return r.result;
    });
  },
  async load() {
    const [, salt, settings, votes] = await this.run([
      ['SET', `${KEY}:salt`, crypto.randomBytes(16).toString('hex'), 'NX'],
      ['GET', `${KEY}:salt`],
      ['GET', `${KEY}:settings`],
      ['HVALS', `${KEY}:votes`],
    ]);
    return {
      salt,
      settings: { ...DEFAULT_SETTINGS, ...(settings ? JSON.parse(settings) : {}) },
      votes: votes.map((v) => JSON.parse(v)).sort((a, b) => a.time.localeCompare(b.time)),
    };
  },
  async saveSettings(settings) {
    await this.run([['SET', `${KEY}:settings`, JSON.stringify(settings)]]);
  },
  // HSETNX is atomic, so two simultaneous votes with the same ID can't both succeed.
  async addVote(vote) {
    const [added] = await this.run([['HSETNX', `${KEY}:votes`, vote.voterHash, JSON.stringify(vote)]]);
    return added === 1;
  },
  async deleteVote(vote) {
    await this.run([['HDEL', `${KEY}:votes`, vote.voterHash]]);
  },
  async resetVotes() {
    await this.run([['DEL', `${KEY}:votes`]]);
  },
};

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');

const fileStore = {
  data: null,
  async load() {
    if (!this.data) {
      try {
        const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        this.data = { ...d, settings: { ...DEFAULT_SETTINGS, ...d.settings }, votes: d.votes || [] };
      } catch {
        this.data = { salt: crypto.randomBytes(16).toString('hex'), settings: { ...DEFAULT_SETTINGS }, votes: [] };
        this.save();
      }
    }
    return this.data;
  },
  save() {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(this.data, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  },
  async saveSettings(settings) { this.data.settings = settings; this.save(); },
  async addVote(vote) {
    if (this.data.votes.some((v) => v.voterHash === vote.voterHash)) return false;
    this.data.votes.push(vote); this.save(); return true;
  },
  async deleteVote(vote) { this.data.votes = this.data.votes.filter((v) => v !== vote); this.save(); },
  async resetVotes() { this.data.votes = []; this.save(); },
};

const store = REDIS_URL && REDIS_TOKEN ? redisStore : fileStore;
const storageMissing = !!process.env.VERCEL && store === fileStore;

// ---------------- Helpers ----------------

const normId = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L look-alikes

function newCode() {
  const pick = () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return Array.from({ length: 3 }, pick).join('') + '-' + Array.from({ length: 3 }, pick).join('');
}
const hashId = (salt, id) => crypto.createHash('sha256').update(salt + id).digest('hex');

function tally(state) {
  const counts = {};
  for (const c of state.settings.candidates) counts[c.id] = 0;
  for (const v of state.votes) counts[v.candidateId] = (counts[v.candidateId] || 0) + 1;
  return counts;
}

// Stateless admin sessions (serverless instances share no memory): token = expiry + HMAC signature.
const SESSION_KEY = crypto.createHash('sha256')
  .update(`${ADMIN_USER}:${ADMIN_PASS}:${process.env.SESSION_SECRET || ''}`).digest();
const sign = (s) => crypto.createHmac('sha256', SESSION_KEY).update(s).digest('hex');

function makeToken() {
  const exp = String(Date.now() + SESSION_HOURS * 3600e3);
  return exp + '.' + sign(exp);
}

function isAdmin(req) {
  const [exp, sig] = String(req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if ('body' in req) { // Vercel pre-parses the body
    const b = req.body;
    return typeof b === 'string' ? JSON.parse(b || '{}') : b || {};
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('Body too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON'); }
}

// ---------------- Routes ----------------

const routes = {
  'GET /api/poll': async () => {
    const state = await store.load();
    const s = state.settings;
    return [200, {
      title: s.title,
      subtitle: s.subtitle,
      voterMode: s.voterMode,
      idLabel: s.voterMode === 'code' ? 'Voter Code' : s.idLabel,
      candidates: s.candidates,
      open: s.open,
      allowAnonymous: s.allowAnonymous,
      requireName: s.requireName,
      results: s.showResultsToVoters ? { counts: tally(state), total: state.votes.length } : null,
    }];
  },

  'POST /api/vote': async (body) => {
    const state = await store.load();
    const s = state.settings;
    if (!s.open) return [403, { error: 'Voting is closed.' }];

    const codeMode = s.voterMode === 'code';
    const label = codeMode ? 'voter code' : s.idLabel;
    let voterId = codeMode ? normCode(body.voterId) : normId(body.voterId);
    let name = String(body.name || '').trim().slice(0, 60);
    const anonymous = !!body.anonymous && s.allowAnonymous;
    const candidateId = String(body.candidateId || '');

    if (!voterId) return [400, { error: `Please enter your ${label}.` }];
    if (codeMode) {
      const entry = s.codes.find((c) => normCode(c.code) === voterId);
      if (!entry) return [403, { error: 'This voter code is not valid. Check it and try again.' }];
      voterId = entry.code;
      if (!name) name = entry.label || '';
    } else if (s.restrictIds && !s.allowedIds.map(normId).includes(voterId)) {
      return [403, { error: `This ${label} is not on the voter list.` }];
    }
    if (!s.candidates.some((c) => c.id === candidateId)) return [400, { error: 'Please select a candidate.' }];
    if (s.requireName && !anonymous && !name) return [400, { error: 'Please enter your name.' }];

    // Anonymous votes keep only a one-way hash of the ID (to block double voting), never the ID or name.
    const added = await store.addVote({
      voterHash: hashId(state.salt, codeMode ? normCode(voterId) : voterId),
      voterId: anonymous ? null : voterId,
      name: anonymous ? null : name,
      anonymous,
      candidateId,
      time: new Date().toISOString(),
    });
    if (!added) return [409, { error: `This ${label} has already been used to vote.` }];
    return [200, { ok: true }];
  },

  'POST /api/login': async (body) => {
    if (sameText(body.user, ADMIN_USER) && sameText(body.pass, ADMIN_PASS)) return [200, { token: makeToken() }];
    return [401, { error: 'Invalid username or password.' }];
  },

  'GET /api/admin/data': async () => {
    const state = await store.load();
    const used = new Set(state.votes.map((v) => v.voterHash));
    return [200, {
      settings: state.settings,
      usedCodes: state.settings.codes.filter((c) => used.has(hashId(state.salt, normCode(c.code)))).map((c) => c.code),
      counts: tally(state),
      votes: state.votes.map(({ voterHash, ...v }) => v),
    }];
  },

  'POST /api/admin/settings': async (body) => {
    await store.load();
    const s = body.settings || {};
    const candidates = (Array.isArray(s.candidates) ? s.candidates : [])
      .map((c) => ({
        id: String(c.id || 'c' + crypto.randomBytes(4).toString('hex')),
        name: String(c.name || '').trim().slice(0, 80),
        note: String(c.note || '').trim().slice(0, 120),
      }))
      .filter((c) => c.name);
    if (candidates.length < 1) return [400, { error: 'Add at least one candidate.' }];

    await store.saveSettings({
      title: String(s.title || '').trim().slice(0, 100) || 'Poll',
      subtitle: String(s.subtitle || '').trim().slice(0, 200),
      voterMode: s.voterMode === 'id' ? 'id' : 'code',
      idLabel: String(s.idLabel || '').trim().slice(0, 30) || 'Voter ID',
      codes: (Array.isArray(s.codes) ? s.codes : [])
        .map((c) => ({ code: String(c.code || '').trim().toUpperCase().slice(0, 20), label: String(c.label || '').trim().slice(0, 60) }))
        .filter((c, i, all) => normCode(c.code) && all.findIndex((x) => normCode(x.code) === normCode(c.code)) === i),
      candidates,
      open: !!s.open,
      allowAnonymous: !!s.allowAnonymous,
      requireName: !!s.requireName,
      restrictIds: !!s.restrictIds,
      allowedIds: (Array.isArray(s.allowedIds) ? s.allowedIds : []).map(normId).filter(Boolean),
      showResultsToVoters: !!s.showResultsToVoters,
    });
    return [200, { ok: true }];
  },

  'POST /api/admin/generate-codes': async (body) => {
    const { settings } = await store.load();
    const count = Math.min(Math.max(parseInt(body.count, 10) || 0, 1), 1000);
    const existing = new Set(settings.codes.map((c) => normCode(c.code)));
    const labels = Array.isArray(body.labels) ? body.labels : [];
    const codes = [...settings.codes];
    for (let i = 0; i < count; i++) {
      let code;
      do code = newCode(); while (existing.has(normCode(code)));
      existing.add(normCode(code));
      codes.push({ code, label: String(labels[i] || '').trim().slice(0, 60) });
    }
    await store.saveSettings({ ...settings, codes });
    return [200, { ok: true }];
  },

  'POST /api/admin/reset': async () => {
    await store.resetVotes();
    return [200, { ok: true }];
  },

  'POST /api/admin/delete-vote': async (body) => {
    const state = await store.load();
    const vote = state.votes.find((v) => v.time === body.time);
    if (vote) await store.deleteVote(vote);
    return [200, { removed: vote ? 1 : 0 }];
  },
};

// ---------------- Handler ----------------

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // On Vercel, /api/<route> is rewritten to /api?route=<route> (see vercel.json).
  const pathname = url.searchParams.get('route') ? '/api/' + url.searchParams.get('route') : url.pathname;

  const route = routes[`${req.method} ${pathname}`];
  if (!route) return send(res, 404, { error: 'Not found' });
  if (storageMissing) {
    return send(res, 500, { error: 'Storage is not set up. Add an Upstash Redis database to this Vercel project.' });
  }
  if (pathname.startsWith('/api/admin/') && !isAdmin(req)) {
    return send(res, 401, { error: 'Please log in again.' });
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const [status, out] = await route(body);
    send(res, status, out);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
};

module.exports.ADMIN_USER = ADMIN_USER;
module.exports.usingDefaultPassword = !process.env.ADMIN_PASS;
