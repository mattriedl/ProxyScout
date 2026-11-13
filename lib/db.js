'use strict';
const path = require('path');
const fs = require('fs');

// Node's built-in SQLite (no native build step). Silence its one-time "experimental" notice on Node 22.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite/i.test(String(warning && warning.message ? warning.message : warning))) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new DatabaseSync(path.join(DATA_DIR, 'proxyscout.db'));
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

const db = {
  exec: (sql) => sqlite.exec(sql),
  prepare: (sql) => sqlite.prepare(sql),
  /** Returns a function that runs `fn` inside a transaction (same shape as better-sqlite3). */
  transaction: (fn) => (...args) => {
    sqlite.exec('BEGIN');
    try {
      const out = fn(...args);
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      try { sqlite.exec('ROLLBACK'); } catch {}
      throw e;
    }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL DEFAULT 'http',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  max_proxies INTEGER NOT NULL DEFAULT 0,
  last_count INTEGER,
  last_status TEXT,
  last_run INTEGER
);
CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'untested',
  latency INTEGER,
  anonymity TEXT,
  google INTEGER,
  ssl INTEGER,
  country TEXT,
  country_code TEXT,
  exit_ip TEXT,
  source TEXT,
  error TEXT,
  fails INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  UNIQUE (ip, port, protocol)
);
CREATE INDEX IF NOT EXISTS ix_proxies_status ON proxies(status);
CREATE INDEX IF NOT EXISTS ix_proxies_latency ON proxies(latency);
CREATE INDEX IF NOT EXISTS ix_proxies_ip ON proxies(ip);
CREATE TABLE IF NOT EXISTS geo (
  ip TEXT PRIMARY KEY,
  country TEXT,
  country_code TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------- Built-in sources ----------
const BUILTIN_SOURCES = [
  ['TheSpeedX · HTTP', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', 'http'],
  ['TheSpeedX · SOCKS4', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt', 'socks4'],
  ['TheSpeedX · SOCKS5', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', 'socks5'],
  ['monosans · HTTP', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', 'http'],
  ['monosans · SOCKS4', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt', 'socks4'],
  ['monosans · SOCKS5', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', 'socks5'],
  ['ProxyScrape · HTTP', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text', 'http'],
  ['Proxifly · All protocols', 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt', 'auto'],
  ['hookzof · SOCKS5', 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', 'socks5'],
  ['roosterkid · HTTPS', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', 'http'],
  ['vakhov · Fresh HTTP', 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt', 'http'],
  ['Free-Proxy-List.net', 'https://free-proxy-list.net/', 'http'],
];

const seed = db.prepare(
  'INSERT OR IGNORE INTO sources (name, url, protocol, enabled, builtin) VALUES (?, ?, ?, ?, 1)'
);
db.transaction(() => {
  BUILTIN_SOURCES.forEach(([name, url, proto], i) => seed.run(name, url, proto, i < 8 ? 1 : 0));
})();

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  scrapeThreads: 10,
  scrapeTimeout: 20000,
  perSourceLimit: 3000,
  autoCheckAfterScrape: true,
  checkThreads: 150,
  checkTimeout: 8000,
  retries: 0,
  targetUrl: '',
  mustContain: '',
  judgeUrl: 'http://httpbin.org/get',
  checkAnonymity: true,
  checkGoogle: true,
  geoLookup: true,
  autoPurgeDead: false,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const LIMITS = {
  scrapeThreads: [1, 100],
  scrapeTimeout: [2000, 120000],
  perSourceLimit: [0, 1000000],
  checkThreads: [1, 1000],
  checkTimeout: [1000, 60000],
  retries: [0, 5],
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in DEFAULT_SETTINGS) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        /* ignore corrupt value */
      }
    }
  }
  return out;
}

function saveSettings(patch) {
  const current = getSettings();
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[key];
      let v = raw;
      if (typeof def === 'number') {
        v = Math.round(Number(raw));
        if (!Number.isFinite(v)) continue;
        if (LIMITS[key]) v = Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], v));
      } else if (typeof def === 'boolean') {
        v = raw === true || raw === 'true' || raw === 1 || raw === '1';
      } else {
        v = String(raw ?? '').trim().slice(0, 2000);
      }
      current[key] = v;
      up.run(key, JSON.stringify(v));
    }
  })();
  return current;
}

// ---------- Proxy writes ----------
const insertProxy = db.prepare(
  'INSERT OR IGNORE INTO proxies (ip, port, protocol, source, created_at) VALUES (?, ?, ?, ?, ?)'
);

/** Inserts proxies, returns how many were new. */
function insertProxies(list, source) {
  const now = Date.now();
  let added = 0;
  db.transaction(() => {
    for (const p of list) added += insertProxy.run(p.ip, p.port, p.protocol, source, now).changes;
  })();
  return added;
}

module.exports = { db, DATA_DIR, getSettings, saveSettings, insertProxies, DEFAULT_SETTINGS };
