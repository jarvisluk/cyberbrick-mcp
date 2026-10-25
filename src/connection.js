import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;

// CyberBrick desktop app CDP endpoint. Default port 9223 (kept off the
// common 9222). Override with CB_CDP_HOST / CB_CDP_PORT (or CDP_HOST /
// CDP_PORT). Use 127.0.0.1, not localhost: the app's debug server listens on
// IPv4 only and localhost may resolve to ::1 first.
export const CDP_HOST = process.env.CB_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.CB_CDP_PORT || process.env.CDP_PORT) || 9223;

const MAX_RETRIES = 5;
const BASE_DELAY = 500;

/**
 * Probed live-entry points (see docs/设计与踩坑笔记.md §2):
 * - window.electron.ipcRenderer  — preload bridge, main-world accessible
 * - window.app                   — AppManager: stores + device methods
 * - window.env                   — {platform, arch, isPackaged, windowId}
 */
export const KNOWN_PATHS = {
  bridge: 'window.electron.ipcRenderer',
  appManager: 'window.app',
  deviceListStore: 'window.app.deviceListStore',
  environment: 'window.env',
};

/*
 * App console ring buffer — every console call in the attached (primary)
 * renderer since this server connected. Long app flows (runSendConfigTask:
 * upgrade → send config → pairing) report progress only through these logs.
 * Lines naming secrets are dropped (same key list as sanitize()).
 */
const LOG_MAX = 5000;
const LOG_NOISE = /keepalive|^\[Cyberbrick Log\] \S+ \S+ \[\d+\] (RECV |sendGetMessage (start|success)|sendSetMessage (start|success)|\[ProtocolLayer\])/;
const LOG_SECRET = /token|authoriz|secret|passphrase|private.?key|aes.?key|pin.?code|cert/i;
const consoleLog = [];
let consoleSeq = 0;

function recordConsole(e) {
  const text = (e.args || [])
    .map(a => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description || a.type || '').split('\n')[0]))
    .join(' ').replace(/\s+/g, ' ').slice(0, 500);
  if (LOG_SECRET.test(text)) return;
  consoleLog.push({ seq: ++consoleSeq, ts: new Date(e.timestamp || Date.now()).toISOString(), level: e.type, text, noise: LOG_NOISE.test(text) });
  if (consoleLog.length > LOG_MAX) consoleLog.shift();
}

/** Read buffered app console lines with seq > since (noise filtered unless includeNoise). */
export function readConsoleLog({ since = 0, grep, levels, limit = 200, includeNoise = false } = {}) {
  const re = grep ? new RegExp(grep, 'i') : null;
  const rows = consoleLog.filter(l => l.seq > since && (includeNoise || !l.noise)
    && (!levels?.length || levels.includes(l.level)) && (!re || re.test(l.text)));
  const page = rows.slice(-limit);
  return { lastSeq: consoleSeq, returned: page.length, matched: rows.length, lines: page.map(({ noise, ...l }) => l) };
}

export function safeString(str) {
  return JSON.stringify(String(str));
}

export function jsonStringify(value) {
  return JSON.stringify(value ?? null);
}

const PING_TIMEOUT_MS = 4000;

/** Runtime.evaluate with a hard timeout — the renderer can stall while the
 * user works in a project window, and an un-acked evaluate would otherwise
 * wedge every later call on the shared websocket. */
async function ping(c) {
  return Promise.race([
    c.Runtime.evaluate({ expression: '1', returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('PING_TIMEOUT')), PING_TIMEOUT_MS)),
  ]);
}

export async function getClient() {
  if (client) {
    try {
      await ping(client);
      // Re-verify this target is still the primary window: the app can open
      // secondary windows (e.g. a project editor) that match the same URL
      // pattern but route all device calls through requestToMainWindow. If a
      // secondary window appears first in /json/list we must not stay on it.
      // NOTE: raw Runtime.evaluate here, NOT evaluate() — the wrapper calls
      // getClient() and would recurse infinitely.
      const prim = await Promise.race([
        client.Runtime.evaluate({ expression: '(window.env ? window.env.isPrimary : true)', returnByValue: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('PRIMARY_CHECK_TIMEOUT')), PING_TIMEOUT_MS)),
      ]).then(r => r.result?.value).catch(() => null);
      if (prim !== false) return client;
      client = null;
      targetInfo = null;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findPageTarget();
      if (!target) {
        throw new Error(
          'No CyberBrick renderer target found. Launch the app with --remote-debugging-port=9223 (see cb_launch).'
        );
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      await client.Runtime.enable();
      await client.Page.enable();
      client.Runtime.consoleAPICalled(recordConsole);
      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30_000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findPageTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const pages = targets.filter(t =>
    t.type === 'page' && /main_window\/index\.html/i.test(t.url)
  );
  if (!pages.length) {
    const fallback = targets.filter(t => t.type === 'page' && /cyberbrick|cyber-brick/i.test(t.url));
    if (fallback.length) return fallback[0];
    return null;
  }
  if (pages.length === 1) return pages[0];
  // Multiple windows: the app opens secondary windows (project editors) with
  // the same URL. Attach to each briefly and pick the one with
  // window.env.isPrimary === true — only the primary window owns the device
  // managers; secondaries just forward via requestToMainWindow.
  for (const t of pages) {
    try {
      const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
      const r = await c.Runtime.evaluate({ expression: 'window.env ? window.env.isPrimary : true', returnByValue: true });
      await c.close().catch(() => {});
      if (r?.result?.value === true) return t;
    } catch { /* try next */ }
  }
  return pages[0];
}

export async function getTargetInfo() {
  if (!targetInfo) await getClient();
  return targetInfo;
}

/** Evaluate a JS expression in the main world of the renderer. */
export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await Promise.race([
    c.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
      ...opts,
    }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`EVALUATE_TIMEOUT: renderer did not respond in ${opts.timeoutMs ?? 10000}ms`)), opts.timeoutMs ?? 10000)
    ),
  ]);
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

