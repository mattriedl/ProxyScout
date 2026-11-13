'use strict';

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IP = `${OCTET}(?:\\.${OCTET}){3}`;

// Matches, in order of the separator alternatives:
//   [scheme://]1.2.3.4:8080           plain lists, URLs
//   <td>1.2.3.4</td><td>8080</td>     HTML tables
//   "ip":"1.2.3.4","port":"8080"      common JSON shapes
//   1.2.3.4  8080                      whitespace/tab separated
const PROXY_RE = new RegExp(
  `(?:\\b(https?|socks4a?|socks5h?)://)?\\b(${IP})` +
    `(?::|\\s*</td>\\s*<td[^>]*>\\s*|"\\s*,\\s*"port"\\s*:\\s*"?|[ \\t]+)` +
    `(\\d{2,5})\\b`,
  'gi'
);

function normalizeProtocol(p) {
  if (!p) return null;
  p = p.toLowerCase();
  if (p.startsWith('socks4')) return 'socks4';
  if (p.startsWith('socks5')) return 'socks5';
  if (p.startsWith('http')) return 'http';
  return null;
}

function isPublicIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/**
 * Extract proxies from arbitrary text.
 * @param {string} text
 * @param {string} defaultProtocol 'http' | 'socks4' | 'socks5' | 'auto'
 * @param {{allowPrivate?: boolean}} opts
 */
function parseProxies(text, defaultProtocol = 'http', opts = {}) {
  const out = [];
  const seen = new Set();
  PROXY_RE.lastIndex = 0;
  let m;
  while ((m = PROXY_RE.exec(text))) {
    const ip = m[2];
    const port = Number(m[3]);
    if (port < 1 || port > 65535) continue;
    if (!opts.allowPrivate && !isPublicIPv4(ip)) continue;
    const protocol = normalizeProtocol(m[1]) || defaultProtocol || 'http';
    const key = `${ip}:${port}:${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ip, port, protocol });
  }
  return out;
}

module.exports = { parseProxies, isPublicIPv4 };
