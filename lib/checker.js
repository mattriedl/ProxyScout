'use strict';
const { db, getSettings } = require('./db');
const { request } = require('./net');
const { log, emit, throttle } = require('./bus');
const { runPool } = require('./pool');
const geo = require('./geo');

// IPv4 not embedded in a version string ("Chrome/130.0.0.0") or a longer dotted token.
const IPV4_RE = /(?<![\w./-])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\w.])/g;

/** Judge output with the judge's own hostname removed (it appears in the echoed Host header). */
function judgeText(resp, judgeUrl) {
  let host = '';
  try {
    host = new URL(judgeUrl).hostname;
  } catch {}
  return host ? String(resp.body).split(host).join('') : String(resp.body);
}
const PROXY_HEADER_RE =
  /(?:^|["\s_])(via|x-forwarded-for|forwarded|x-real-ip|x-proxy-id|client-ip|x-client-ip|proxy-connection|x-bluecoat-via|http_via|http_x_forwarded_for|http_forwarded|http_x_real_ip|http_client_ip|http_proxy_connection)["\s:=]/i;
const GOOGLE_URL = 'https://www.google.com/';

let realIpCache = { judge: null, ips: [], at: 0 };

/** Find this server's own public IP(s) by calling the judge directly. */
async function detectRealIps(judgeUrl, opts) {
  if (realIpCache.judge === judgeUrl && Date.now() - realIpCache.at < 10 * 60 * 1000) return realIpCache.ips;
  const ips = new Set((process.env.PUBLIC_IP || '').split(',').map((x) => x.trim()).filter(Boolean));
  try {
    const r = await request(null, judgeUrl, { timeout: 10000, userAgent: opts.userAgent });
    for (const ip of judgeText(r, judgeUrl).match(IPV4_RE) || []) ips.add(ip);
  } catch (e) {
    log.warn(`Could not reach proxy judge directly (${e.message}). Transparent proxies may be reported as anonymous.`);
  }
  realIpCache = { judge: judgeUrl, ips: [...ips], at: Date.now() };
  if (ips.size) log.info(`Your public IP (from judge): ${[...ips].join(', ')}`);
  return realIpCache.ips;
}

function classifyAnonymity(resp, realIps, judgeUrl) {
  const text = judgeText(resp, judgeUrl);
  const found = text.match(IPV4_RE) || [];
  const exitIp = found.find((ip) => !realIps.includes(ip)) || null;
  if (realIps.some((ip) => found.includes(ip))) return { level: 'transparent', exitIp };
  if (PROXY_HEADER_RE.test(text)) return { level: 'anonymous', exitIp };
  return { level: 'elite', exitIp };
}

const ERROR_LABELS = {
  ECONNREFUSED: 'refused',
  ETIMEOUT: 'timeout',
  ETIMEDOUT: 'timeout',
  ECONNRESET: 'reset',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  EPIPE: 'reset',
};
function shortError(e) {
  const raw = String(e.code || e.message || e);
  const code = (/\b(E[A-Z]{4,})\b/.exec(raw) || [])[1];
  if (code) return ERROR_LABELS[code] || code.toLowerCase();
  if (/timed? ?out/i.test(raw)) return 'timeout';
  if (/socket closed|connection closed/i.test(raw)) return 'closed';
  return raw.replace(/^Error:\s*/, '').slice(0, 60);
}

/** Test one proxy. Never throws. */
async function checkProxy(row, cfg, realIps) {
  const opts = { timeout: cfg.checkTimeout, userAgent: cfg.userAgent };
  const target = cfg.targetUrl || cfg.judgeUrl;
  const out = { status: 'dead', protocol: row.protocol, latency: null, anonymity: null, google: null, ssl: null, exit_ip: null, error: null };

  const candidates = row.protocol === 'auto' ? ['http', 'socks5', 'socks4'] : [row.protocol];
  let res = null;
  let proxy = null;
  for (const protocol of candidates) {
    const p = { ip: row.ip, port: row.port, protocol };
    try {
      res = await request(p, target, opts);
      proxy = p;
      break;
    } catch (e) {
      out.error = shortError(e);
    }
  }
  if (!res) return out;

  if (res.status < 200 || res.status >= 400) {
    out.error = `HTTP ${res.status}`;
    return out;
  }
  if (cfg.mustContain && !res.body.includes(cfg.mustContain)) {
    out.error = 'content mismatch';
    return out;
  }

  out.status = 'working';
  out.error = null;
  out.protocol = proxy.protocol;
  out.latency = res.ttfb ?? res.ms;

  if (cfg.checkAnonymity) {
    let judgeRes = target === cfg.judgeUrl ? res : null;
    if (!judgeRes) judgeRes = await request(proxy, cfg.judgeUrl, opts).catch(() => null);
    if (judgeRes && judgeRes.status >= 200 && judgeRes.status < 400) {
      const a = classifyAnonymity(judgeRes, realIps, cfg.judgeUrl);
      out.anonymity = a.level;
      out.exit_ip = a.exitIp;
    }
  }

  if (cfg.checkGoogle) {
    try {
      const g = await request(proxy, GOOGLE_URL, opts);
      const blocked =
        /\/sorry\//.test(g.headers.location || '') || /unusual traffic|captcha/i.test(g.body.slice(0, 20000));
      out.google = g.status >= 200 && g.status < 400 && !blocked ? 1 : 0;
      if (proxy.protocol === 'http') out.ssl = 1; // TLS through CONNECT succeeded
    } catch {
      out.google = 0;
      if (proxy.protocol === 'http') out.ssl = 0;
    }
  }
  return out;
}

const SCOPE_SQL = {
  untested: "status = 'untested'",
  all: '1 = 1',
  dead: "status = 'dead'",
  working: "status = 'working'",
};

class Checker {
  constructor() {
    this.state = { running: false };
    this.stopRequested = false;
    this.push = throttle(() => emit('check', this.snapshot()), 300);
  }

  snapshot() {
    const st = this.state;
    if (!st.running && !st.total) return st;
    const elapsed = ((st.finishedAt || Date.now()) - st.startedAt) / 1000;
    const rate = elapsed > 0 ? st.done / elapsed : 0;
    return { ...st, elapsed, rate, eta: rate > 0 ? (st.total - st.done) / rate : null };
  }

  stop() {
    if (!this.state.running) return false;
    this.stopRequested = true;
    log.warn('Checker: stop requested — waiting for in-flight tests');
    return true;
  }

  async start({ scope = 'untested', ids = null, overrides = {} } = {}) {
    if (this.state.running) throw new Error('Checker is already running');
    const cfg = { ...getSettings(), ...overrides };

    let rows;
    if (scope === 'ids') {
      if (!Array.isArray(ids) || !ids.length) throw new Error('No proxies selected');
      rows = [];
      for (let i = 0; i < ids.length; i += 900) {
        const chunk = ids.slice(i, i + 900);
        rows.push(...db.prepare(`SELECT id, ip, port, protocol FROM proxies WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
      }
    } else {
      const where = SCOPE_SQL[scope];
      if (!where) throw new Error(`Unknown scope "${scope}"`);
      rows = db.prepare(`SELECT id, ip, port, protocol FROM proxies WHERE ${where} ORDER BY id`).all();
    }
    if (!rows.length) throw new Error('Nothing to check for this selection');

    this.stopRequested = false;
    const st = (this.state = {
      running: true,
      scope,
      startedAt: Date.now(),
      finishedAt: null,
      total: rows.length,
      done: 0,
      working: 0,
      dead: 0,
      elite: 0,
      google: 0,
      recent: [],
    });
    log.info(`Checker: testing ${rows.length.toLocaleString()} proxies · ${cfg.checkThreads} threads · ${cfg.checkTimeout}ms timeout`);
    this.push();

    (async () => {
      const realIps = cfg.checkAnonymity ? await detectRealIps(cfg.judgeUrl, cfg) : [];
      const save = db.prepare(`
        UPDATE proxies SET status=@status, latency=@latency, anonymity=@anonymity, google=@google, ssl=COALESCE(@ssl, ssl),
          exit_ip=@exit_ip, error=@error, checks=checks+1,
          fails=CASE WHEN @status='working' THEN 0 ELSE fails+1 END, checked_at=@now
        WHERE id=@id`);
      const setProto = db.prepare('UPDATE proxies SET protocol = ? WHERE id = ?');
      const findDup = db.prepare('SELECT id FROM proxies WHERE ip = ? AND port = ? AND protocol = ?');
      const del = db.prepare('DELETE FROM proxies WHERE id = ?');

      await runPool(rows, cfg.checkThreads, async (row) => {
        if (this.stopRequested) return;
        let r;
        for (let attempt = 0; attempt <= cfg.retries; attempt++) {
          r = await checkProxy(row, cfg, realIps);
          if (r.status === 'working' || this.stopRequested) break;
        }
        let id = row.id;
        if (r.protocol !== row.protocol) {
          // An 'auto' proxy resolved to a concrete protocol; merge with an existing row if one exists.
          const dup = findDup.get(row.ip, row.port, r.protocol);
          if (dup) {
            del.run(row.id);
            id = dup.id;
          } else setProto.run(r.protocol, row.id);
        }
        save.run({ ...r, id, now: Date.now() });

        st.done += 1;
        if (r.status === 'working') {
          st.working += 1;
          if (r.anonymity === 'elite') st.elite += 1;
          if (r.google === 1) st.google += 1;
          st.recent.unshift({ id, ip: row.ip, port: row.port, protocol: r.protocol, ssl: r.ssl, latency: r.latency, anonymity: r.anonymity, google: r.google });
          if (st.recent.length > 40) st.recent.length = 40;
          if (cfg.geoLookup) geo.enqueue(row.ip);
        } else st.dead += 1;
        this.push();
      });

      st.running = false;
      st.finishedAt = Date.now();
      if (this.stopRequested) st.stopped = true;
      let purged = 0;
      if (cfg.autoPurgeDead) purged = db.prepare("DELETE FROM proxies WHERE status = 'dead'").run().changes;
      const secs = ((st.finishedAt - st.startedAt) / 1000).toFixed(1);
      log.ok(
        `Checker ${st.stopped ? 'stopped' : 'finished'} in ${secs}s — ${st.working.toLocaleString()} working, ${st.dead.toLocaleString()} dead` +
          (purged ? `, ${purged.toLocaleString()} dead purged` : '')
      );
      emit('check', this.snapshot());
      emit('stats', {});
    })().catch((e) => {
      st.running = false;
      log.error(`Checker crashed: ${e.message}`);
      emit('check', this.snapshot());
    });

    return this.snapshot();
  }
}

module.exports = { Checker, checkProxy, classifyAnonymity };