/** Evaluate and await a Promise result. Long-running device flows need a
 * generous window: BLE scanning + gatt connect + B0 probe can take ~30s. */
export async function evaluateAsync(expression, timeoutMs = 60000) {
  return evaluate(expression, { awaitPromise: true, timeoutMs });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

/** Quick endpoint probe without opening a websocket. */
export async function endpointReachable(timeoutMs = 1500) {
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Wrap an ipcRenderer call by name. The preload bridge exposes ~70 native
 * bound methods; returnByValue JSON must be safe — callers should pass only
 * serializable payloads.
 */
export async function callBridge(method, args = []) {
  if (typeof method !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method)) {
    throw new Error(`Invalid bridge method name: ${method}`);
  }
  return evaluateAsync(
    `window.electron.ipcRenderer[${safeString(method)}](...${jsonStringify(args)})`
  );
}

/**
 * Call a method on window.app.local (or another AppManager member).
 * member: 'local' | 'bluetoothDeviceManager' | 'connectionPoolManager' | 'ipc'
 *
 * NOTE: write/flash operations (runSendConfigTask, updateLoaderFirmwareMpy,
 * sendTestCommand, createEncryptConnection, ...) are reachable through here.
 * Never expose this generically to a tool — tools must allowlist the methods
 * they call (see tools/device.js device_request).
 */
export async function callAppManager(member, method, args = []) {
  if (!['local', 'bluetoothDeviceManager', 'connectionPoolManager', 'ipc'].includes(member)) {
    throw new Error(`Invalid AppManager member: ${member}`);
  }
  if (typeof method !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method)) {
    throw new Error(`Invalid method name: ${method}`);
  }
  return evaluateAsync(
    `window.app[${safeString(member)}][${safeString(method)}](...${jsonStringify(args)})`
  );
}

/**
 * Call a getState() accessor on a zustand store exposed on window.app.
 * Zustand actions live on the state object returned by getState(), not on the
 * store function itself.
 * e.g. callStoreGetter('useFirmwareConfigStore', 'getSenderChannel', [0])
 */
export async function callStoreGetter(store, getter, args = []) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(store) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(getter)) {
    throw new Error(`Invalid store/getter name: ${store}.${getter}`);
  }
  return evaluateAsync(
    `window.app[${safeString(store)}].getState()[${safeString(getter)}](...${jsonStringify(args)})`
  );
}

/** Read the whole state object of a zustand store (functions stripped). */
export async function readStoreState(store) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(store)) {
    throw new Error(`Invalid store name: ${store}`);
  }
  const raw = await evaluateAsync(
    `(function(){const s=window.app[${safeString(store)}];const st=s&&(s.getState?s.getState():s);` +
    `if(!st)return null;` +
    `const out={};for(const k of Object.keys(st)){if(typeof st[k]!=='function')out[k]=st[k];}` +
    `return out;})()`
  );
  return sanitize(raw);
}

/**
 * Invoke a zustand store ACTION (mutator). Used by firmware-config editing.
 * The mutation runs locally in the renderer; the App then reflects it in the UI.
 * Sensitive keys (token/pin/key/cert) are never passed through.
 */
export async function callStoreAction(store, action, args = []) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(store) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(action)) {
    throw new Error(`Invalid store/action name: ${store}.${action}`);
  }
  return evaluateAsync(
    `window.app[${safeString(store)}].getState()[${safeString(action)}](...${jsonStringify(args)})`
  );
}

/**
 * Redact anything that could carry auth material before returning to the LLM.
 * Keys are matched by word (camelCase / snake_case / kebab-case split), not by
 * substring — a substring match on "pin" or "auth" also hid hardwareMappings,
 * ping, spinSpeed and authorized, which the agent needs to see.
 */
const REDACT_WORDS = new Set([
  'token', 'auth', 'secret', 'passphrase', 'password', 'pin', 'cert', 'certificate',
]);
const REDACT_COMPACT = /aeskey|privatekey|accesstoken|refreshtoken|authtoken/;
const MAX_SANITIZE_DEPTH = 16;

export function isSensitiveKey(key) {
  const k = String(key);
  if (REDACT_COMPACT.test(k.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true;
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some(w => REDACT_WORDS.has(w));
}

export function sanitize(obj, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  // Past the depth limit, never hand back the raw subtree — it has not been
  // checked for sensitive keys.
  if (depth > MAX_SANITIZE_DEPTH) return typeof obj === 'object' ? '<truncated: max depth>' : obj;
  if (Array.isArray(obj)) return obj.map(v => sanitize(v, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = isSensitiveKey(k) ? '<redacted>' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof obj === 'string' && obj.length > 4000) return obj.slice(0, 4000) + '…[truncated]';
  return obj;
}
