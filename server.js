/**
 * CRMTR v5 — Server
 * GET  /api/containers   — docker stats
 * GET  /api/docker-check — daemon check
 * GET  /api/logs         — container logs
 * GET  /api/events       — lifecycle events
 * GET  /api/inspect      — docker inspect (full detail + network)
 * POST /api/limits       — apply cpu/memory limits
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');
const PORT = 3000;

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.css' :'text/css; charset=utf-8',
  '.js'  :'application/javascript; charset=utf-8',
  '.json':'application/json',
  '.ico' :'image/x-icon',
};

function json(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});
  res.end(JSON.stringify(data));
}

function parseSize(s) {
  if (!s) return 0;
  s = s.trim(); const n = parseFloat(s); if (isNaN(n)) return 0;
  const l = s.toLowerCase();
  if (l.includes('gib')||l.includes('gb')) return n*1024;
  if (l.includes('mib')||l.includes('mb')) return n;
  if (l.includes('kib')||l.includes('kb')) return n/1024;
  return n/(1024*1024);
}
function parsePct(s)     { return parseFloat((s||'0').replace('%',''))||0; }
function parseIO(s)      { if(!s||!s.includes('/')) return 0; const p=s.split('/'); return Math.round((parseSize(p[0].trim())+parseSize(p[1].trim()))*10)/10; }
function parseMemUsage(s){ if(!s||!s.includes('/')) return {used:0,limit:0}; const p=s.split('/'); return {used:parseSize(p[0].trim()),limit:parseSize(p[1].trim())}; }

// ── DOCKER STATS ──────────────────────────
function getDockerStats(cb) {
  exec('docker stats --no-stream --format "{{json .}}"', {timeout:10000}, (err, stdout) => {
    if (err) return cb({error:err.message.split('\n')[0], containers:[]});
    if (!stdout.trim()) return cb({error:null, containers:[]});
    const containers = [];
    stdout.trim().split('\n').forEach(line => {
      try {
        const r   = JSON.parse(line.trim());
        const mem = parseMemUsage(r.MemUsage||'');
        containers.push({
          id:       (r.ID||r.Container||'').slice(0,12),
          name:     (r.Name||r.Container||'unknown').replace(/^\//,''),
          cpu:      Math.round(parsePct(r.CPUPerc)*10)/10,
          mem:      Math.round(parsePct(r.MemPerc)*10)/10,
          memUsed:  Math.round(mem.used*10)/10,
          memLimit: Math.round(mem.limit*10)/10,
          net:      parseIO(r.NetIO||''),
          dk:       parseIO(r.BlockIO||''),
          pids:     parseInt(r.PIDs)||0,
        });
      } catch(_){}
    });
    cb({error:null, containers});
  });
}

// ── DOCKER LOGS ───────────────────────────
function getDockerLogs(name, lines, cb) {
  exec(`docker logs --tail ${parseInt(lines)||100} "${name}" 2>&1`, {timeout:8000,maxBuffer:2*1024*1024}, (err, stdout) => {
    if (err && !stdout) return cb({error:err.message.split('\n')[0], lines:[]});
    const out = (stdout||'').trim();
    cb({error:null, lines: out ? out.split('\n') : []});
  });
}

// ── DOCKER EVENTS ─────────────────────────
let evSince = Math.floor(Date.now()/1000) - 300; // last 5 min on startup

function getDockerEvents(cb) {
  const until = Math.floor(Date.now()/1000);
  const since = evSince;
  evSince = until;
  exec(`docker events --since ${since} --until ${until} --filter type=container --format "{{json .}}" 2>/dev/null`, {timeout:5000}, (err, stdout) => {
    if (!stdout || !stdout.trim()) return cb([]);
    const evts = [];
    stdout.trim().split('\n').forEach(line => {
      try {
        const e = JSON.parse(line);
        evts.push({
          id:    (e.id||'').slice(0,12),
          name:  e.Actor?.Attributes?.name || '?',
          type:  e.Action || '?',
          image: e.Actor?.Attributes?.image || '',
          ts:    (e.time||Date.now()/1000)*1000,
        });
      } catch(_){}
    });
    cb(evts);
  });
}

// ── DOCKER INSPECT ────────────────────────
function getDockerInspect(name, cb) {
  exec(`docker inspect "${name}" 2>&1`, {timeout:6000}, (err, stdout) => {
    if (err) return cb({error:err.message.split('\n')[0]});
    try {
      const raw = JSON.parse(stdout);
      if (!raw || !raw.length) return cb({error:'No data'});
      const d = raw[0];

      // Created time
      const created = d.Created ? new Date(d.Created).toLocaleString() : '?';

      // Status + restarts
      const status   = d.State?.Status || '?';
      const restarts = d.RestartCount || 0;
      const startedAt = d.State?.StartedAt ? new Date(d.State.StartedAt).toLocaleString() : '?';

      // Image
      const image = d.Config?.Image || '?';

      // Ports: map host ports
      const portBindings = d.HostConfig?.PortBindings || {};
      const ports = Object.entries(portBindings).map(([cPort, bindings]) => {
        const host = bindings?.[0]?.HostPort || '?';
        return `${host}→${cPort}`;
      });

      // Environment variables — filter out secrets
      const envRaw = d.Config?.Env || [];
      const env = envRaw
        .filter(e => !/(password|secret|key|token|pass)/i.test(e))
        .slice(0, 10);

      // Volumes / mounts
      const mounts = (d.Mounts||[]).map(m => ({
        type: m.Type,
        src:  m.Source ? m.Source.slice(-40) : '?',
        dst:  m.Destination || '?',
        mode: m.Mode || 'rw',
      }));

      // Networks
      const nets = Object.entries(d.NetworkSettings?.Networks || {}).map(([netName, netInfo]) => ({
        network: netName,
        ip:      netInfo.IPAddress || '?',
        gateway: netInfo.Gateway   || '?',
        mac:     netInfo.MacAddress|| '?',
      }));

      // Resource limits
      const cpuQuota  = d.HostConfig?.CpuQuota  || 0;
      const cpuPeriod = d.HostConfig?.CpuPeriod || 100000;
      const cpuLimit  = cpuQuota > 0 ? (cpuQuota / cpuPeriod).toFixed(2) + ' cores' : 'unlimited';
      const memLimit  = d.HostConfig?.Memory > 0
        ? Math.round(d.HostConfig.Memory / 1024 / 1024) + ' MB'
        : 'unlimited';

      // Restart policy
      const restartPolicy = d.HostConfig?.RestartPolicy?.Name || 'none';

      // Hostname
      const hostname = d.Config?.Hostname || '?';

      cb({ error:null, name:d.Name?.replace('/',''), image, created, startedAt, status, restarts,
           cpuLimit, memLimit, restartPolicy, hostname, ports, env, mounts, nets });
    } catch(e) {
      cb({error:'Parse failed: '+e.message});
    }
  });
}

// ── DOCKER LIMITS ─────────────────────────
function applyDockerLimit(container, cpus, memory, cb) {
  let cmd = `docker update`;
  if (cpus)   cmd += ` --cpus "${parseFloat(cpus)}"`;
  if (memory) cmd += ` --memory "${memory}" --memory-swap "${memory}"`;
  cmd += ` "${container}"`;
  exec(cmd, {timeout:8000}, (err, stdout, stderr) => {
    if (err) return cb({ok:false, error:(stderr||err.message).split('\n')[0].slice(0,200)});
    cb({ok:true});
  });
}

// ── CI/CD STATUS STORE ───────────────────
// Stores pipeline build results posted from Jenkins / GitHub Actions
// Each pipeline keeps its last build + a rolling history of 20 builds
const cicdData = {
  pipelines: {},   // { pipelineName: { tool, status, branch, commit, ts, url, duration } }
  history:   [],   // last 50 builds across all pipelines
};

function handleCICD(req, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const d = JSON.parse(body);
      if (!d.pipeline || !d.status) return cb({ok:false, error:'pipeline and status required'});

      const entry = {
        tool:     d.tool     || 'Unknown',
        pipeline: d.pipeline,
        status:   (d.status || 'UNKNOWN').toUpperCase(),
        branch:   d.branch   || 'main',
        commit:   (d.commit  || '').slice(0, 8),
        duration: d.duration || 0,
        url:      d.url      || '',
        ts:       Date.now(),
      };

      cicdData.pipelines[entry.pipeline] = entry;
      cicdData.history.unshift(entry);
      if (cicdData.history.length > 50) cicdData.history.pop();

      console.log(`[CI/CD] ${entry.tool} · ${entry.pipeline} · ${entry.status} · ${entry.branch}`);
      cb({ ok: true });
    } catch(e) {
      cb({ ok: false, error: 'Invalid JSON: ' + e.message });
    }
  });
}

// ── STATIC FILES ──────────────────────────
function serveStatic(req, res) {
  let fp = path.join(__dirname, req.url==='/'?'index.html':req.url);
  if (!fp.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  const ext  = path.extname(fp).toLowerCase();
  const mime = MIME[ext]||'text/plain';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(err.code==='ENOENT'?404:500); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type':mime,'Cache-Control':'no-cache'});
    res.end(data);
  });
}

// ── MAIN SERVER ───────────────────────────
const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`);
  const m = req.method.toUpperCase();

  if (m==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    return res.end();
  }

  if (m==='GET'  && p.pathname==='/api/containers')
    return getDockerStats(r => json(res, r.error&&!r.containers.length?503:200, r));

  if (m==='GET'  && p.pathname==='/api/docker-check')
    return exec('docker info --format "{{.ServerVersion}}"', {timeout:4000}, (err,out) =>
      json(res, 200, err ? {available:false,reason:err.message.split('\n')[0]} : {available:true,version:out.trim()}));

  if (m==='GET'  && p.pathname==='/api/logs') {
    const name  = p.searchParams.get('name');
    const lines = p.searchParams.get('lines')||100;
    if (!name) return json(res, 400, {error:'name param required'});
    return getDockerLogs(name, lines, r => json(res, r.error?500:200, r));
  }

  if (m==='GET'  && p.pathname==='/api/events')
    return getDockerEvents(evts => json(res, 200, {events:evts}));

  if (m==='GET'  && p.pathname==='/api/inspect') {
    const name = p.searchParams.get('name');
    if (!name) return json(res, 400, {error:'name param required'});
    return getDockerInspect(name, r => json(res, r.error?500:200, r));
  }

  // GET /api/cicd — return all pipeline statuses and history
  if (m==='GET' && p.pathname==='/api/cicd')
    return json(res, 200, {
      pipelines: Object.values(cicdData.pipelines),
      history:   cicdData.history,
      ts:        Date.now(),
    });

  // POST /api/cicd — receive build result from Jenkins or GitHub Actions
  if (m==='POST' && p.pathname==='/api/cicd')
    return handleCICD(req, r => json(res, r.ok?200:400, r));

  if (m==='POST' && p.pathname==='/api/limits') {
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', ()=>{
      try {
        const {name,cpus,memory} = JSON.parse(body);
        if (!name) return json(res,400,{ok:false,error:'name required'});
        applyDockerLimit(name, cpus, memory, r => json(res, r.ok?200:500, r));
      } catch(_){ json(res,400,{ok:false,error:'Invalid JSON'}); }
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║      CRMTR v5 — Container Resource Monitor       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Dashboard  →  http://localhost:${PORT}              ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
  exec('docker info --format "{{.ServerVersion}}"', {timeout:3000}, (err,out) => {
    if(err) console.log('⚠  Docker not detected. Start Docker Desktop first.\n');
    else    console.log(`✓  Docker v${out.trim()} detected\n`);
  });
});

server.on('error', err => {
  if (err.code==='EADDRINUSE') console.error(`\n✗ Port ${PORT} in use.\n`);
  else console.error('\n✗ Server error:', err.message);
  process.exit(1);
});
