'use strict';
/**
 * Country lookup via ip-api.com's free batch endpoint (100 IPs per call, ~15 calls/min).
 * Results are cached in the geo table so each IP is looked up once.
 */
const { db } = require('./db');
const { log, emit } = require('./bus');

const queue = new Set();
let timer = null;
let busy = false;
let pauseUntil = 0;

const getCached = db.prepare('SELECT country, country_code FROM geo WHERE ip = ?');
const putGeo = db.prepare(
  'INSERT INTO geo (ip, country, country_code, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET country=excluded.country, country_code=excluded.country_code, updated_at=excluded.updated_at'
);
const applyGeo = db.prepare('UPDATE proxies SET country = ?, country_code = ? WHERE ip = ?');

function enqueue(ip) {
  const hit = getCached.get(ip);
  if (hit) {
    applyGeo.run(hit.country, hit.country_code, ip);
    return;
  }
  queue.add(ip);
  schedule();
}

function schedule(delay = 1500) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, Math.max(delay, pauseUntil - Date.now()));
}

async function flush() {
  if (busy || queue.size === 0) return;
  busy = true;
  const batch = [...queue].slice(0, 100);
  try {
    const res = await fetch('http://ip-api.com/batch?fields=status,country,countryCode,query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(15000),
    });
    const remaining = Number(res.headers.get('x-rl'));
    const ttl = Number(res.headers.get('x-ttl'));
    if (res.status === 429 || remaining === 0) pauseUntil = Date.now() + (ttl || 60) * 1000 + 500;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const now = Date.now();
    db.transaction(() => {
      for (const r of rows) {
        queue.delete(r.query);
        if (r.status !== 'success') continue;
        putGeo.run(r.query, r.country, r.countryCode, now);
        applyGeo.run(r.country, r.countryCode, r.query);
      }
    })();
    emit('geo', { count: rows.length });
  } catch (e) {
    log.warn(`Geo lookup failed (${e.message}); will retry`);
    pauseUntil = Date.now() + 20000;
  } finally {
    busy = false;
    if (queue.size) schedule(4200); // stay under 15 requests/minute
  }
}

module.exports = { enqueue };
