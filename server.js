'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { db, getSettings, saveSettings, insertProxies, DATA_DIR } = require('./lib/db');
const { parseProxies } = require('./lib/parse');
const { bus, logs, log, emit } = require('./lib/bus');
const { Scraper, fetchText } = require('./lib/scraper');
const { Checker } = require('./lib/checker');
const pkg = require('./package.json');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Never let search engines index this tool, whatever domain it is served on.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// ---------- Built-in proxy judge (public, no auth) ----------
// Echoes the caller's address and request headers, like the classic azenv.net judge.
app.get('/judge', (req, res) => {
  const lines = [`REMOTE_ADDR = ${(req.socket.remoteAddress || '').replace(/^::ffff:/, '')}`];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`HTTP_${k.toUpperCase().replace(/-/g, '_')} = ${v}`);
  res.type('text/plain').set('Cache-Control', 'no-store').send(lines.join('\n') + '\n');
});

// ---------- Optional basic auth ----------
if (APP_PASSWORD) {
  const expected = Buffer.from(`${APP_USER}:${APP_PASSWORD}`);
  app.use((req, res, next) => {
    const raw = (req.headers.authorization || '').replace(/^Basic\s+/i, '');
    const given = Buffer.from(raw, 'base64');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="ProxyScout", charset="UTF-8"').status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

const scraper = new Scraper();
const checker = new Checker();
scraper.onFinish = (st, s) => {
  if (s.autoCheckAfterScrape && st.added > 0 && !checker.state.running) {
    log.info('Auto-check: sending new proxies to the checker');
    checker.start({ scope: 'untested' }).catch((e) => log.warn(`Auto-check skipped: ${e.message}`));
  }
};

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Live events (SSE) ----------
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  send({ type: 'hello', data: { version: pkg.version, scrape: scraper.snapshot(), check: checker.snapshot(), logs: logs.slice(-300) } });
  bus.on('event', send);
  const ka = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    bus.off('event', send);
    clearInterval(ka);
  });
});

// ---------- Stats ----------
app.get(
  '/api/stats',
  wrap(() => {
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM proxies GROUP BY status').all().map((r) => [r.status, r.c]));
    const W = "status = 'working'";
    const typeRows = db
      .prepare(`SELECT CASE WHEN protocol='http' AND ssl=1 THEN 'https' ELSE protocol END t, COUNT(*) c FROM proxies WHERE ${W} GROUP BY t`)
      .all();
    const anonRows = db.prepare(`SELECT COALESCE(anonymity,'unknown') a, COUNT(*) c FROM proxies WHERE ${W} GROUP BY a`).all();
    const countries = db
      .prepare(`SELECT country_code cc, MAX(country) name, COUNT(*) c FROM proxies WHERE ${W} AND country_code IS NOT NULL GROUP BY cc ORDER BY c DESC LIMIT 10`)
      .all();
    const agg = db.prepare(`SELECT AVG(latency) avg, MIN(latency) min, SUM(google=1) google, COUNT(DISTINCT country_code) countries FROM proxies WHERE ${W}`).get();
    const buckets = [250, 500, 1000, 2000, 4000, Infinity];
    const latRows = db.prepare(`SELECT latency FROM proxies WHERE ${W} AND latency IS NOT NULL`).raw().all();
    const hist = buckets.map(() => 0);
    for (const [l] of latRows) hist[buckets.findIndex((b) => l < b)] += 1;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    return {
      total,
      working: byStatus.working || 0,
      dead: byStatus.dead || 0,
      untested: byStatus.untested || 0,
      types: Object.fromEntries(typeRows.map((r) => [r.t, r.c])),
      anonymity: Object.fromEntries(anonRows.map((r) => [r.a, r.c])),
      countries,
      avgLatency: agg.avg ? Math.round(agg.avg) : null,
      minLatency: agg.min,
      google: agg.google || 0,
      countryCount: agg.countries || 0,
      latency: { buckets: ['<250ms', '250–500', '0.5–1s', '1–2s', '2–4s', '4s+'], counts: hist },
      sources: db.prepare('SELECT COUNT(*) c, SUM(enabled) e FROM sources').get(),
    };
  })
);

// ---------- Sources ----------
const PROTOCOLS = ['http', 'socks4', 'socks5', 'auto'];
function cleanSource(b) {
  const name = String(b.name || '').trim().slice(0, 80);
  const url = String(b.url || '').trim();
  const protocol = PROTOCOLS.includes(b.protocol) ? b.protocol : 'http';
  const max_proxies = Math.max(0, Math.round(Number(b.max_proxies) || 0));
  if (!/^https?:\/\/\S+$/i.test(url)) throw httpError(400, 'Source URL must start with http:// or https://');
  return { name: name || new URL(url).hostname, url, protocol, max_proxies };
}

