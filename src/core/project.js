/**
 * Project management (CyberBrick projects list) — pass-through to
 * window.app.useFirmwareListStore (zustand persist, key: firmware-list-storage).
 *
 * Probed live + bundle-verified (see docs/设计与踩坑笔记.md §5):
 * - The app's project manager module (`pa`) and open-editor helper (`X1`) are
 *   module-internal and NOT reachable at runtime, but every step they perform
 *   is reproducible with the app's own primitives:
 *     pa.createProjectFromTemplate(key, name) === addFirmware(getTemplateData(key), name)
 *     pa.importProjectFromFileContent(json, name) === Ud(version check) +
 *         design_id="00000000000000000000" + region="xx" + addFirmware(parsed, name)
 *     X1(id) === editor store load (setFirmwareConfig(getFirmwareById(id)) +
 *         setConfigType) + open route via history.pushState hash (current
 *         window) or ipcRenderer.createWindowWithPath (new window)
 * - Template data ships as JSON (src/core/templates/*.json) extracted from the
 *   bundle by scripts/extract_templates.py — same data, byte-verified against a
 *   project created in the app UI.
 *
 * No MCP-side confirmation/token layer: functions map 1:1 to app capabilities.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import {
  evaluateAsync, evaluate, safeString, jsonStringify, CDP_HOST, CDP_PORT,
} from '../connection.js';

const TEMPLATES_DIR = fileURLToPath(new URL('./templates/', import.meta.url));

// The app's template table also has NONE ({}), but its create dialog never
// offers it and addFirmware rejects the empty config ("file input error").
export const TEMPLATE_KEYS = [
  'forklift', 'truck', 'forklift_and_truck', 'ball_car', 'official_remote', 'custom',
];

export const APP_CONFIG_VERSION = '2';      // OI in the bundle — import rejects version > OI
const DEFAULT_DESIGN_ID = '00000000000000000000';
const DEFAULT_REGION = 'xx';

/**
 * The app's getTemplateData picks the EN variant iff its language store
 * (zustand persist, localStorage "lang") says "en", else CN. That store is not
 * on window.app; read the persisted value, falling back to the app's own
 * default (navigator.language starting with "zh" → zh, otherwise en).
 */
async function appLanguage() {
  const lang = await evaluateAsync(`(function(){
    try { const v = JSON.parse(localStorage.getItem('lang') || 'null'); if (v && v.state && v.state.language) return v.state.language; } catch (e) {}
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  })()`).catch(() => null);
  return typeof lang === 'string' ? lang : null;
}

/** pa.getTemplateData(key): deep-cloned template config in the app's current language. */
export async function getTemplateData(key) {
  if (!TEMPLATE_KEYS.includes(key)) {
    throw new Error(`UNKNOWN_TEMPLATE: ${key} (valid: ${TEMPLATE_KEYS.join(', ')})`);
  }
  const raw = JSON.parse(readFileSync(`${TEMPLATES_DIR}${key}.json`, 'utf8'));
  const lang = await appLanguage();
  return (lang === 'en' ? raw.en : raw.cn) ?? raw.cn ?? raw.en ?? {};
}

const LIST_STORE = 'useFirmwareListStore';
const CFG_STORE = 'useFirmwareConfigStore';

/** getShowList() — {configId,type,configName,designLink,lastModifiedTime,thumbnail}, sorted by update_time desc. */
export async function listProjects() {
  const raw = await evaluateAsync(
    `window.app[${safeString(LIST_STORE)}].getState().getShowList()`
  );
  return { projects: Array.isArray(raw) ? raw : [], count: Array.isArray(raw) ? raw.length : 0 };
}

/** getFirmwareById(id) — full project record (config body included). */
export async function getProject(id) {
  return evaluateAsync(
    `window.app[${safeString(LIST_STORE)}].getState().getFirmwareById(${safeString(id)})`
  );
}

/**
 * addFirmware(config, name) — the same action pa.createProjectFromTemplate
 * calls. x1() inside the store fills type/design_id/region/id defaults.
 */
export async function addFirmwareRaw(config, name) {
  return evaluateAsync(
    `window.app[${safeString(LIST_STORE)}].getState().addFirmware(${jsonStringify(config)}, ${safeString(name ?? 'config')})`
  );
}

/**
 * createProjectFromTemplate(templateKey, name) — app's pa.createProjectFromTemplate:
 * deep-clone the template config and addFirmware it. The store's x1() assigns
 * id/type/design_id/region; we set config_name like the app passes `name`.
 */
