/**
 * `sn call <tool> [--json '{...}'] [--arg k=v ...]`
 *
 * Generic tool invoker — the CLI's local mirror of what an agent sees over MCP /
 * REST. It runs the tool through the SAME projection the `/v1/tools/{name}` REST
 * endpoint uses (`invokeToolRest`), so the CLI, REST, and MCP all resolve from
 * one tool catalog with one scope model. Internal / localOnly tools are not
 * reachable here (same public surface as the server card).
 */
import { emitSnResult } from './parse.js';
import type { SnArgs } from './types.js';
import { requestContext } from '../../lib/request-context.js';
import { invokeToolRest, extractRestError, restToolNames } from '../../lib/rest-invoke.js';

function fail(message: string, asJson: boolean): never {
  if (asJson) emitSnResult({ ok: false, command: 'call', error: message }, true);
  else console.error(`Error: ${message}`);
  process.exit(1);
}

/** Parse the tool arguments from `--json` (preferred) or repeated `--arg k=v`. */
function parseToolArgs(args: SnArgs, asJson: boolean): Record<string, unknown> {
  const json = args.json;
  if (typeof json === 'string' && json.trim()) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      fail('--json must be a JSON object.', asJson);
    } catch {
      fail('--json is not valid JSON.', asJson);
    }
  }
  // --arg k=v (may repeat → string | string[])
  const raw = args.arg;
  const pairs = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) fail(`--arg "${pair}" must be key=value.`, asJson);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    // best-effort typing: JSON value if it parses, else string
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export async function handleCall(args: SnArgs, asJson: boolean): Promise<void> {
  const toolName = args._[0];
  if (!toolName) {
    fail("Usage: sn call <tool> [--json '{...}'] [--arg k=v]", asJson);
  }
  if (!restToolNames().has(toolName)) {
    fail(`Unknown tool '${toolName}'. Run 'sn tools' to list callable tools.`, asJson);
  }

  const toolArgs = parseToolArgs(args, asJson);

  // Resolve the caller's real scopes from their stored key (same path as `sn info`).
  const { loadApiKey } = await import('../credentials.js');
  const { validateApiKey } = await import('../../auth/api-keys.js');
  const apiKey = process.env.SOCIALNEURON_API_KEY || (await loadApiKey());
  if (!apiKey) {
    fail("Not authenticated. Run 'sn login' or set SOCIALNEURON_API_KEY.", asJson);
  }
  const auth = await validateApiKey(apiKey);
  if (!auth.valid) {
    fail('API key is invalid or expired. Run `sn login`.', asJson);
  }

  const result = await requestContext.run(
    {
      userId: auth.userId ?? 'cli-user',
      scopes: auth.scopes ?? [],
      token: apiKey,
      creditsUsed: 0,
      assetsGenerated: 0,
    },
    () => invokeToolRest(toolName, toolArgs)
  );

  if (result.isError) {
    const err = extractRestError(result);
    if (asJson) {
      emitSnResult({ ok: false, command: 'call', tool: toolName, error: err }, true);
    } else {
      console.error(`[${err.error_type}] ${err.message}`);
    }
    process.exit(1);
  }

  // Success — the tool's text content is usually JSON; surface it directly.
  const text = result.content?.find(c => c.type === 'text')?.text ?? '';
  if (asJson) {
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    emitSnResult({ ok: true, command: 'call', tool: toolName, data }, true);
  } else {
    console.log(text);
  }
  process.exit(0);
}
