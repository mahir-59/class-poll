// Class Poll server — pure Node.js, no npm install needed.
// Run:  node server.js     then open the URL it prints (share the Wi-Fi URL with voters).
// Optional env vars: PORT, ADMIN_USER, ADMIN_PASS, DATA_FILE

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---- Static admin credentials (set ADMIN_USER / ADMIN_PASS env vars when hosting) ----
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin@123';

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');

const DEFAULT_DATA = {
  salt: crypto.randomBytes(16).toString('hex'),
  settings: {
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
  },
  votes: [],
};

let data = load();
const sessions = new Set();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...DEFAULT_DATA, ...d, settings: { ...DEFAULT_DATA.settings, ...d.settings } };
  } catch {
    const d = structuredClone(DEFAULT_DATA);
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
    return d;
  }
}

function save() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

const normId = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L look-alikes

function newCode() {
  const pick = () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return Array.from({ length: 3 }, pick).join('') + '-' + Array.from({ length: 3 }, pick).join('');
}
const hashId = (id) => crypto.createHash('sha256').update(data.salt + id).digest('hex');

function tally() {
  const counts = {};
  for (const c of data.settings.candidates) counts[c.id] = 0;
  for (const v of data.votes) counts[v.candidateId] = (counts[v.candidateId] || 0) + 1;
  return counts;
}

function publicPoll() {
  const s = data.settings;
  return {
    title: s.title,
    subtitle: s.subtitle,
    voterMode: s.voterMode,
    idLabel: s.voterMode === 'code' ? 'Voter Code' : s.idLabel,
    candidates: s.candidates,
    open: s.open,
    allowAnonymous: s.allowAnonymous,
    requireName: s.requireName,
    results: s.showResultsToVoters ? { counts: tally(), total: data.votes.length } : null,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  return token && sessions.has(token);
}

const routes = {
  'GET /api/poll': () => [200, publicPoll()],

  'POST /api/vote': (body) => {
    const s = data.settings;
    if (!s.open) return [403, { error: 'Voting is closed.' }];

    const codeMode = s.voterMode === 'code';
    const label = codeMode ? 'Voter Code' : s.idLabel;
    let voterId = codeMode ? normCode(body.voterId) : normId(body.voterId);
    let name = String(body.name || '').trim().slice(0, 60);
    const anonymous = !!body.anonymous && s.allowAnonymous;
    const candidateId = String(body.candidateId || '');

    if (!voterId) return [400, { error: `${label} is required.` }];
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

    const voterHash = hashId(codeMode ? normCode(voterId) : voterId);
    if (data.votes.some((v) => v.voterHash === voterHash)) {
      return [409, { error: `This ${label} has already been used to vote.` }];
    }

    // Anonymous votes keep only a one-way hash of the ID (to block double voting) — never the ID or name.
    data.votes.push({
      voterHash,
      voterId: anonymous ? null : voterId,
      name: anonymous ? null : name,
      anonymous,
      candidateId,
      time: new Date().toISOString(),
    });
    save();
    return [200, { ok: true }];
  },

  'POST /api/login': (body) => {
    if (body.user === ADMIN_USER && body.pass === ADMIN_PASS) {
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      return [200, { token }];
    }
    return [401, { error: 'Invalid username or password.' }];
  },

  'GET /api/admin/data': () => [200, {
    settings: data.settings,
    usedCodes: (() => {
      const used = new Set(data.votes.map((v) => v.voterHash));
      return data.settings.codes.filter((c) => used.has(hashId(normCode(c.code)))).map((c) => c.code);
    })(),
    counts: tally(),
    votes: data.votes.map(({ voterHash, ...v }) => v),
  }],

  'POST /api/admin/settings': (body) => {
    const s = body.settings || {};
    const candidates = (Array.isArray(s.candidates) ? s.candidates : [])
      .map((c) => ({
        id: String(c.id || 'c' + crypto.randomBytes(4).toString('hex')),
        name: String(c.name || '').trim().slice(0, 80),
        note: String(c.note || '').trim().slice(0, 120),
      }))
      .filter((c) => c.name);
    if (candidates.length < 1) return [400, { error: 'Add at least one candidate.' }];

    data.settings = {
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
    };
    save();
    return [200, { ok: true }];
  },

  'POST /api/admin/generate-codes': (body) => {
    const count = Math.min(Math.max(parseInt(body.count, 10) || 0, 1), 1000);
    const existing = new Set(data.settings.codes.map((c) => normCode(c.code)));
    const labels = Array.isArray(body.labels) ? body.labels : [];
    for (let i = 0; i < count; i++) {
      let code;
      do code = newCode(); while (existing.has(normCode(code)));
      existing.add(normCode(code));
      data.settings.codes.push({ code, label: String(labels[i] || '').trim().slice(0, 60) });
    }
    save();
    return [200, { ok: true }];
  },

  'POST /api/admin/reset': () => {
    data.votes = [];
    save();
    return [200, { ok: true }];
  },

  'POST /api/admin/delete-vote': (body) => {
    const before = data.votes.length;
    data.votes = data.votes.filter((v) => v.time !== body.time);
    save();
    return [200, { removed: before - data.votes.length }];
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(HTML_FILE).pipe(res);
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Not found' });
  if (url.pathname.startsWith('/api/admin/') && !isAdmin(req)) {
    return send(res, 401, { error: 'Please log in again.' });
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const [status, out] = handler(body);
    send(res, status, out);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Class Poll is running!\n');
  console.log(`  On this laptop:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  Share with class: http://${i.address}:${PORT}`);
    }
  }
  console.log(`  Admin page:       http://localhost:${PORT}/#admin   (user: ${ADMIN_USER})\n`);
  if (!process.env.ADMIN_PASS) console.log('  Note: using the default admin password. Set ADMIN_PASS before hosting publicly.\n');
});
