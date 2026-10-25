/**
 * Core health / launch logic for the CyberBrick desktop app.
 *
 * Verified behaviors (docs/设计与踩坑笔记.md §6):
 * - The app holds a single-instance lock: a second launch with the debug
 *   flag will silently exit while an old instance is still running, so
 *   cb_launch must retire any existing process first.
 * - The app cannot start under a restrictive file sandbox ("sandbox
 *   initialization failed"); run it from an unsandboxed shell.
 * - autoUpdater does one update check at startup (autoDownload=true,
 *   autoInstallOnAppQuit=false) — harmless for CDP use, but the app can
 *   upgrade itself between sessions, so cb_health reports the live version.
 */
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import {
  CDP_HOST, CDP_PORT, endpointReachable,
  getClient, getTargetInfo, evaluate, disconnect,
} from '../connection.js';

export const APP_BINARY
  = process.env.CB_APP_BINARY
  || '/Applications/CyberBrick.app/Contents/MacOS/CyberBrick';

export const DEBUG_PORT_FLAG = '--remote-debugging-port';
const KNOWN_PROCESS_PATTERN = 'CyberBrick.app/Contents/MacOS/CyberBrick';
// Wait this long at most for the http endpoint to come up after spawn.
const ENDPOINT_TIMEOUT_MS = 20_000;
const ENDPOINT_POLL_MS = 500;

function listProc() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', KNOWN_PROCESS_PATTERN], (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.toString().split('\n').map(s => s.trim()).filter(Boolean));
    });
  });
}

/**
 * Launch the app with the CDP debug port. Handles the two launch traps:
 *  1) an existing instance holds the single-instance lock and would swallow
 *     us — it is only killed when killExisting is true (the caller must have
 *     the user's OK: unsaved work is lost); a reachable CDP endpoint is reused,
 *  2) spawns detached from an unsandboxed parent so Electron's own sandbox
 *     can initialize.
 */
export async function launchApp({ killExisting = false, timeoutMs = ENDPOINT_TIMEOUT_MS } = {}) {
  const reachable = await endpointReachable();
  if (reachable) {
    return { launched: false, alreadyRunning: true, endpoint: `http://${CDP_HOST}:${CDP_PORT}`, version: reachable };
  }
  const existing = await listProc();
  if (existing.length && !killExisting) {
    // Killing the app discards the user's unsaved editor work — never do it
    // implicitly.
    throw new Error(
      `CyberBrick is already running without the CDP port (pids ${existing.join(', ')}). `
      + 'Ask the user to quit it, or re-run cb_launch with kill_existing=true once they agree '
      + '(unsaved work in the app will be lost).'
    );
  }
  if (existing.length) {
    await new Promise((resolve) => {
      execFile('pkill', ['-f', KNOWN_PROCESS_PATTERN], () => resolve());
    });
    // Give the lock holder time to fully release.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (!(await listProc()).length) break;
    }
  }
  if (!existsSync(APP_BINARY)) {
    throw new Error(`CyberBrick binary not found at ${APP_BINARY} (override with CB_APP_BINARY)`);
  }

  const child = spawn(APP_BINARY, [`${DEBUG_PORT_FLAG}=${CDP_PORT}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await endpointReachable(ENDPOINT_POLL_MS);
    if (version) {
      return { launched: true, pid: child.pid, endpoint: `http://${CDP_HOST}:${CDP_PORT}`, version };
    }
    if (!(await listProc()).length && Date.now() > deadline - timeoutMs + 4000) {
      // App exited quickly — typically the sandbox-restriction trap.
      throw new Error(
        'CyberBrick exited immediately after launch. If this session runs with a file '
        + 'sandbox, start the app from an unsandboxed shell.'
      );
    }
    await new Promise(r => setTimeout(r, ENDPOINT_POLL_MS));
  }
  throw new Error(`CDP endpoint did not come up within ${timeoutMs}ms on port ${CDP_PORT}`);
}

export async function healthCheck() {
  const version = await endpointReachable();
  if (!version) {
    return {
      status: 'unreachable',
      cdp: `http://${CDP_HOST}:${CDP_PORT}`,
      hint: 'Run cb_launch, or start the app with --remote-debugging-port=9223 from an unsandboxed shell.',
    };
  }
  // Reuse the cached client — connect() would open a new websocket every call
  // and orphan the previous one.
  await getClient();
  const target = await getTargetInfo();

  const state = await evaluate(`(() => {
    const out = {
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      hasBridge: typeof window.electron !== 'undefined',
      hasAppManager: typeof window.app !== 'undefined',
    };
    try {
      if (window.app?.deviceListStore) {
        const s = window.app.deviceListStore;
        out.deviceCount = (s.deviceList || []).length;
        out.deviceNames = (s.deviceList || []).map(d => d.name ?? d.deviceId ?? null);
      }
      out.env = window.env ?? null;
    } catch (e) { out.storeError = String(e); }
    return out;
  })()`);

  const m = /CyberBrick\/([\d.]+)/.exec(state?.userAgent || '');
  return {
    status: 'ok',
    cdp: `http://${CDP_HOST}:${CDP_PORT}`,
    target: { id: target.id, url: target.url },
    appVersion: m ? m[1] : null,
    electronVersion: version['Electron'] ?? null,
    browser: version.Browser ?? null,
    ...state,
  };
}

export async function closeClient() {
  await disconnect();
}

export async function ensureClient() {
  return getClient();
}
