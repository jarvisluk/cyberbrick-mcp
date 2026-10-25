import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitize, readConsoleLog, getClient } from '../connection.js';
import { healthCheck, launchApp } from '../core/health.js';

export function registerHealthTools(server) {
  server.tool(
    'cb_health',
    'Check CyberBrick app health: CDP endpoint live, app version, renderer bridge access, device count. Call this first.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const result = await healthCheck();
      return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
    },
  );

  server.tool(
    'cb_launch',
    'Launch the CyberBrick desktop app with the CDP debug port (9223). Reuses a reachable CDP endpoint. If the app is already running without the debug port, it fails unless kill_existing=true (the app enforces a single-instance lock) — killing it discards unsaved work, so get the user\'s OK first. NOTE: must run from an unsandboxed shell.',
    {
      kill_existing: z.boolean().default(false).describe('Kill a running CyberBrick instance (without the CDP port) before launching. Only with the user\'s OK — unsaved work is lost.'),
      timeout_ms: z.number().default(20000).describe('Max wait for the CDP endpoint to come up.'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ kill_existing, timeout_ms }) => {
      try {
        const result = await launchApp({ killExisting: kill_existing, timeoutMs: timeout_ms });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `LAUNCH_FAILED: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'app_logs',
    'Read the CyberBrick app\'s renderer console, captured by this MCP server since it attached (ring buffer, 5000 lines; lines that mention tokens/keys/PINs/certs are never stored). Poll with since=<lastSeq> to follow long tasks such as flash_config with hardwareMappings (upgrade → send config → pairing). Per-message B0 traffic and keepalives are hidden unless includeNoise. Read-only.',
    {
      since: z.number().int().default(0).describe('Return only lines with seq > since (use lastSeq from the previous call).'),
      grep: z.string().optional().describe('Case-insensitive regex filter on the line text.'),
      levels: z.array(z.string()).optional().describe("Console levels to keep, e.g. ['error','warning']."),
      limit: z.number().int().default(200).describe('Max lines returned (the newest matching ones).'),
      includeNoise: z.boolean().default(false).describe('Include per-message B0 traffic and keepalive lines.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        await getClient(); // capture starts when the CDP session attaches
        const result = readConsoleLog(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
      }
    },
  );
}