app.get('/api/sources', wrap(() => db.prepare('SELECT * FROM sources ORDER BY builtin DESC, id').all()));
app.post(
  '/api/sources',
  wrap((req) => {
    const s = cleanSource(req.body);
    try {
      const r = db.prepare('INSERT INTO sources (name, url, protocol, max_proxies, enabled, builtin) VALUES (?, ?, ?, ?, 1, 0)').run(s.name, s.url, s.protocol, s.max_proxies);
      log.info(`Source added: ${s.name}`);
      return db.prepare('SELECT * FROM sources WHERE id = ?').get(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw httpError(409, 'That URL is already a source');
      throw e;
    }
  })
);
app.put(
  '/api/sources/:id',
  wrap((req) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!cur) throw httpError(404, 'Source not found');
    const next = { ...cur, ...req.body };
    const s = cleanSource(next);
    const enabled = next.enabled === true || next.enabled === 1 || next.enabled === '1' ? 1 : 0;
    db.prepare('UPDATE sources SET name=?, url=?, protocol=?, max_proxies=?, enabled=? WHERE id=?').run(s.name, s.url, s.protocol, s.max_proxies, enabled, id);
    return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  })
);
app.delete(
  '/api/sources/:id',
  wrap((req) => {
    const r = db.prepare('DELETE FROM sources WHERE id = ?').run(Number(req.params.id));
    if (!r.changes) throw httpError(404, 'Source not found');
    return { ok: true };
  })
);
app.post(
  '/api/sources/test',
  wrap(async (req) => {
    const s = cleanSource(req.body);
    const cfg = getSettings();
    const t0 = Date.now();
    const text = await fetchText(s.url, cfg.scrapeTimeout, cfg.userAgent);
    const list = parseProxies(text, s.protocol);
    return { count: list.length, ms: Date.now() - t0, sample: list.slice(0, 8).map((p) => `${p.protocol}://${p.ip}:${p.port}`) };
  })
);

// ---------- Jobs ----------
app.post('/api/scrape/start', wrap((req) => scraper.start({ sourceIds: req.body.sourceIds })));
app.post('/api/scrape/stop', wrap(() => ({ ok: scraper.stop() })));
app.post(
  '/api/check/start',
  wrap((req) => {
    if (req.body.settings) saveSettings(req.body.settings);
    return checker.start({ scope: req.body.scope || 'untested', ids: req.body.ids });
  })
);
app.post('/api/check/stop', wrap(() => ({ ok: checker.stop() })));

// ---------- Proxies ----------
const SORTABLE = {
  latency: 'latency',
  country: 'country_code',
  type: "CASE WHEN protocol='http' AND ssl=1 THEN 'https' ELSE protocol END",
  anonymity: "CASE anonymity WHEN 'elite' THEN 1 WHEN 'anonymous' THEN 2 WHEN 'transparent' THEN 3 END",
  google: 'google',
  checked: 'checked_at',
  added: 'created_at',
  proxy: 'ip',
  status: "CASE status WHEN 'working' THEN 1 WHEN 'untested' THEN 2 ELSE 3 END",
  source: 'source',
};

