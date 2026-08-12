// Local-only dev server: mimics Vercel's Node serverless function runtime (req.query, req.body,
// res.status().json()) closely enough to run everything in api/ without needing `vercel dev`
// (which requires being logged into a Vercel account). Not used in production — Vercel only picks
// up files under api/, so this root-level script is ignored on deploy.
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

function loadEnvFile(){
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

const ROUTES = [
  [/^\/api\/markets\/([^/]+)\/?$/, 'api/markets/[id].js', 'id'],
  [/^\/api\/markets\/?$/, 'api/markets/index.js'],
  [/^\/api\/campaigns\/([^/]+)\/?$/, 'api/campaigns/[id].js', 'id'],
  [/^\/api\/campaigns\/?$/, 'api/campaigns/index.js'],
  [/^\/api\/assets\/([^/]+)\/?$/, 'api/assets/[id].js', 'id'],
  [/^\/api\/assets\/?$/, 'api/assets/index.js'],
  [/^\/api\/metrics\/manual\/?$/, 'api/metrics/manual.js'],
  [/^\/api\/notifications\/read\/?$/, 'api/notifications/read.js'],
  [/^\/api\/notifications\/?$/, 'api/notifications/index.js'],
  [/^\/api\/cron\/sync\/?$/, 'api/cron/sync.js'],
  [/^\/api\/auth\/linkedin\/start\/?$/, 'api/auth/linkedin/start.js'],
  [/^\/api\/auth\/linkedin\/callback\/?$/, 'api/auth/linkedin/callback.js']
];

function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  for (const [pattern, file, paramName] of ROUTES) {
    const match = pathname.match(pattern);
    if (!match) continue;

    const query = Object.assign({}, parsed.query);
    if (paramName) query[paramName] = match[1];
    req.query = query;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req);
      if (raw) {
        try { req.body = JSON.parse(raw); } catch (e) { req.body = undefined; }
      }
    }

    res.status = function(code){ res.statusCode = code; return res; };
    res.json = function(data){
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };

    try {
      const filePath = path.join(__dirname, file);
      delete require.cache[require.resolve(filePath)];
      const handler = require(filePath);
      await handler(req, res);
    } catch (e) {
      console.error(`[${pathname}]`, e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`);
});
