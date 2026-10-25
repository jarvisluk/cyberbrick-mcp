/**
 * Firmware configuration editing (workflow 2 of the user request).
 *
 * The CyberBrick firmware is described by `window.app.useFirmwareConfigStore`.
 * Editing it here calls the SAME zustand store actions the app UI calls, so the
 * app immediately reflects changes. Burning it to the board is a separate step
 * in core/flash.js (runSendConfigTask) — also a direct call into the app.
 *
 * These functions are thin pass-throughs to the app's own store; there is no
 * MCP-side confirmation, preview, or token layer. The app is the source of
 * truth for what each action does.
 *
 * Functions:
 *  - getFirmwareConfig(): read whole config
 *  - listEditingActions(): list the store action names (Agent discovery)
 *  - actionCatalog(): semantic docs for every action (core/action_docs.js)
 *  - applySet(rawConfig): setFirmwareConfig — replace whole config
 *  - applyEdit(action, args): call a single store action
 *  - applyReset(): resetFirmwareConfig — clear to defaults
 *  - applyLoadTemplate(key, opts): replace the editor config with a built-in template
 */
import { evaluateAsync, callStoreAction, readStoreState } from '../connection.js';
import { actionCatalog } from './action_docs.js';
import { getTemplateData } from './project.js';

export async function getFirmwareConfig() {
  const state = await readStoreState('useFirmwareConfigStore');
  return state;
}

/** List available editor action names (for agent discovery of the editing surface). */
export async function listEditingActions() {
  const raw = await evaluateAsync(`(function(){
    const s = window.app.useFirmwareConfigStore;
    const st = s && (s.getState ? s.getState() : s);
    if (!st) return { error: 'NO_STORE' };
    return Object.keys(st).filter(k => typeof st[k] === 'function');
  })()`);
  return Array.isArray(raw) ? raw : (raw && raw.error ? raw : []);
}

/** Semantic docs + enums for the editing surface (no live call needed). */
export function getActionCatalog() {
  return actionCatalog();
}

/** Apply a full-config replacement via the app's setFirmwareConfig. */
export async function applySet(rawConfig) {
  return callStoreAction('useFirmwareConfigStore', 'setFirmwareConfig', [rawConfig]);
}

/** Apply a single store action (e.g. updateReceiverChannel, changeSwitchState). */
export async function applyEdit(action, args) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(action)) {
    throw new Error(`Invalid action name: ${action}`);
  }
  return callStoreAction('useFirmwareConfigStore', action, args ?? []);
}

/** Reset config to empty defaults via the app's resetFirmwareConfig. */
export async function applyReset() {
  return callStoreAction('useFirmwareConfigStore', 'resetFirmwareConfig', []);
}

/**
 * Replace the editor config with a built-in template's data (pa.getTemplateData,
 * same JSON project_create uses). The app has no in-editor "apply template"
 * action — it only creates new projects from templates — so this composes its
 * primitives: setFirmwareConfig(template) + setIsModified(true). By default the
 * loaded project's id/config_name are kept, so project_save overwrites that
 * project instead of adding a new one.
 */
export async function applyLoadTemplate(templateKey, { keepIdentity = true } = {}) {
  const tpl = await getTemplateData(templateKey);
  return evaluateAsync(`(function(){
    const cfg = window.app.useFirmwareConfigStore?.getState();
    if (!cfg) return { error: 'NO_STORE' };
    const tpl = ${JSON.stringify(tpl)};
    const cur = cfg.firmwareConfig;
    if (${keepIdentity ? 'true' : 'false'} && cur && cur.id) {
      tpl.id = cur.id;
      if (cur.config_name) tpl.config_name = cur.config_name;
      for (const k of ['type', 'design_id', 'region']) if (cur[k] !== undefined) tpl[k] = cur[k];
    }
    cfg.setFirmwareConfig(tpl);
    if (typeof cfg.setIsModified === 'function') cfg.setIsModified(true);
    const now = window.app.useFirmwareConfigStore.getState();
    return { loaded: ${JSON.stringify(templateKey)}, configId: now.firmwareConfig?.id ?? null, configName: now.firmwareConfig?.config_name ?? null, isModified: now.isModified ?? null };
  })()`);
}