export async function createProjectFromTemplate(templateKey, name) {
  const tpl = await getTemplateData(templateKey);
  // The store validates against a zod schema requiring config_name + 10 sender
  // channels + full receiver slot maps; templates extracted from the bundle
  // already conform (empty "custom"/"none" get their defaults filled by x1()).
  tpl.config_name = name ?? tpl.config_name ?? templateKey;
  return addFirmwareRaw(tpl, tpl.config_name);
}

/**
 * importProjectFromFileContent(json, name) — app's pa.importProjectFromFileContent:
 * JSON.parse, version check (reject > APP_CONFIG_VERSION), force
 * design_id/region to the app defaults, then addFirmware.
 */
export async function importProjectFromContent(jsonText, name) {
  const parsed = normalizeImportedProject(jsonText, name);
  return addFirmwareRaw(parsed, parsed.config_name);
}

/** Pure part of the import: parse, version-check, rewrite and pad to the store schema. */
export function normalizeImportedProject(jsonText, name) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('config_content_error: payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config_content_error: project content must be a JSON object');
  }
  if (parsed.version !== undefined && parsed.version !== null) {
    const v = Number(parsed.version);
    if (!Number.isNaN(v) && v > Number(APP_CONFIG_VERSION)) {
      throw new Error(`config_version_unsupported: file version ${parsed.version} > supported ${APP_CONFIG_VERSION}`);
    }
  }
  // app rewrites these unconditionally on import
  parsed.design_id = DEFAULT_DESIGN_ID;
  parsed.region = DEFAULT_REGION;
  const base = String(name ?? '').replace(/\.json$/i, '') || parsed.config_name || 'config';
  parsed.config_name = base;
  // The store's zod schema requires a version string, 10 sender channels and
  // full receiver slot maps; pad a minimal config so validation passes the way
  // the app's own import flow expects well-formed files.
  if (typeof parsed.version !== 'string') parsed.version = String(parsed.version ?? APP_CONFIG_VERSION);
  if (!Array.isArray(parsed.sender?.channels)) {
    parsed.sender = { ...(parsed.sender ?? {}), channels: Array.from({ length: 10 }, () => ({})) };
  }
  for (const key of ['receiver_1', 'receiver_2']) {
    parsed[key] = {
      PWM1: {}, PWM2: {}, PWM3: {}, PWM4: {},
      LED1: {}, LED2: {}, MOTOR1: {}, MOTOR2: {},
      BUZZER1: {}, BUZZER2: {}, CODE: {},
      ...(parsed[key] ?? {}),
    };
  }
  if (!parsed.switches) parsed.switches = { list: [{ state: 'off' }, { state: 'off' }] };
  if (!Array.isArray(parsed.switches.list) || parsed.switches.list.length !== 2) {
    parsed.switches.list = [{ state: 'off' }, { state: 'off' }];
  }
  return parsed;
}

/**
 * Export content — the app's exportProject strips runtime-only fields and
 * serializes with SC(): {...config, version:String(OI)}. Pure content export
 * returns the JSON string without any save dialog.
 */
export async function exportProjectContent(id) {
  const record = await getProject(id);
  if (!record) throw new Error(`PROJECT_NOT_FOUND: ${id}`);
  const { id: _i, type: _t, design_name: _dn, coverUrl: _c, original_file_name: _o, bluetoothDevice: _b, update_time: _u, ...rest } = record;
  return JSON.stringify({ ...rest, version: APP_CONFIG_VERSION });
}

export async function renameProject(id, name) {
  if (!name || !String(name).trim()) throw new Error('EMPTY_NAME');
  return evaluateAsync(
    `window.app[${safeString(LIST_STORE)}].getState().renameFirmware(${safeString(id)}, ${safeString(String(name).trim())})`
  );
}

/** deleteFirmware(id) — UI 层 deleteProject 只是包了 toast;这就是底层 action。DESTRUCTIVE. */
export async function deleteProject(id) {
  return evaluateAsync(
    `window.app[${safeString(LIST_STORE)}].getState().deleteFirmware(${safeString(id)})`
  );
}

/**
 * Load a project into the editor store (what the app does when opening a
 * project: setFirmwareConfig(record) + setConfigType('hardware')).
 */
export async function loadProjectToEditor(id, configType = 'hardware') {
  return evaluateAsync(`(function(){
    const list = window.app[${safeString(LIST_STORE)}].getState();
    const rec = list.getFirmwareById(${safeString(id)});
    if (!rec) return { error: 'PROJECT_NOT_FOUND', id: ${safeString(id)} };
    if (rec.type === 'design') return { error: 'DESIGN_NOT_EDITABLE', id: ${safeString(id)} };
    const cfg = window.app[${safeString(CFG_STORE)}].getState();
    cfg.setFirmwareConfig(JSON.parse(JSON.stringify(rec)));
    if (typeof cfg.setConfigType === 'function') cfg.setConfigType(${safeString(configType)});
    return { loaded: true, configId: rec.id, configName: rec.config_name ?? null };
  })()`);
}

