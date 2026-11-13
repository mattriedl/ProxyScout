'use strict';
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

const logs = [];
const MAX_LOGS = 2000;

function log(level, msg) {
  const entry = { t: Date.now(), level, msg };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  bus.emit('event', { type: 'log', data: entry });
  const tag = level.toUpperCase().padEnd(5);
  console.log(`[${new Date(entry.t).toISOString()}] ${tag} ${msg}`);
}

function emit(type, data) {
  bus.emit('event', { type, data });
}

/** Returns a function that emits at most once per `ms`, always delivering the latest payload. */
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
    }
  };
}

module.exports = {
  bus,
  logs,
  emit,
  throttle,
  log: {
    info: (m) => log('info', m),
    ok: (m) => log('ok', m),
    warn: (m) => log('warn', m),
    error: (m) => log('error', m),
  },
};
