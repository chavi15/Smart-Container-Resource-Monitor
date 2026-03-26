/**
 * CRMTR Agent v2 — Mac compatible
 * Tries multiple Docker socket paths automatically
 */

const http = require('http');
const { exec } = require('child_process');
const fs   = require('fs');

const PORT     = 9101;
const HOSTNAME = require('os').hostname();

// Mac Docker Desktop uses different socket locations depending on version
// Try each one until we find the right docker command
function findDockerCmd(cb) {
  const candidates = [
    'docker stats --no-stream --format "{{json .}}"',
    '/usr/local/bin/docker stats --no-stream --format "{{json .}}"',
    '/usr/bin/docker stats --no-stream --format "{{json .}}"',
  ];

  let i = 0;
  function tryNext() {
    if (i >= candidates.length) return cb(null); // none worked, return null
    exec(candidates[i], { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout && stdout.trim()) return cb(candidates[i].split(' stats')[0]); // found it
      i++;
      tryNext();
    });
  }
  tryNext();
}

function parseSize(s) {
  if (!s) return 0;
  s = s.trim();
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  const l = s.toLowerCase();
  if (l.includes('gib') || l.includes('gb')) return n * 1024;
  if (l.includes('mib') || l.includes('mb')) return n;
  if (l.includes('kib') || l.includes('kb')) return n / 1024;
  return n / (1024 * 1024);
}

function parsePct(s) { return parseFloat((s || '0').replace('%', '')) || 0; }

function parseIO(s) {
  if (!s || !s.includes('/')) return 0;
  const p = s.split('/');
  return Math.round((parseSize(p[0].trim()) + parseSize(p[1].trim())) * 10) / 10;
}

function parseMem(s) {
  if (!s || !s.includes('/')) return { used: 0, limit: 0 };
  const p = s.split('/');
  return { used: parseSize(p[0].trim()), limit: parseSize(p[1].trim()) };
}

function parseStats(stdout) {
  const containers = [];
  (stdout || '').trim().split('\n').forEach(line => {
    try {
      const r   = JSON.parse(line.trim());
      const mem = parseMem(r.MemUsage || '');
      containers.push({
        id:       (r.ID || r.Container || '').slice(0, 12),
        name:     (r.Name || r.Container || 'unknown').replace(/^\//, ''),
        cpu:      Math.round(parsePct(r.CPUPerc) * 10) / 10,
        mem:      Math.round(parsePct(r.MemPerc) * 10) / 10,
        memUsed:  Math.round(mem.used  * 10) / 10,
        memLimit: Math.round(mem.limit * 10) / 10,
        net:      parseIO(r.NetIO   || ''),
        dk:       parseIO(r.BlockIO || ''),
        pids:     parseInt(r.PIDs)  || 0,
      });
    } catch(_) {}
  });
  return containers;
}

function getStats(cb) {
  // The socket is mounted from host — set DOCKER_HOST so docker CLI finds it
  const env = {
    ...process.env,
    DOCKER_HOST: 'unix:///var/run/docker.sock',
  };

  exec('docker stats --no-stream --format "{{json .}}"',
    { timeout: 10000, env },
    (err, stdout) => {
      if (err && !stdout) {
        // Try with explicit socket flag
        exec('docker -H unix:///var/run/docker.sock stats --no-stream --format "{{json .}}"',
          { timeout: 10000 },
          (err2, stdout2) => {
            if (err2 && !stdout2) return cb({ error: err2.message.split('\n')[0], containers: [] });
            cb({ error: null, containers: parseStats(stdout2) });
          }
        );
        return;
      }
      cb({ error: null, containers: parseStats(stdout) });
    }
  );
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, host: HOSTNAME, ts: Date.now() }));
  }

  if (req.url === '/stats') {
    getStats(data => {
      res.writeHead(data.error && !data.containers.length ? 503 : 200);
      res.end(JSON.stringify({ ...data, host: HOSTNAME, ts: Date.now() }));
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Use /stats or /health' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log(`║  CRMTR Agent · ${HOSTNAME.slice(0,22).padEnd(22)} ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Stats  →  http://0.0.0.0:${PORT}/stats  ║`);
  console.log(`║  Health →  http://0.0.0.0:${PORT}/health ║`);
  console.log('╚════════════════════════════════════════╝\n');

  // Check socket exists
  const sock = '/var/run/docker.sock';
  if (fs.existsSync(sock)) {
    console.log(`✓  Docker socket found at ${sock}`);
  } else {
    console.log(`⚠  Docker socket NOT found at ${sock}`);
    console.log(`   Try running with: -v /var/run/docker.sock:/var/run/docker.sock`);
    console.log(`   Or on Mac: -v ~/.docker/run/docker.sock:/var/run/docker.sock`);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} already in use.`);
  else console.error('Agent error:', err.message);
  process.exit(1);
});