/**
 * Save the current editor config back into the project list — the app's
 * updateFirmware(config) (diff by id; missing id → addFirmware) + markAsSaved.
 */
export async function saveProjectFromEditor() {
  return evaluateAsync(`(function(){
    const cfg = window.app[${safeString(CFG_STORE)}].getState();
    const fw = cfg.firmwareConfig;
    if (!fw) return { error: 'NO_EDITOR_CONFIG' };
    window.app[${safeString(LIST_STORE)}].getState().updateFirmware(JSON.parse(JSON.stringify(fw)));
    if (typeof cfg.markAsSaved === 'function') cfg.markAsSaved();
    return { saved: true, configId: fw.id ?? null, configName: fw.config_name ?? null };
  })()`);
}

/**
 * Open the project editor — the app's X1(id):
 * - target "new" (app default): ipcRenderer.createWindowWithPath("/project/edit?firmwareId=<id>")
 * - target "current": history.pushState(state, "", "#/project/edit?firmwareId=<id>")
 *   (the app monkey-patches pushState to notify its router, which parses the hash)
 * The editor config is loaded first (same as the app's mf() helper).
 */
export async function openProjectEditor(id, target = 'new') {
  // The editor body (jbt) only renders the mapping canvas when configType is
  // "software"; with "hardware" the page is an empty shell.
  const loaded = await loadProjectToEditor(id, 'software');
  if (loaded?.error) return loaded;
  const path = `/project/edit?firmwareId=${id}`;
  if (target === 'current') {
    const hash = await evaluate(`(() => {
      history.pushState(history.state, '', ${safeString('#' + path)});
      return location.hash;
    })()`);
    return { opened: true, target: 'current', path, hash, loaded };
  }
  const win = await evaluateAsync(
    `window.electron.ipcRenderer.createWindowWithPath(${safeString(path)})`
  );
  return { opened: true, target: 'new', path, window: win ?? null, loaded };
}

/**
 * Page + store state — the progressive-disclosure base. Reads location.hash
 * (hash router), editor store flags and the project list, then returns which
 * tools are relevant next.
 */
export async function getProjectState() {
  const state = await evaluateAsync(`(function(){
    const list = window.app[${safeString(LIST_STORE)}].getState();
    const cfg = window.app[${safeString(CFG_STORE)}].getState();
    let hash = null;
    try { hash = location.hash || ''; } catch (e) {}
    const editing = cfg.firmwareConfig
      ? { configId: cfg.firmwareConfig.id ?? null, configName: cfg.firmwareConfig.config_name ?? null, isModified: !!cfg.isModified, configType: cfg.configType ?? null }
      : null;
    return {
      hash,
      primary: window.env ? window.env.isPrimary : true,
      projectCount: Array.isArray(list.firmwareList) ? list.firmwareList.length : 0,
      projects: list.getShowList ? list.getShowList() : [],
      editor: editing,
    };
  })()`);
  if (state && !state.error) state.openWindowCount = await countPageTargets();
  return decorateState(state);
}

function decorateState(state) {
  if (!state || state.error) return state;
  const hash = String(state.hash || '');
  const page = hash.includes('/project/edit')
    ? 'project_edit'
    : hash.includes('/projects')
      ? 'projects'
      : hash.includes('/devices')
        ? 'devices'
        : hash.includes('/settings')
          ? 'settings'
          : hash ? 'other' : 'unknown';
  const nextTools = ['project_state', 'project_list'];
  if (page === 'projects' || page === 'unknown') {
    nextTools.push('project_create', 'project_import', 'project_export', 'project_rename', 'project_delete');
  }
  if (state.editor?.configId || page === 'project_edit') {
    nextTools.push('project_load', 'project_save', 'project_open_editor',
      'firmware_config_get', 'firmware_edit_actions', 'firmware_config_edit',
      'device_list', 'connect_bluetooth', 'flash_config');
  }
  // window management is contextually relevant whenever more than the main
  // window is open (project_open_editor target="new" accumulates windows)
  const openSubs = (state.openWindowCount ?? 1) > 1;
  if (openSubs || page === 'project_edit') {
    nextTools.push('window_list', 'window_close', 'window_close_others');
  }
  return { ...state, page, nextTools };
}

