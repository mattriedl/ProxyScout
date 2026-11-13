'use strict';
/**
 * Minimal HTTP/1.1 client that can tunnel through HTTP, HTTPS (CONNECT), SOCKS4 and SOCKS5 proxies.
 * Written on raw sockets so latency and failure modes are measured precisely.
 */
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const { performance } = require('perf_hooks');
const { SocksClient } = require('socks');

const MAX_BODY = 512 * 1024;
const noop = () => {};
const dnsCache = new Map();

function timeoutErr() {
  const e = new Error('timeout');
  e.code = 'ETIMEOUT';
  return e;
}

async function resolve4(host) {
  if (net.isIPv4(host)) return host;
  const hit = dnsCache.get(host);
  if (hit && hit.exp > Date.now()) return hit.ip;
  const { address } = await dns.lookup(host, { family: 4 });
  dnsCache.set(host, { ip: address, exp: Date.now() + 5 * 60 * 1000 });
  return address;
}

function tcpConnect(host, port, ms) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.on('error', noop);
    s.setNoDelay(true);
    const t = setTimeout(() => {
      s.destroy();
      reject(timeoutErr());
    }, ms);
    s.once('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(t);
      s.destroy();
      reject(e);
    });
  });
}

/** Read an HTTP response head (used for CONNECT). Leaves the socket paused. */
function readHead(sock, ms) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const finish = (err, val) => {
      clearTimeout(t);
      sock.pause();
      sock.removeListener('data', onData);
      sock.removeListener('close', onClose);
      sock.removeListener('error', onErr);
      err ? reject(err) : resolve(val);
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i !== -1) {
        const head = buf.subarray(0, i).toString('latin1');
        const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
        finish(null, { status: m ? Number(m[1]) : 0, head, rest: buf.subarray(i + 4) });
      } else if (buf.length > 16384) {
        finish(new Error('invalid proxy response'));
      }
    };
    const onClose = () => finish(new Error('connection closed'));
    const onErr = (e) => finish(e);
    const t = setTimeout(() => finish(timeoutErr()), ms);
    sock.on('data', onData);
    sock.once('close', onClose);
    sock.once('error', onErr);
  });
}

function dechunk(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const eol = buf.indexOf('\r\n', i);
    if (eol === -1) break;
    const size = parseInt(buf.subarray(i, eol).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(buf.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function parseHead(headStr) {
  const lines = headStr.split('\r\n');
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] || '');
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: m ? Number(m[1]) : 0, headers };
}

/** Read a full HTTP response. Resolves with partial data if the head arrived before the deadline. */
function readResponse(sock, ms, t0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let ttfb = null;
    let headEnd = -1;
    let meta = null;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      sock.destroy();
      if (!meta) return reject(err || new Error('empty response'));
      const all = Buffer.concat(chunks);
      let body = all.subarray(headEnd + 4);
      if (/chunked/i.test(meta.headers['transfer-encoding'] || '')) body = dechunk(body);
      resolve({
        status: meta.status,
        headers: meta.headers,
        head: all.subarray(0, headEnd).toString('latin1'),
        body: body.toString('utf8'),
        ttfb,
      });
    };

    const onData = (d) => {
      if (ttfb === null) ttfb = Math.round(performance.now() - t0);
      chunks.push(d);
      size += d.length;
      if (!meta) {
        const all = Buffer.concat(chunks);
        headEnd = all.indexOf('\r\n\r\n');
        if (headEnd !== -1) meta = parseHead(all.subarray(0, headEnd).toString('latin1'));
        else if (size > 32768) return finish(new Error('invalid response'));
      }
      if (meta) {
        const bodyLen = size - headEnd - 4;
        const cl = meta.headers['content-length'];
        if (cl !== undefined && bodyLen >= Number(cl)) return finish();
        if (meta.status === 204 || meta.status === 304) return finish();
        if (/chunked/i.test(meta.headers['transfer-encoding'] || '')) {
          const tail = Buffer.concat(chunks.slice(-2)).toString('latin1');
          if (/(?:^|\r\n)0\r\n\r\n$/.test(tail)) return finish();
        }
      }
      if (size > MAX_BODY) finish();
    };

    const t = setTimeout(() => finish(timeoutErr()), ms);
    sock.on('data', onData);
    sock.once('end', () => finish());
    sock.once('close', () => finish(new Error('connection closed')));
    sock.once('error', (e) => finish(e));
    sock.resume();
  });
}

function tlsWrap(sock, servername, ms) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      socket: sock,
      servername: net.isIP(servername) ? undefined : servername,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true, // a proxy that intercepts TLS is not a usable HTTPS proxy
    });
    s.on('error', noop);
    const t = setTimeout(() => {
      s.destroy();
      reject(timeoutErr());
    }, ms);
    s.once('secureConnect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(t);
      s.destroy();
      reject(e);
    });
  });
}

async function socksConnect(proxy, host, port, ms) {
  const type = proxy.protocol === 'socks4' ? 4 : 5;
  const destHost = type === 4 ? await resolve4(host) : host;
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxy.ip, port: proxy.port, type },
    command: 'connect',
    destination: { host: destHost, port },
    timeout: Math.max(500, Math.round(ms)),
  });
  socket.on('error', noop);
  return socket;
}

/**
 * GET a URL, optionally through a proxy.
 * @param {{ip:string, port:number, protocol:'http'|'socks4'|'socks5'}|null} proxy
 * @returns {Promise<{status:number, headers:object, head:string, body:string, ttfb:number, ms:number}>}
 */
async function request(proxy, url, { timeout = 8000, userAgent = 'Mozilla/5.0' } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const path = (u.pathname || '/') + u.search;
  const t0 = performance.now();
  const left = () => {
    const r = timeout - (performance.now() - t0);
    if (r <= 0) throw timeoutErr();
    return r;
  };

  let sock;
  let target = path;
  try {
    if (!proxy) {
      sock = await tcpConnect(u.hostname, port, left());
    } else if (proxy.protocol === 'http' && !isHttps) {
      sock = await tcpConnect(proxy.ip, proxy.port, left());
      target = u.href; // absolute-form for forward proxies
    } else if (proxy.protocol === 'http') {
      sock = await tcpConnect(proxy.ip, proxy.port, left());
      sock.write(
        `CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\nUser-Agent: ${userAgent}\r\n\r\n`
      );
      const h = await readHead(sock, left());
      if (h.status !== 200) throw new Error(`CONNECT rejected (${h.status || 'bad reply'})`);
      if (h.rest.length) sock.unshift(h.rest);
    } else {
      sock = await socksConnect(proxy, u.hostname, port, left());
    }

    if (isHttps) sock = await tlsWrap(sock, u.hostname, left());

    sock.write(
      `GET ${target} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `User-Agent: ${userAgent}\r\n` +
        `Accept: text/html,application/json,*/*;q=0.8\r\n` +
        `Accept-Language: en-US,en;q=0.9\r\n` +
        `Accept-Encoding: identity\r\n` +
        `Connection: close\r\n\r\n`
    );
    const res = await readResponse(sock, left(), t0);
    res.ms = Math.round(performance.now() - t0);
    return res;
  } catch (e) {
    if (sock) sock.destroy();
    throw e;
  }
}

module.exports = { request };
