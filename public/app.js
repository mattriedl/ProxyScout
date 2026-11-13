'use strict';
(() => {
  // ================= Helpers =================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icon = (id, cls = '') => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  function ms(v) {
    if (v === null || v === undefined) return '—';
    return v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} s`;
  }
  function dur(s) {
    if (s === null || s === undefined || !isFinite(s)) return '—';
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  function ago(t) {
    if (!t) return '—';
    const s = (Date.now() - t) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  const typeOf = (p) => (p.protocol === 'http' && p.ssl === 1 ? 'https' : p.protocol);
  const typeTag = (t) => `<span class="tag t-${t}">${t}</span>`;
  const flag = (cc, name) =>
    cc
      ? `<span class="cc" title="${esc(name || cc)}"><img class="flag" loading="lazy" alt="" src="https://flagcdn.com/w40/${cc.toLowerCase()}.png" onerror="this.style.visibility='hidden'">${esc(cc)}</span>`
      : '<span class="dash">—</span>';
  function latency(v) {
    if (v === null || v === undefined) return '<span class="dash">—</span>';
    const cls = v < 1000 ? 'lat-fast' : v < 3000 ? 'lat-mid' : 'lat-slow';
    const w = Math.max(6, Math.min(100, 100 - (Math.log10(Math.max(v, 50)) - 1.7) * 45));
    return `<span class="lat ${cls}"><span class="lat-bar"><i style="width:${w}%"></i></span>${ms(v)}</span>`;
  }
  const anon = (a) => (a ? `<span class="anon a-${a}">${a}</span>` : '<span class="dash">—</span>');
  const google = (g) => (g === 1 ? '<span class="yes">Pass</span>' : g === 0 ? '<span class="no">Fail</span>' : '<span class="dash">—</span>');
  const proxyCell = (p) =>
    `<span class="proxy-cell">${esc(p.ip)}<span class="port">:${p.port}</span><button class="copy-btn" data-copy="${esc(p.ip)}:${p.port}" title="Copy">${icon('copy')}</button></span>`;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    }, 3600);
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(label || 'Copied to clipboard', 'ok');
  }

  function confirmAction(msg) {
    return window.confirm(msg);
  }

  // ================= State =================
  const S = {
    view: 'dashboard',
    settings: {},
    stats: null,
    sources: [],
    scrape: { running: false },
    check: { running: false },
    q: { status: 'working', type: '', anonymity: '', google: '', country: '', maxLatency: '', search: '', sort: 'latency', dir: 'asc', page: 1, pageSize: 50 },
    rows: [],
    total: 0,
    selected: new Set(),
    scope: 'untested',
    logLevel: '',
    logs: [],
    unseenLogs: 0,
  };

  const VIEWS = {
    dashboard: ['Dashboard', 'Overview of your proxy pool'],
    scraper: ['Scraper', 'Collect proxies from public and custom sources'],
    checker: ['Checker', 'Test speed, anonymity, Google access and location'],
    proxies: ['Proxies', 'Filter, sort and export your proxy database'],
    settings: ['Settings', 'Requests, data and shortcuts'],
  };

  // ================= Navigation =================
  function go(view) {
    if (!VIEWS[view]) return;
    S.view = view;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $('#page-title').textContent = VIEWS[view][0];
    $('#page-sub').textContent = VIEWS[view][1];
    $('#sidebar').classList.remove('open');
    $('#content').scrollTop = 0;
    try { history.replaceState(null, '', `#${view}`); } catch {}
    if (view === 'proxies') loadProxies();
    if (view === 'dashboard') loadStats();
    if (view === 'scraper') loadSources();
    if (view === 'settings') loadInfo();
  }

  // ================= Settings binding =================
  function setRangeFill(input) {
    const p = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', `${p}%`);
    const out = $(`output[data-out="${input.dataset.setting}"]`);
    if (out) out.textContent = input.value;
  }

  function applySettings() {
    for (const el of $$('[data-setting]')) {
      const v = S.settings[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v ?? '';
      if (el.type === 'range') setRangeFill(el);
    }
  }

  const saveSetting = debounce(async (patch) => {
    try {
      S.settings = await api('/api/settings', { method: 'PUT', body: patch });
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, 350);
  const pending = {};
  const flushSetting = debounce(() => {
    const p = { ...pending };
    for (const k in pending) delete pending[k];
    saveSetting(p);
  }, 50);

  function bindSettings() {
    for (const el of $$('[data-setting]')) {
      const handler = () => {
        const k = el.dataset.setting;
        const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
        S.settings[k] = v;
        pending[k] = v;
        if (el.type === 'range') setRangeFill(el);
        flushSetting();
      };
      el.addEventListener(el.type === 'range' || el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'url' ? 'input' : 'change', handler);
    }
  }

  // ================= Stats / dashboard =================
  async function loadStats() {
    try {
      S.stats = await api('/api/stats');
      renderStats();
    } catch (e) {
      /* connection issues are surfaced by the SSE indicator */
    }
  }
  const loadStatsSoon = debounce(loadStats, 600);

  const TYPE_COLORS = { http: 'var(--c-http)', https: 'var(--c-https)', socks4: 'var(--c-socks4)', socks5: 'var(--c-socks5)', auto: 'var(--muted)' };
  const ANON_COLORS = { elite: 'var(--elite)', anonymous: 'var(--info)', transparent: 'var(--warn)', unknown: 'var(--border-2)' };

  function stackBar(el, legendEl, data, colors, order) {
    const entries = order.filter((k) => data[k]).map((k) => [k, data[k]]);
    const total = entries.reduce((a, [, v]) => a + v, 0);
    if (!total) {
      el.innerHTML = '';
      legendEl.innerHTML = '<span class="muted" style="--c:transparent">No working proxies yet</span>';
      return;
    }
    el.innerHTML = entries.map(([k, v]) => `<i style="flex-grow:${v};background:${colors[k]}" title="${k}: ${v}"></i>`).join('');
    legendEl.innerHTML = entries
      .map(([k, v]) => `<span style="--c:${colors[k]}">${k === 'unknown' ? 'Not graded' : k[0].toUpperCase() + k.slice(1)} <b>${fmt(v)}</b> <span class="muted">${pct(v, total)}%</span></span>`)
      .join('');
  }

  function renderStats() {
    const st = S.stats;
    if (!st) return;
    const anonElite = st.anonymity.elite || 0;
    $('#k-working').innerHTML = fmt(st.working);
    $('#k-working-foot').textContent = `of ${fmt(st.total)} in database · ${pct(st.working, st.working + st.dead)}% alive`;
    $('#k-elite').textContent = fmt(anonElite);
    $('#k-elite-foot').textContent = st.working ? `${pct(anonElite, st.working)}% of working` : ' ';
    $('#k-google').textContent = fmt(st.google);
    $('#k-google-foot').textContent = st.working ? `${pct(st.google, st.working)}% of working` : ' ';
    $('#k-latency').innerHTML = st.avgLatency ? (st.avgLatency < 1000 ? `${st.avgLatency}<small>ms</small>` : `${(st.avgLatency / 1000).toFixed(2)}<small>s</small>`) : '—';
    $('#k-latency-foot').textContent = st.minLatency ? `fastest ${ms(st.minLatency)}` : ' ';
    $('#k-countries').textContent = fmt(st.countryCount);
    $('#k-untested').textContent = `${fmt(st.untested)} untested`;
    $('#nav-working').textContent = fmt(st.working);
    $('#d-fastest').textContent = st.working ? `${fmt(st.working)} working` : '';

    for (const [k, v] of Object.entries({ untested: st.untested, dead: st.dead, working: st.working, total: st.total })) {
      $$(`[data-count="${k}"]`).forEach((b) => (b.textContent = fmt(v)));
    }
    $('#step-check-desc').textContent = st.untested ? `${fmt(st.untested)} proxies waiting to be tested.` : 'Speed, anonymity, Google and country.';

    stackBar($('#d-types'), $('#d-types-legend'), st.types, TYPE_COLORS, ['http', 'https', 'socks4', 'socks5', 'auto']);
    stackBar($('#d-anon'), $('#d-anon-legend'), st.anonymity, ANON_COLORS, ['elite', 'anonymous', 'transparent', 'unknown']);

    const max = Math.max(1, ...st.latency.counts);
    $('#d-hist').innerHTML = st.latency.counts
      .map((c, i) => `<div class="hist-col"><span class="hist-val">${c ? fmt(c) : ''}</span><div class="hist-bar" style="height:${c ? Math.max(3, (c / max) * 82) : 0}%"></div><span class="hist-label">${st.latency.buckets[i]}</span></div>`)
      .join('');

    const cmax = Math.max(1, ...st.countries.map((c) => c.c));
    $('#d-countries').innerHTML = st.countries.length
      ? st.countries
          .map(
            (c) =>
              `<div class="bar-row"><img class="flag" loading="lazy" alt="" src="https://flagcdn.com/w40/${c.cc.toLowerCase()}.png" onerror="this.style.visibility='hidden'"><div><div class="bar-name"><span>${esc(c.name || c.cc)}</span></div><div class="bar-track"><i style="width:${(c.c / cmax) * 100}%"></i></div></div><span class="bar-count">${fmt(c.c)}</span></div>`
          )
          .join('')
      : '<div class="empty-state">Countries appear after proxies are tested.</div>';

    loadFastest();
  }

  async function loadFastest() {
    try {
      const r = await api('/api/proxies?status=working&sort=latency&dir=asc&pageSize=10');
      $('#d-fast').innerHTML = r.rows.length
        ? r.rows
            .slice(0, 8)
            .map((p) => `<div class="mini-row">${proxyCell(p)}${typeTag(typeOf(p))}${flag(p.country_code, p.country)}${latency(p.latency)}</div>`)
            .join('')
        : '<div class="empty-state">No working proxies yet — run the scraper, then the checker.</div>';
    } catch {}
  }

  // ================= Jobs (scrape / check) =================
  function setJobWidget(id, st, label) {
    const el = $(id);
    el.classList.toggle('running', !!st.running);
    const p = st.total ? (st.done / st.total) * 100 : 0;
    $('.meter i', el).style.width = `${st.running ? p : 0}%`;
    $('.job-state', el).textContent = st.running ? label : 'Idle';
  }

  function setToggleBtn(btn, running, startLabel, stopLabel) {
    btn.classList.toggle('is-stop', running);
    btn.classList.add('btn-primary');
    btn.innerHTML = running ? `${icon('stop')}<span>${stopLabel}</span>` : `${icon('play')}<span>${startLabel}</span>`;
  }

  function renderScrape() {
    const st = S.scrape;
    setJobWidget('#job-scrape', st, `${st.done}/${st.total}`);
    $$('[data-action="scrape-toggle"]').forEach((b) => setToggleBtn(b, st.running, 'Start scraper', 'Stop scraper'));
    $('#step-scrape').classList.toggle('running', !!st.running);
    $('#step-scrape-desc').textContent = st.running
      ? `Fetching… ${st.done}/${st.total} sources, ${fmt(st.added)} new`
      : st.finishedAt
        ? `Last run: ${fmt(st.found)} found, ${fmt(st.added)} new · ${ago(st.finishedAt)}`
        : 'Pull fresh lists from your enabled sources.';
    $('#s-state').textContent = st.running ? 'Running' : st.finishedAt ? 'Finished' : 'Idle';
    $('#s-state').classList.toggle('running', !!st.running);
    $('#s-done').textContent = `${st.done || 0}/${st.total || S.sources.filter((s) => s.enabled).length}`;
    $('#s-found').textContent = fmt(st.found || 0);
    $('#s-added').textContent = fmt(st.added || 0);
    $('#s-dupes').textContent = fmt((st.found || 0) - (st.added || 0));
    $('#s-bar').style.width = `${st.total ? (st.done / st.total) * 100 : 0}%`;
    $('#s-bar').parentElement.classList.toggle('running', !!st.running);
    renderSources();
  }

  function renderCheck() {
    const st = S.check;
    const total = st.total || 0;
    const done = st.done || 0;
    const p = total ? done / total : 0;
    setJobWidget('#job-check', st, `${Math.round(p * 100)}%`);
    setToggleBtn($('#c-btn'), st.running, 'Start proxy test', 'Stop test');
    $('#step-check').classList.toggle('running', !!st.running);
    if (st.running) $('#step-check-desc').textContent = `Testing… ${fmt(done)}/${fmt(total)} · ${fmt(st.working)} working`;
    const ring = $('#c-ring');
    ring.classList.toggle('running', !!st.running);
    $('#c-ring-fg').style.strokeDashoffset = 326.73 * (1 - p);
    $('#c-pct').textContent = `${Math.floor(p * 100)}%`;
    $('#c-state').textContent = st.running ? 'Testing' : st.stopped ? 'Stopped' : st.finishedAt ? 'Complete' : 'Idle';
    $('#c-done').textContent = `${fmt(done)} / ${fmt(total)}`;
    $('#c-working').textContent = fmt(st.working || 0);
    $('#c-dead').textContent = fmt(st.dead || 0);
    $('#c-rate-ok').textContent = done ? `${((st.working / done) * 100).toFixed(1)}%` : '—';
    $('#c-speed').textContent = st.rate ? `${st.rate.toFixed(1)}/s` : '—';
    $('#c-eta').textContent = st.running ? dur(st.eta) : st.elapsed ? `took ${dur(st.elapsed)}` : '—';
    $('#c-elite').textContent = fmt(st.elite || 0);
    $('#c-google').textContent = fmt(st.google || 0);

    const tb = $('#live-table tbody');
    if (st.recent && st.recent.length) {
      const prev = new Set($$('tr[data-key]', tb).map((r) => r.dataset.key));
      tb.innerHTML = st.recent
        .map((p) => {
          const key = `${p.ip}:${p.port}:${p.protocol}`;
          return `<tr data-key="${key}" class="${prev.size && !prev.has(key) ? 'flash' : ''}"><td>${proxyCell(p)}</td><td>${typeTag(typeOf(p))}</td><td>${latency(p.latency)}</td><td>${anon(p.anonymity)}</td><td>${google(p.google)}</td><td></td></tr>`;
        })
        .join('');
    }
  }

  async function toggleScrape() {
    try {
      if (S.scrape.running) {
        await api('/api/scrape/stop', { body: {} });
        toast('Stopping scraper…', 'warn');
      } else {
        S.scrape = await api('/api/scrape/start', { body: {} });
        renderScrape();
        toast('Scraper started', 'ok');
      }
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  async function startCheck(scope, ids) {
    try {
      S.check = await api('/api/check/start', { body: { scope, ids } });
      renderCheck();
      toast(`Testing ${fmt(S.check.total)} proxies`, 'ok');
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    }
  }

  async function toggleCheck() {
    if (S.check.running) {
      try {
        await api('/api/check/stop', { body: {} });
        toast('Stopping test…', 'warn');
      } catch (e) {
        toast(e.message, 'bad');
      }
    } else startCheck(S.scope);
  }

  // ================= Sources =================
  async function loadSources() {
    try {
      S.sources = await api('/api/sources');
      renderSources();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  function renderSources() {
    const live = new Map((S.scrape.sources || []).map((s) => [s.id, s]));
    const enabled = S.sources.filter((s) => s.enabled).length;
    $('#src-summary').textContent = `${enabled} of ${S.sources.length} enabled · ${fmt(S.settings.perSourceLimit || 0) === '0' ? 'no limit' : `limit ${fmt(S.settings.perSourceLimit)} per source`}`;
    const tb = $('#src-table tbody');
    if (!S.sources.length) {
      tb.innerHTML = '<tr class="empty"><td colspan="6">No sources. Add one to get started.</td></tr>';
      return;
    }
    tb.innerHTML = S.sources
      .map((s) => {
        const l = live.get(s.id);
        let result;
        if (l && (S.scrape.running || S.scrape.finishedAt)) {
          result =
            l.status === 'running'
              ? '<span class="status s-working">Fetching…</span>'
              : l.status === 'queued'
                ? '<span class="muted small">Queued</span>'
                : l.status === 'error'
                  ? `<span class="status s-dead" title="${esc(l.error)}">${esc(l.error)}</span>`
                  : l.status === 'skipped'
                    ? '<span class="muted small">Skipped</span>'
                    : `<span><b>${fmt(l.count)}</b> <span class="muted small">· ${fmt(l.added)} new · ${ms(l.ms)}</span></span>`;
        } else if (s.last_status) {
          result = s.last_status === 'ok'
            ? `<span><b>${fmt(s.last_count)}</b> <span class="muted small">· ${ago(s.last_run)}</span></span>`
            : `<span class="status s-dead" title="${esc(s.last_status)}">${esc(s.last_status.replace(/^error:\s*/, ''))}</span>`;
        } else result = '<span class="muted small">Never run</span>';
        return `<tr class="${s.enabled ? '' : 'disabled'}" data-id="${s.id}">
          <td><input type="checkbox" data-src-toggle ${s.enabled ? 'checked' : ''} aria-label="Enable ${esc(s.name)}"></td>
          <td><span class="src-name">${esc(s.name)}</span><a class="src-url" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a></td>
          <td>${typeTag(s.protocol)}</td>
          <td class="num">${s.max_proxies ? fmt(s.max_proxies) : '<span class="muted">global</span>'}</td>
          <td>${result}</td>
          <td><div class="row-actions">
            <button class="icon-btn sm" data-src-edit title="Edit">${icon('edit')}</button>
            <button class="icon-btn sm" data-src-del title="Delete">${icon('trash')}</button>
          </div></td></tr>`;
      })
      .join('');
  }

  async function setSourceEnabled(id, enabled) {
    const s = S.sources.find((x) => x.id === id);
    if (!s) return;
    s.enabled = enabled ? 1 : 0;
    renderSources();
    try {
      await api(`/api/sources/${id}`, { method: 'PUT', body: { enabled } });
    } catch (e) {
      toast(e.message, 'bad');
      loadSources();
    }
  }

  let editingSource = null;
  function openSourceDialog(src = null) {
    editingSource = src;
    const f = $('#src-form');
    f.reset();
    $('#src-test').textContent = '';
    $('#src-test').className = 'test-result';
    $('#src-dlg-title').textContent = src ? 'Edit source' : 'Add source';
    $('#src-save').textContent = src ? 'Save changes' : 'Add source';
    if (src) {
      f.name.value = src.name;
      f.url.value = src.url;
      f.protocol.value = src.protocol;
      f.max_proxies.value = src.max_proxies || 0;
    }
    $('#dlg-source').showModal();
    setTimeout(() => (src ? f.name : f.url).focus(), 30);
  }

  function sourceFormData() {
    const f = $('#src-form');
    return { name: f.name.value, url: f.url.value.trim(), protocol: f.protocol.value, max_proxies: Number(f.max_proxies.value) || 0 };
  }

  async function testSource() {
    const out = $('#src-test');
    const btn = $('#src-test-btn');
    const data = sourceFormData();
    if (!data.url) return toast('Enter a URL first', 'warn');
    btn.disabled = true;
    out.className = 'test-result';
    out.textContent = 'Fetching…';
    try {
      const r = await api('/api/sources/test', { body: data });
      out.className = `test-result ${r.count ? 'ok' : 'bad'}`;
      out.innerHTML = r.count
        ? `Found <b>${fmt(r.count)}</b> proxies in ${ms(r.ms)}<br>${r.sample.map((x) => `<code>${esc(x)}</code>`).join('')}`
        : 'The page loaded but no ip:port pairs were found.';
    } catch (e) {
      out.className = 'test-result bad';
      out.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ================= Proxies table =================
  function proxyQuery(extra = {}) {
    const q = { ...S.q, ...extra };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
    return p.toString();
  }

  async function loadProxies() {
    try {
      const r = await api(`/api/proxies?${proxyQuery()}`);
      S.rows = r.rows;
      S.total = r.total;
      renderProxies();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }
  const loadProxiesSoon = debounce(loadProxies, 250);

  function renderProxies() {
    const tb = $('#px-table tbody');
    $$('#px-table th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === S.q.sort);
      th.classList.toggle('desc', th.dataset.sort === S.q.sort && S.q.dir === 'desc');
    });
    if (!S.rows.length) {
      const hint = S.total === 0 && !S.q.search && S.q.status === 'working' ? 'No working proxies yet. Run the scraper and checker first.' : 'No proxies match these filters.';
      tb.innerHTML = `<tr class="empty"><td colspan="11">${hint}</td></tr>`;
    } else {
      tb.innerHTML = S.rows
        .map(
          (p) => `<tr data-id="${p.id}" class="${S.selected.has(p.id) ? 'selected' : ''}">
          <td><input type="checkbox" data-sel ${S.selected.has(p.id) ? 'checked' : ''} aria-label="Select"></td>
          <td>${proxyCell(p)}</td>
          <td>${typeTag(typeOf(p))}</td>
          <td><span class="status s-${p.status}">${p.status}</span>${p.status === 'dead' && p.error ? ` <span class="err" title="${esc(p.error)}">${esc(p.error)}</span>` : ''}</td>
          <td>${latency(p.latency)}</td>
          <td>${anon(p.anonymity)}</td>
          <td>${google(p.google)}</td>
          <td>${flag(p.country_code, p.country)}</td>
          <td class="hide-md"><span class="muted small">${esc(p.source || '')}</span></td>
          <td class="hide-md"><span class="muted small" title="${p.checked_at ? new Date(p.checked_at).toLocaleString() : ''}">${ago(p.checked_at)}</span></td>
          <td><div class="row-actions"><button class="icon-btn sm" data-row-retest title="Re-test">${icon('refresh')}</button><button class="icon-btn sm" data-row-del title="Delete">${icon('trash')}</button></div></td>
        </tr>`
        )
        .join('');
    }
    const pages = Math.max(1, Math.ceil(S.total / S.q.pageSize));
    const start = S.total ? (S.q.page - 1) * S.q.pageSize + 1 : 0;
    $('#pg-info').textContent = `${fmt(start)}–${fmt(Math.min(S.total, S.q.page * S.q.pageSize))} of ${fmt(S.total)}`;
    $('#pg-num').textContent = `${S.q.page} / ${pages}`;
    $('#pg-prev').disabled = S.q.page <= 1;
    $('#pg-next').disabled = S.q.page >= pages;
    const pageIds = S.rows.map((r) => r.id);
    const all = $('#px-all');
    all.checked = pageIds.length > 0 && pageIds.every((id) => S.selected.has(id));
    all.indeterminate = !all.checked && pageIds.some((id) => S.selected.has(id));
    renderBulk();
  }

  function renderBulk() {
    const n = S.selected.size;
    $('#bulkbar').classList.toggle('show', n > 0);
    $('#bulk-count').textContent = `${fmt(n)} selected`;
    $('#bulk-total').textContent = fmt(S.total);
    $('[data-action="select-matching"]').style.display = n < S.total ? '' : 'none';
  }

  async function loadCountries() {
    try {
      const list = await api('/api/countries');
      const sel = $('#f-country');
      const cur = sel.value;
      sel.innerHTML = '<option value="">All countries</option>' + list.map((c) => `<option value="${c.cc}">${esc(c.name || c.cc)} (${fmt(c.c)})</option>`).join('');
      sel.value = cur;
    } catch {}
  }

  function download(format, extra = {}) {
    const ids = extra.ids;
    if (ids) {
      // POST for large selections, delivered as a blob download
      api(`/api/export?format=${format}&inline=1`, { body: { ids } })
        .then((text) => saveBlob(text, format))
        .catch((e) => toast(e.message, 'bad'));
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/export?${proxyQuery({ format, page: '', pageSize: '' })}`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  }
  function saveBlob(text, format) {
    const ext = format === 'url' ? 'txt' : format;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `proxies-selected.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function deleteIds(ids) {
    if (!ids.length) return;
    try {
      const r = await api('/api/proxies/delete', { body: { ids } });
      ids.forEach((id) => S.selected.delete(id));
      toast(`Deleted ${fmt(r.deleted)} proxies`, 'ok');
      loadProxies();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  async function purge(body, msg) {
    if (!confirmAction(msg)) return;
    try {
      const r = await api('/api/proxies/delete', { body });
      S.selected.clear();
      toast(`Deleted ${fmt(r.deleted)} proxies`, 'ok');
      loadProxies();
      loadStats();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  // ================= Console =================
  const LVL = { info: 'Info', ok: 'OK', warn: 'Warn', error: 'Error' };
  function logLine(e) {
    const t = new Date(e.t).toLocaleTimeString([], { hour12: false });
    return `<div class="log-line l-${e.level}"><time>${t}</time><span class="lvl">${LVL[e.level] || e.level}</span><span>${esc(e.msg)}</span></div>`;
  }
  function renderLogs() {
    const box = $('#log');
    const list = S.logs.filter((e) => !S.logLevel || e.level === S.logLevel).slice(-500);
    box.innerHTML = list.map(logLine).join('') || '<div class="muted">No activity yet.</div>';
    box.scrollTop = box.scrollHeight;
  }
  function addLog(e) {
    S.logs.push(e);
    if (S.logs.length > 1500) S.logs.splice(0, 500);
    const con = $('#console');
    if (con.classList.contains('collapsed')) {
      S.unseenLogs++;
      $('#console-new').textContent = S.unseenLogs > 99 ? '99+' : S.unseenLogs;
    }
    if (S.logLevel && e.level !== S.logLevel) return;
    const box = $('#log');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (box.firstElementChild && box.firstElementChild.classList.contains('muted')) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', logLine(e));
    while (box.childElementCount > 500) box.firstElementChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  }
  function toggleConsole(force) {
    const con = $('#console');
    const collapsed = force !== undefined ? !force : !con.classList.contains('collapsed');
    con.classList.toggle('collapsed', collapsed);
    try { localStorage.setItem('ps-console', collapsed ? '0' : '1'); } catch {}
    if (!collapsed) {
      S.unseenLogs = 0;
      $('#console-new').textContent = '';
      $('#log').scrollTop = $('#log').scrollHeight;
    }
  }

  // ================= Live events =================
  let refreshTimer = null;
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => {
      $('#conn').textContent = 'Connected';
      $('#conn').classList.add('live');
    });
    es.addEventListener('error', () => {
      $('#conn').textContent = 'Reconnecting…';
      $('#conn').classList.remove('live');
    });
    es.addEventListener('hello', (ev) => {
      const d = JSON.parse(ev.data);
      $('#version').textContent = `v${d.version}`;
      S.scrape = d.scrape || { running: false };
      S.check = d.check || { running: false };
      S.logs = d.logs || [];
      renderLogs();
      renderScrape();
      renderCheck();
    });
    es.addEventListener('log', (ev) => addLog(JSON.parse(ev.data)));
    es.addEventListener('scrape', (ev) => {
      const wasRunning = S.scrape.running;
      S.scrape = JSON.parse(ev.data);
      renderScrape();
      if (wasRunning && !S.scrape.running) {
        toast(`Scraping done — ${fmt(S.scrape.added)} new proxies`, 'ok');
        loadSources();
      }
      loadStatsSoon();
    });
    es.addEventListener('check', (ev) => {
      const wasRunning = S.check.running;
      S.check = JSON.parse(ev.data);
      renderCheck();
      if (wasRunning && !S.check.running) {
        toast(`Test ${S.check.stopped ? 'stopped' : 'complete'} — ${fmt(S.check.working)} working`, 'ok');
        loadStats();
        loadCountries();
        if (S.view === 'proxies') loadProxies();
      }
    });
    es.addEventListener('stats', () => {
      loadStatsSoon();
      if (S.view === 'proxies') loadProxiesSoon();
    });
    es.addEventListener('geo', () => {
      if (S.view === 'proxies') loadProxiesSoon();
      loadStatsSoon();
    });
  }

  // Periodic refresh while a test is running (dashboard / table stay current)
  setInterval(() => {
    if (!S.check.running && !S.scrape.running) return;
    if (S.view === 'dashboard') loadStats();
    else loadStatsSoon();
    if (S.view === 'proxies' && S.selected.size === 0) loadProxies();
  }, 4000);

  async function loadInfo() {
    try {
      const i = await api('/api/info');
      const st = S.stats || {};
      $('#info').innerHTML = `
        <dt>Version</dt><dd>${esc(i.version)}</dd>
        <dt>Data folder</dt><dd><code>${esc(i.dataDir)}</code></dd>
        <dt>Proxies stored</dt><dd>${fmt(st.total)} (${fmt(st.working)} working)</dd>
        <dt>Login</dt><dd>${i.auth ? 'Password protected' : 'Open — set <code>APP_PASSWORD</code> to protect it'}</dd>
        <dt>Runtime</dt><dd>Node ${esc(i.node)}</dd>`;
    } catch {}
  }

  // ================= Events wiring =================
  function closeMenus(except) {
    $$('.dropdown.open').forEach((d) => d !== except && d.classList.remove('open'));
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;

    const dd = t.closest('[data-dropdown]');
    if (dd) {
      const wrap = dd.parentElement;
      closeMenus(wrap);
      wrap.classList.toggle('open');
      return;
    }
    if (!t.closest('.menu')) closeMenus();
    else closeMenus();

    const copy = t.closest('[data-copy]');
    if (copy) return copyText(copy.dataset.copy, `Copied ${copy.dataset.copy}`);

    const nav = t.closest('[data-view]');
    if (nav) return go(nav.dataset.view);
    const gt = t.closest('[data-goto]');
    if (gt) return go(gt.dataset.goto);

    const exp = t.closest('[data-export]');
    if (exp) return download(exp.dataset.export);

    // source table
    const srcRow = t.closest('#src-table tr[data-id]');
    if (srcRow) {
      const id = Number(srcRow.dataset.id);
      if (t.closest('[data-src-edit]')) return openSourceDialog(S.sources.find((s) => s.id === id));
      if (t.closest('[data-src-del]')) {
        const s = S.sources.find((x) => x.id === id);
        if (!confirmAction(`Delete source "${s.name}"?`)) return;
        try {
          await api(`/api/sources/${id}`, { method: 'DELETE' });
          toast('Source deleted', 'ok');
          loadSources();
        } catch (err) {
          toast(err.message, 'bad');
        }
        return;
      }
    }

    // proxy table
    const pxRow = t.closest('#px-table tbody tr[data-id]');
    if (pxRow) {
      const id = Number(pxRow.dataset.id);
      if (t.closest('[data-row-del]')) return deleteIds([id]);
      if (t.closest('[data-row-retest]')) return startCheck('ids', [id]);
    }

    const th = t.closest('#px-table th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (S.q.sort === k) S.q.dir = S.q.dir === 'asc' ? 'desc' : 'asc';
      else {
        S.q.sort = k;
        S.q.dir = ['checked', 'added', 'google'].includes(k) ? 'desc' : 'asc';
      }
      S.q.page = 1;
      return loadProxies();
    }

    const sc = t.closest('#scope [data-scope]');
    if (sc) {
      S.scope = sc.dataset.scope;
      $$('#scope button').forEach((b) => b.classList.toggle('active', b === sc));
      return;
    }
    const fs = t.closest('#f-status [data-v]');
    if (fs) {
      $$('#f-status button').forEach((b) => b.classList.toggle('active', b === fs));
      S.q.status = fs.dataset.v;
      S.q.page = 1;
      S.selected.clear();
      return loadProxies();
    }
    const chip = t.closest('#log-filter [data-level]');
    if (chip) {
      $$('#log-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
      S.logLevel = chip.dataset.level;
      return renderLogs();
    }

    const a = t.closest('[data-action]');
    if (!a) return;
    switch (a.dataset.action) {
      case 'scrape-toggle':
        return toggleScrape();
      case 'check-toggle':
        return toggleCheck();
      case 'check-untested':
        if (await startCheck('untested')) go('checker');
        return;
      case 'export-working': {
        const a2 = document.createElement('a');
        a2.href = '/api/export?status=working&sort=latency&format=txt';
        a2.download = '';
        document.body.append(a2);
        a2.click();
        a2.remove();
        return;
      }
      case 'src-add':
        return openSourceDialog();
      case 'src-all':
      case 'src-none': {
        const on = a.dataset.action === 'src-all';
        await Promise.all(S.sources.filter((s) => !!s.enabled !== on).map((s) => api(`/api/sources/${s.id}`, { method: 'PUT', body: { enabled: on } })));
        return loadSources();
      }
      case 'paste-import':
      case 'paste-check': {
        const text = $('#paste').value;
        if (!text.trim()) return toast('Paste some proxies first', 'warn');
        try {
          const r = await api('/api/proxies/import', { body: { text, protocol: $('#paste-proto').value, check: a.dataset.action === 'paste-check' } });
          toast(`Imported ${fmt(r.imported)} proxies`, 'ok');
          $('#paste').value = '';
          if (r.check) {
            S.check = r.check;
            renderCheck();
          }
          loadStats();
        } catch (err) {
          toast(err.message, 'bad');
        }
        return;
      }
      case 'copy-filter':
        try {
          const text = await api(`/api/export?${proxyQuery({ format: 'txt', inline: 1, page: '', pageSize: '' })}`);
          return copyText(text, `Copied ${fmt(text ? text.split('\n').length : 0)} proxies`);
        } catch (err) {
          return toast(err.message, 'bad');
        }
      case 'select-matching':
        try {
          const r = await api(`/api/proxies/ids?${proxyQuery({ page: '', pageSize: '' })}`);
          r.ids.forEach((id) => S.selected.add(id));
          return renderProxies();
        } catch (err) {
          return toast(err.message, 'bad');
        }
      case 'bulk-clear':
        S.selected.clear();
        return renderProxies();
      case 'bulk-copy':
        try {
          const text = await api('/api/export?format=txt&inline=1', { body: { ids: [...S.selected] } });
          return copyText(text, `Copied ${fmt(S.selected.size)} proxies`);
        } catch (err) {
          return toast(err.message, 'bad');
        }
      case 'bulk-export':
        return download('txt', { ids: [...S.selected] });
      case 'bulk-retest':
        if (await startCheck('ids', [...S.selected])) S.selected.clear();
        return renderProxies();
      case 'bulk-delete':
        if (!confirmAction(`Delete ${fmt(S.selected.size)} selected proxies?`)) return;
        return deleteIds([...S.selected]);
      case 'purge-dead':
        return purge({ status: 'dead' }, 'Delete every dead proxy from the database?');
      case 'purge-untested':
        return purge({ status: 'untested' }, 'Delete every untested proxy from the database?');
      case 'purge-all':
        return purge({ all: true }, 'Clear the entire proxy database? This cannot be undone.');
      case 'log-clear':
        await api('/api/logs', { method: 'DELETE' }).catch(() => {});
        S.logs = [];
        return renderLogs();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-src-toggle]')) return setSourceEnabled(Number(t.closest('tr').dataset.id), t.checked);
    if (t.matches('#px-table [data-sel]')) {
      const id = Number(t.closest('tr').dataset.id);
      t.checked ? S.selected.add(id) : S.selected.delete(id);
      t.closest('tr').classList.toggle('selected', t.checked);
      const pageIds = S.rows.map((r) => r.id);
      $('#px-all').checked = pageIds.every((i) => S.selected.has(i));
      $('#px-all').indeterminate = !$('#px-all').checked && pageIds.some((i) => S.selected.has(i));
      return renderBulk();
    }
    if (t.id === 'px-all') {
      S.rows.forEach((r) => (t.checked ? S.selected.add(r.id) : S.selected.delete(r.id)));
      return renderProxies();
    }
    const filterMap = { 'f-type': 'type', 'f-anon': 'anonymity', 'f-google': 'google', 'f-country': 'country', 'f-latency': 'maxLatency' };
    if (filterMap[t.id]) {
      S.q[filterMap[t.id]] = t.value;
      S.q.page = 1;
      S.selected.clear();
      return loadProxies();
    }
    if (t.id === 'pg-size') {
      S.q.pageSize = Number(t.value);
      S.q.page = 1;
      return loadProxies();
    }
  });

  $('#f-search').addEventListener(
    'input',
    debounce((e) => {
      S.q.search = e.target.value.trim();
      S.q.page = 1;
      loadProxies();
    }, 300)
  );
  $('#pg-prev').addEventListener('click', () => {
    if (S.q.page > 1) {
      S.q.page--;
      loadProxies();
    }
  });
  $('#pg-next').addEventListener('click', () => {
    S.q.page++;
    loadProxies();
  });

  $('#console-toggle').addEventListener('click', () => toggleConsole());
  $('#help-btn').addEventListener('click', () => $('#dlg-guide').showModal());
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ps-theme', next); } catch {}
    $('#theme-btn use').setAttribute('href', next === 'dark' ? '#i-sun' : '#i-moon');
  });
  $('#theme-btn use').setAttribute('href', document.documentElement.dataset.theme === 'dark' ? '#i-sun' : '#i-moon');

  $('#src-test-btn').addEventListener('click', testSource);
  $('#src-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const data = sourceFormData();
    try {
      if (editingSource) await api(`/api/sources/${editingSource.id}`, { method: 'PUT', body: data });
      else await api('/api/sources', { body: data });
      $('#dlg-source').close();
      toast(editingSource ? 'Source updated' : 'Source added', 'ok');
      loadSources();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      return $('#dlg-guide').open ? $('#dlg-guide').close() : $('#dlg-guide').showModal();
    }
    if (e.key === 'Escape') closeMenus();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const views = ['dashboard', 'scraper', 'checker', 'proxies', 'settings'];
    if (/^[1-5]$/.test(e.key)) go(views[Number(e.key) - 1]);
    else if (e.key === '`') toggleConsole();
    else if (e.key === '/') {
      e.preventDefault();
      go('proxies');
      $('#f-search').focus();
    }
  });

  // ================= Boot =================
  (async function boot() {
    try {
      if (localStorage.getItem('ps-console') === '0') toggleConsole(false);
    } catch {}
    try {
      S.settings = await api('/api/settings');
      applySettings();
      bindSettings();
    } catch (e) {
      toast(e.message, 'bad');
    }
    connect();
    await Promise.all([loadStats(), loadSources(), loadCountries()]);
    const initial = (location.hash || '').slice(1);
    go(VIEWS[initial] ? initial : 'dashboard');
  })();
})();