function buildWhere(q) {
  const w = [];
  const p = [];
  if (q.status) {
    w.push('status = ?');
    p.push(String(q.status));
  }
  if (q.type) {
    if (q.type === 'https') w.push("protocol = 'http' AND ssl = 1");
    else if (q.type === 'http') w.push("protocol = 'http' AND COALESCE(ssl,0) = 0");
    else {
      w.push('protocol = ?');
      p.push(String(q.type));
    }
  }
  if (q.anonymity) {
    w.push('anonymity = ?');
    p.push(String(q.anonymity));
  }
  if (q.google === '1') w.push('google = 1');
  if (q.google === '0') w.push('COALESCE(google,0) = 0');
  if (q.country) {
    w.push('country_code = ?');
    p.push(String(q.country).toUpperCase());
  }
  if (q.maxLatency) {
    w.push('latency <= ?');
    p.push(Number(q.maxLatency));
  }
  if (q.search) {
    const s = `%${String(q.search).trim()}%`;
    w.push("(ip || ':' || port LIKE ? OR country LIKE ? OR source LIKE ? OR exit_ip LIKE ?)");
    p.push(s, s, s, s);
  }
  if (q.ids) {
    const ids = (Array.isArray(q.ids) ? q.ids : String(q.ids).split(',')).map(Number).filter(Number.isFinite).slice(0, 50000);
    if (ids.length) {
      w.push(`id IN (SELECT value FROM json_each(?))`);
      p.push(JSON.stringify(ids));
    }
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

function orderBy(q) {
  const col = SORTABLE[q.sort] || SORTABLE.status;
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const tie = q.sort === 'latency' ? '' : ', latency IS NULL, latency ASC';
  return `ORDER BY (${col}) IS NULL, ${col} ${dir}${tie}, id DESC`;
}

const COLUMNS = 'id, ip, port, protocol, status, latency, anonymity, google, ssl, country, country_code, exit_ip, source, error, checks, created_at, checked_at';

app.get(
  '/api/proxies',
  wrap((req) => {
    const q = req.query;
    const { sql, params } = buildWhere(q);
    const size = Math.min(500, Math.max(10, Number(q.pageSize) || 50));
    const page = Math.max(1, Number(q.page) || 1);
    const total = db.prepare(`SELECT COUNT(*) c FROM proxies ${sql}`).get(...params).c;
    const rows = db.prepare(`SELECT ${COLUMNS} FROM proxies ${sql} ${orderBy(q)} LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
    return { total, page, pageSize: size, rows };
  })
);

app.get(
  '/api/proxies/ids',
  wrap((req) => {
    const { sql, params } = buildWhere(req.query);
    return { ids: db.prepare(`SELECT id FROM proxies ${sql} LIMIT 200000`).raw().all(...params).map((r) => r[0]) };
  })
);

app.get(
  '/api/countries',
  wrap(() => db.prepare("SELECT country_code cc, MAX(country) name, COUNT(*) c FROM proxies WHERE country_code IS NOT NULL GROUP BY cc ORDER BY name").all())
);

app.post(
  '/api/proxies/import',
  wrap(async (req) => {
    const protocol = PROTOCOLS.includes(req.body.protocol) ? req.body.protocol : 'http';
    const list = parseProxies(String(req.body.text || ''), protocol, { allowPrivate: true });
    if (!list.length) throw httpError(400, 'No proxies found in the pasted text (expected ip:port per line)');
    insertProxies(list, 'Imported');
    // Look up ids for exactly these proxies so they can be checked right away.
    const find = db.prepare('SELECT id FROM proxies WHERE ip = ? AND port = ? AND protocol = ?');
    const ids = list.map((p) => find.get(p.ip, p.port, p.protocol)?.id).filter(Boolean);
    log.info(`Imported ${list.length.toLocaleString()} proxies from paste`);
    emit('stats', {});
    let check = null;
    if (req.body.check) check = await checker.start({ scope: 'ids', ids });
    return { imported: list.length, ids, check };
  })
);

app.post(
  '/api/proxies/delete',
  wrap((req) => {
    const b = req.body || {};
    let r;
    if (b.status) r = db.prepare('DELETE FROM proxies WHERE status = ?').run(String(b.status));
    else if (b.all === true) r = db.prepare('DELETE FROM proxies').run();
    else if (Array.isArray(b.ids) && b.ids.length) r = db.prepare('DELETE FROM proxies WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(b.ids));
    else throw httpError(400, 'Nothing to delete');
    log.info(`Deleted ${r.changes.toLocaleString()} proxies`);
    emit('stats', {});
    return { deleted: r.changes };
  })
);

// ---------- Export ----------
function typeOf(r) {
  return r.protocol === 'http' && r.ssl === 1 ? 'https' : r.protocol;
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.all(
  '/api/export',
  wrap((req, res) => {
    const q = { ...req.query, ...(req.body || {}) };
    const { sql, params } = buildWhere(q);
    const rows = db.prepare(`SELECT ${COLUMNS} FROM proxies ${sql} ${orderBy(q)}`).all(...params);
    const fmt = ['txt', 'url', 'csv', 'json'].includes(q.format) ? q.format : 'txt';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    let body;
    let type = 'text/plain';
    let ext = 'txt';
    if (fmt === 'txt') body = rows.map((r) => `${r.ip}:${r.port}`).join('\n');
    else if (fmt === 'url') body = rows.map((r) => `${r.protocol === 'auto' ? 'http' : r.protocol}://${r.ip}:${r.port}`).join('\n');
    else if (fmt === 'csv') {
      const head = ['ip', 'port', 'type', 'status', 'latency_ms', 'anonymity', 'google', 'country', 'country_code', 'exit_ip', 'source', 'checked_at'];
      body = [head.join(',')]
        .concat(
          rows.map((r) =>
            [r.ip, r.port, typeOf(r), r.status, r.latency, r.anonymity, r.google === null ? '' : r.google ? 'yes' : 'no', r.country, r.country_code, r.exit_ip, r.source, r.checked_at ? new Date(r.checked_at).toISOString() : '']
              .map(csvCell)
              .join(',')
          )
        )
        .join('\n');
      type = 'text/csv';
      ext = 'csv';
    } else {
      body = JSON.stringify(rows.map((r) => ({ ...r, type: typeOf(r) })), null, 2);
      type = 'application/json';
      ext = 'json';
    }
    if (q.inline === '1' || q.inline === true) return res.type('text/plain').send(body);
    res.type(type).attachment(`proxies-${stamp}.${ext}`).send(body + '\n');
  })
);

// ---------- Settings / logs / system ----------
app.get('/api/settings', wrap(() => getSettings()));
app.put('/api/settings', wrap((req) => saveSettings(req.body)));
app.get('/api/logs', wrap(() => logs.slice(-500)));
app.delete(
  '/api/logs',
  wrap(() => {
    logs.length = 0;
    return { ok: true };
  })
);
app.get('/api/info', wrap(() => ({ version: pkg.version, dataDir: DATA_DIR, node: process.version, auth: Boolean(APP_PASSWORD) })));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  log.info(`ProxyScout ${pkg.version} listening on http://${HOST}:${PORT}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !APP_PASSWORD) {
    log.warn('Listening on a public interface without APP_PASSWORD — anyone who can reach this port can use the app.');
  }
});
