'use strict';
const { db, getSettings, insertProxies } = require('./db');
const { parseProxies } = require('./parse');
const { log, emit, throttle } = require('./bus');
const { runPool } = require('./pool');

async function fetchText(url, timeout, userAgent) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': userAgent, accept: 'text/plain,text/html,application/json,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text.length > 30e6 ? text.slice(0, 30e6) : text;
}

class Scraper {
  constructor() {
    this.state = { running: false };
    this.stopRequested = false;
    this.onFinish = null;
    this.push = throttle(() => emit('scrape', this.snapshot()), 250);
  }

  snapshot() {
    return this.state;
  }

  stop() {
    if (!this.state.running) return false;
    this.stopRequested = true;
    log.warn('Scraper: stop requested — finishing in-flight sources');
    return true;
  }

  async start({ sourceIds } = {}) {
    if (this.state.running) throw new Error('Scraper is already running');
    const s = getSettings();
    const sources = Array.isArray(sourceIds) && sourceIds.length
      ? db.prepare(`SELECT * FROM sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
      : db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
    if (!sources.length) throw new Error('No sources selected');

    this.stopRequested = false;
    const st = (this.state = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      total: sources.length,
      done: 0,
      found: 0,
      added: 0,
      errors: 0,
      sources: sources.map((x) => ({ id: x.id, name: x.name, status: 'queued', count: 0, added: 0, error: null, ms: null })),
    });
    log.info(`Scraper: starting ${sources.length} source(s) with ${s.scrapeThreads} thread(s)`);
    this.push();

    const markSource = db.prepare('UPDATE sources SET last_count = ?, last_status = ?, last_run = ? WHERE id = ?');

    // Run the job in the background; the HTTP call returns immediately.
    (async () => {
      await runPool(sources, s.scrapeThreads, async (src, i) => {
        const row = st.sources[i];
        if (this.stopRequested) {
          row.status = 'skipped';
          return;
        }
        row.status = 'running';
        this.push();
        const t0 = Date.now();
        try {
          const text = await fetchText(src.url, s.scrapeTimeout, s.userAgent);
          let list = parseProxies(text, src.protocol);
          const limit = src.max_proxies > 0 ? src.max_proxies : s.perSourceLimit;
          if (limit > 0 && list.length > limit) list = list.slice(0, limit);
          const added = insertProxies(list, src.name);
          Object.assign(row, { status: 'done', count: list.length, added, ms: Date.now() - t0 });
          st.found += list.length;
          st.added += added;
          markSource.run(list.length, 'ok', Date.now(), src.id);
          log.ok(`${src.name}: ${list.length.toLocaleString()} proxies, ${added.toLocaleString()} new`);
        } catch (e) {
          const msg = e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message;
          Object.assign(row, { status: 'error', error: msg, ms: Date.now() - t0 });
          st.errors += 1;
          markSource.run(0, `error: ${msg}`, Date.now(), src.id);
          log.error(`${src.name}: ${msg}`);
        } finally {
          st.done += 1;
          this.push();
        }
      });

      st.running = false;
      st.finishedAt = Date.now();
      const secs = ((st.finishedAt - st.startedAt) / 1000).toFixed(1);
      log.ok(
        `Scraper finished in ${secs}s — ${st.found.toLocaleString()} found, ${st.added.toLocaleString()} new, ${(st.found - st.added).toLocaleString()} duplicates`
      );
      emit('scrape', this.snapshot());
      emit('stats', {});
      if (this.onFinish) this.onFinish(st, s);
    })().catch((e) => {
      st.running = false;
      log.error(`Scraper crashed: ${e.message}`);
      emit('scrape', this.snapshot());
    });

    return st;
  }
}

module.exports = { Scraper, fetchText };
