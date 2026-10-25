/**
 * Project management tools — pure pass-through to the app's project surface
 * (useFirmwareListStore actions + the same editor/navigation primitives the
 * app itself uses). See core/project.js for the mapping to app internals.
 *
 * Destructive tools are annotated via destructiveHint and say so in the
 * description.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitize } from '../connection.js';
import {
  TEMPLATE_KEYS,
  getProjectState, listProjects, getProject,
  createProjectFromTemplate, importProjectFromContent, exportProjectContent,
  renameProject, deleteProject,
  loadProjectToEditor, saveProjectFromEditor, openProjectEditor,
  listWindows, closeWindow, closeSubWindows,
} from '../core/project.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function ok(result) {
  return { content: [{ type: 'text', text: JSON.stringify(sanitize(result ?? { done: true }), null, 2) }] };
}
function fail(err) {
  return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
}

export function registerProjectTools(server) {
  server.registerTool(
    'project_state',
    {
      title: 'Get project page state',
      description:
        'Read the app\'s current context: active route (hash), project list summary, and editor state (isModified, configType). ' +
        'Returns a nextTools list of the tools relevant right now — call this first when working with CyberBrick projects, then act. Read-only.',
      annotations: READ,
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await getProjectState());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description:
        'List CyberBrick projects via the app store\'s getShowList(): configId, type, configName, designLink, lastModifiedTime. ' +
        'Pass include=full to fetch one project\'s complete config body via getFirmwareById. Read-only.',
      annotations: READ,
      inputSchema: {
        id: z.string().optional().describe('Return the full record for this configId instead of the list summary.'),
      },
    },
    async ({ id }) => {
      try {
        if (id) {
          const record = await getProject(id);
          if (!record) return ok({ error: 'PROJECT_NOT_FOUND', id });
          return ok(record);
        }
        const { projects, count } = await listProjects();
        return ok({ count, projects });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_create',
    {
      title: 'Create project from template',
      description:
        'Create a new CyberBrick project from a built-in template (the app\'s createProjectFromTemplate flow: template config + addFirmware). ' +
        'Templates: forklift, truck, forklift_and_truck, ball_car, official_remote, none, custom. MUTATING (adds a project to the app\'s list).',
      annotations: WRITE,
      inputSchema: {
        template: z.enum(TEMPLATE_KEYS).describe('Built-in template key.'),
        name: z.string().max(31).optional().describe('Project name (max 31 chars, as the app validates). Defaults to the template\'s own name.'),
      },
    },
    async ({ template, name }) => {
      try {
        const result = await createProjectFromTemplate(template, name);
        return ok({ created: true, template, ...result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_import',
    {
      title: 'Import project from JSON content',
      description:
        'Import a project from its JSON content (the app\'s importProjectFromFileContent flow): validates config_version ' +
        '(rejects files newer than the app supports), forces design_id/region to app defaults, adds to the project list. ' +
        'Pass the file content as a string — read the file yourself first. MUTATING (adds a project).',
      annotations: WRITE,
      inputSchema: {
        content: z.string().min(1).describe('Project JSON content (a CyberBrick project file exported by project_export or the app).'),
        name: z.string().max(31).optional().describe('Project name; defaults to config_name from the content, else "config". ".json" suffix is stripped.'),
      },
    },
    async ({ content, name }) => {
      try {
        const result = await importProjectFromContent(content, name);
        return ok({ imported: true, ...result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_export',
    {
      title: 'Export project as JSON content',
      description:
        'Export a project\'s config as JSON content — the same serialization the app\'s export uses (runtime fields stripped, version stamped). ' +
        'No save dialog; write the returned content to a file yourself. Read-only.',
      annotations: READ,
      inputSchema: {
        id: z.string().describe('Project configId (from project_list).'),
      },
    },
    async ({ id }) => {
      try {
        const json = await exportProjectContent(id);
        return { content: [{ type: 'text', text: json }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_rename',
    {
      title: 'Rename project',
      description:
        'Rename a project via the app store\'s renameFirmware. MUTATING. Max 31 chars (app validation).',
      annotations: WRITE,
      inputSchema: {
        id: z.string().describe('Project configId (from project_list).'),
        name: z.string().min(1).max(31).describe('New project name (max 31 chars).'),
      },
    },
    async ({ id, name }) => {
      try {
        await renameProject(id, name);
        return ok({ renamed: true, id, name });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_delete',
    {
      title: 'Delete project',
      description:
        'DESTRUCTIVE: permanently deletes the project via the app store\'s deleteFirmware. ' +
        'This cannot be undone — the project config is removed from the app\'s persisted list. No confirmation is added by MCP.',
      annotations: DESTRUCTIVE,
      inputSchema: {
        id: z.string().describe('Project configId (from project_list).'),
      },
    },
    async ({ id }) => {
      try {
        await deleteProject(id);
        return ok({ deleted: true, id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_load',
    {
      title: 'Load project into editor',
      description:
        'Load a project\'s config into the app\'s firmware editor store (setFirmwareConfig(getFirmwareById(id)) + setConfigType), ' +
        'the same thing the app does when you open a project. After loading, use firmware_config_edit to change parameters, ' +
        'then project_save to persist. MUTATING (replaces the current editor config).',
      annotations: WRITE,
      inputSchema: {
        id: z.string().describe('Project configId (from project_list).'),
      },
    },
    async ({ id }) => {
      try {
        return ok(await loadProjectToEditor(id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_save',
    {
      title: 'Save editor config as project',
      description:
        'Persist the current editor config into the project list (the app store\'s updateFirmware: updates by id, adds if new) ' +
        'and mark the editor as saved. MUTATING (writes the project list).',
      annotations: WRITE,
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await saveProjectFromEditor());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'project_open_editor',
    {
      title: 'Open project editor window',
      description:
        'Open the project editor (the app\'s openProjectEditor): loads the config into the editor store, then opens ' +
        '/project/edit?firmwareId=<id> either in a new app window (default, via the app\'s createWindowWithPath) or by ' +
        'navigating the current window. MUTATING (loads config, opens window).',
      annotations: WRITE,
      inputSchema: {
        id: z.string().describe('Project configId (from project_list).'),
        target: z.enum(['new', 'current']).default('new').describe('"new" opens a separate editor window (app default); "current" navigates the main window.'),
      },
    },
    async ({ id, target }) => {
      try {
        return ok(await openProjectEditor(id, target));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'window_list',
    {
      title: 'List app windows',
      description:
        'List the CyberBrick app\'s open windows: `openWindows` is the live truth (CDP page list with titles + ' +
        'hash routes), `storeWindows` is the window-state store\'s persisted id map (may be stale) — its ids are ' +
        'what window_close accepts. Also reports which window this MCP session is connected to (currentWindowId) ' +
        'and whether its editor has unsaved changes. Read-only.',
      annotations: READ,
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await listWindows());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'window_close',
    {
      title: 'Close an app sub-window',
      description:
        'Close a CyberBrick app window by its windowId (from window_list). Uses the app\'s own closeSubWindow ' +
        '(window:close-sub-window IPC) — the same path as the window\'s close button; unsaved changes trigger the ' +
        'app\'s own confirm dialog, which the MCP does not bypass. The MCP-connected window cannot be closed ' +
        '(REFUSE_CLOSE_CURRENT). Each project_open_editor with target="new" opens one of these — close them to ' +
        'avoid window buildup. MUTATING.',
      annotations: WRITE,
      inputSchema: {
        windowId: z.number().int().describe('Window id to close (from window_list). Must not be the current window.'),
      },
    },
    async ({ windowId }) => {
      try {
        return ok(await closeWindow(windowId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'window_close_others',
    {
      title: 'Close all sub-windows except current',
      description:
        'Close every CyberBrick app window except the one this MCP session is connected to. Use to clean up ' +
        'editor windows accumulated from project_open_editor. Unsaved changes surface the app\'s own confirm ' +
        'dialogs. MUTATING.',
      annotations: WRITE,
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await closeSubWindows({ exceptCurrent: true }));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
