// Class Poll local server — pure Node.js, no npm install needed.
// Run:  node server.js     then open the URL it prints (share the Wi-Fi URL with voters).
// Optional env vars: PORT, ADMIN_USER, ADMIN_PASS, DATA_FILE
// The same API runs on Vercel via api/index.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const api = require('./api/index.js');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(HTML_FILE).pipe(res);
  }
  api(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Class Poll is running!\n');
  console.log(`  On this laptop:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  Share with class: http://${i.address}:${PORT}`);
    }
  }
  console.log(`  Admin page:       http://localhost:${PORT}/#admin   (user: ${api.ADMIN_USER})\n`);
  if (api.usingDefaultPassword) console.log('  Note: using the default admin password. Set ADMIN_PASS before hosting publicly.\n');
});