/**
 * Window management — the app's own SubWindowManager surface:
 * - close: window-state store closeSubWindow(windowId) → ipc "window:close-sub-window"
 *   (main sets _forceClose and closes; unsaved work triggers the app's own
 *   confirm flow, we do not bypass it)
 * - closeOthers/main: same via closeAllSubWindows semantics — implemented by
 *   enumerating the store's windows map and closing each id individually
 * - list: read-only snapshot of open windows from the store + CDP page titles
 */
export async function listWindows() {
  // Live truth = CDP /json/list (real open windows, titles, hashes). The
  // renderer's persisted windows map is often stale (persisted ids linger
  // after close), so we return it separately as `storeWindows` for reference.
  const state = await evaluateAsync(`(function(){
    const st = window.app['useWindowStateStore'];
    if (!st || !st.getState) return { error: 'NO_WINDOW_STORE' };
    const s = st.getState();
    const env = window.env || {};
    const cfg = window.app['useFirmwareConfigStore'] ? window.app['useFirmwareConfigStore'].getState() : null;
    const storeWindows = s.windows instanceof Map
      ? Object.fromEntries([...s.windows].map(([k, v]) => [String(k), { title: v.title ?? null, path: v.path ?? null }]))
      : null;
    return {
      currentWindowId: env.windowId ?? null,
      isPrimary: !!env.isPrimary,
      hash: location.hash || '',
      editorModified: cfg ? !!cfg.isModified : null,
      storeWindows,
    };
  })()`);
  if (state.error) return state;
  let pages = null;
  try {
    const raw = await listPageTargets();
    // attach each page's real windowId (window.env.windowId) — the persisted
    // store map is stale, and window_close needs the live id
    const windowIds = await Promise.all(raw.map(probePageWindowId));
    pages = raw.map((t, i) => ({
      windowId: windowIds[i],
      title: t.title,
      hash: (t.url.match(/#.*$/) || [''])[0],
    }));
  } catch { /* CDP http briefly unavailable — store data still returned */ }
  return { ...state, openWindows: pages, openWindowCount: pages ? pages.length : null };
}

async function listPageTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  return (await res.json()).filter((t) => t.type === 'page');
}

/** Number of open app windows (CDP page targets); null when CDP http is unavailable. */
async function countPageTargets() {
  try { return (await listPageTargets()).length; } catch { return null; }
}

const WINDOW_PROBE_TIMEOUT_MS = 3000;

/** Read window.env.windowId from one page over a short-lived CDP session; null on failure. */
async function probePageWindowId(page) {
  let c = null;
  let timedOut = false;
  let timer;
  try {
    const probe = (async () => {
      const session = await CDP({ host: CDP_HOST, port: CDP_PORT, target: page.id });
      // Timed out while connecting: nobody else will close this session.
      if (timedOut) { session.close().catch(() => {}); return null; }
      c = session;
      const r = await c.Runtime.evaluate({ expression: 'window.env?.windowId ?? null', returnByValue: true });
      return r?.result?.value ?? null;
    })();
    probe.catch(() => {});
    const timeout = new Promise((res) => {
      timer = setTimeout(() => { timedOut = true; res(null); }, WINDOW_PROBE_TIMEOUT_MS);
    });
    return await Promise.race([probe, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (c) c.close().catch(() => {});
  }
}

export async function closeWindow(windowId) {
  const state = await listWindows();
  if (state.error) return state;
  if (windowId === state.currentWindowId) {
    return { error: 'REFUSE_CLOSE_CURRENT', windowId, hint: 'Closing the window this MCP session is driving would break the CDP connection. Use listWindows to pick a sub-window id.' };
  }
  const r = await evaluateAsync(`(function(){
    const st = window.app['useWindowStateStore'];
    const s = st.getState();
    // NOTE: the renderer's persisted windows map can be stale/partial — the
    // authoritative check is the main process's SubWindowManager.windowsMap,
    // which just warns when the id is unknown. So no has() gate here.
    s.closeSubWindow(${JSON.stringify(windowId)});
    return { closing: ${JSON.stringify(windowId)} };
  })()`);
  return { ...r, requested: windowId };
}

export async function closeSubWindows({ exceptCurrent = true } = {}) {
  const state = await listWindows();
  if (state.error) return state;
  // Live ids from the CDP page probe (window.env.windowId) — the persisted
  // store map is stale; the main process harmlessly warns on unknown ids.
  const ids = (state.openWindows ?? []).map((w) => w.windowId).filter((id) => id !== null && id !== undefined);
  const targets = exceptCurrent ? ids.filter((id) => id !== state.currentWindowId) : ids;
  const results = [];
  for (const id of targets) {
    results.push({ windowId: id, ...(await closeWindow(id)) });
  }
  return { closed: results.filter((r) => r.closing !== undefined).map((r) => r.windowId), results };
}
