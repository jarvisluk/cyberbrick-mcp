import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitize } from '../connection.js';
import {
  getFirmwareConfig, getActionCatalog,
  applySet, applyEdit, applyReset, applyLoadTemplate,
} from '../core/firmware.js';
import { TEMPLATE_KEYS } from '../core/project.js';

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function ok(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result ?? { done: true }, null, 2) }] };
}
function fail(err) {
  return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
}

export function registerFirmwareTools(server) {
  server.registerTool(
    'firmware_config_get',
    {
      title: 'Get current firmware config',
      description: 'Read the current firmwareConfig from the app store (window.app.useFirmwareConfigStore). This is what would be burned to the board. Read-only.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = await getFirmwareConfig();
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(cfg), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'firmware_edit_actions',
    {
      title: 'List firmware editing actions',
      description:
        'Semantic documentation for the firmware-config store actions (window.app.useFirmwareConfigStore) — the surface behind firmware_config_edit. ' +
        'Returns enums (receiverKey, actuator, device, configType), grouped action names, and per-action arg signatures. ' +
        'Pass action=<name> to get the doc for one action. Read-only, no app connection required.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        action: z.string().optional().describe('Return the doc for a single action name instead of the full catalog.'),
      },
    },
    async ({ action }) => {
      try {
        const catalog = getActionCatalog();
        if (action) {
          const doc = catalog.actions[action];
          if (!doc) return ok({ error: 'UNKNOWN_ACTION', action, known: Object.keys(catalog.actions) });
          return ok({ action, ...doc });
        }
        return ok(catalog);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'firmware_config_set',
    {
      title: 'Set full firmware config',
      description: 'Replace the whole firmware config via the app store\'s setFirmwareConfig. Immediately applies to the app store (and the next burn). MUTATING — writes to the app\'s firmware config.',
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        config: z.any().describe('Full firmware config object (mirror of firmware_config_get).'),
      },
    },
    async ({ config }) => {
      try {
        const result = await applySet(config);
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'firmware_config_edit',
    {
      title: 'Edit one config field',
      description:
        'Call a single firmware store action on the app store (e.g. updateReceiverChannel, updateSenderChannel, changeSwitchState). ' +
        'Immediately applies to the editor config. MUTATING. Use firmware_edit_actions first to get the exact arg signature ' +
        '(positional args, enums like receiverKey/actuator) for the action you want.',
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        action: z.string().describe('Store action name, e.g. updateReceiverChannel. See firmware_edit_actions.'),
        args: z.array(z.unknown()).default([]).describe('Positional arguments for the action, in the documented order.'),
      },
    },
    async ({ action, args }) => {
      try {
        const result = await applyEdit(action, args);
        return ok(sanitize(result));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'firmware_config_reset',
    {
      title: 'Reset config to empty defaults',
      description: 'Clear the firmware config to empty defaults via the app store\'s resetFirmwareConfig. Immediately applies. MUTATING.',
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {},
    },
    async () => {
      try {
        const result = await applyReset();
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'firmware_config_load_template',
    {
      title: 'Load built-in template into editor',
      description: 'Replace the editor config with one of the app\'s built-in project templates (same data as project_create, in the app\'s UI language). By default keeps the loaded project\'s id/name so project_save overwrites it; keepIdentity=false loads it as an unsaved new config. Marks the editor modified; nothing is written to the project list or board until project_save / flash_config. MUTATING.',
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        template: z.enum(TEMPLATE_KEYS).describe('Built-in template key (same set as project_create).'),
        keepIdentity: z.boolean().default(true).describe('Keep the current project id/config_name/design_id/region.'),
      },
    },
    async ({ template, keepIdentity }) => {
      try {
        return ok(sanitize(await applyLoadTemplate(template, { keepIdentity })));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
