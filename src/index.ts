/**
 * Social Neuron MCP Server
 *
 * Exposes Social Neuron's AI content creation capabilities as MCP tools
 * for use with Claude Code, Claude Desktop, and other MCP clients.
 *
 * Transport: stdio (reads JSON-RPC from stdin, writes to stdout)
 *
 * CLI commands:
 *   setup / login  - Interactive OAuth setup flow
 *   logout         - Remove stored credentials
 *   (no args)      - Start MCP server (normal mode)
 *
 * Authentication (resolved in order):
 *   1. API key (stored via setup flow, validated against mcp-auth Edge Function)
 *   2. Service role key (legacy: SOCIALNEURON_SERVICE_KEY env var)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_VERSION } from './lib/version.js';
import { applyScopeEnforcement, registerAllTools } from './lib/register-tools.js';
import { initPostHog, shutdownPostHog } from './lib/posthog.js';
import { initializeAuth, getAuthenticatedScopes } from './lib/supabase.js';
import { runSnCli } from './cli/sn.js';

process.on('uncaughtException', err => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`MCP server error: ${message}\n`);
  process.exit(1);
});

// ── CLI Commands ─────────────────────────────────────────────────────

const command = process.argv[2];

if (command === '--version' || command === '-v') {
  // Read version from package.json at build time
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  let version = MCP_VERSION;
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    version = pkg.version;
  } catch {
    // Fall back to MCP_VERSION
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          command: 'version',
          version,
          name: '@socialneuron/mcp-server',
          schema_version: '1',
        },
        null,
        2
      ) + '\n'
    );
  } else {
    console.log(`@socialneuron/mcp-server v${version}`);
  }
  process.exit(0);
}

if (command === '--help' || command === '-h') {
  if (process.argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          command: 'help',
          commands: [
            { name: 'setup', aliases: ['login'], description: 'Interactive OAuth setup' },
            { name: 'logout', description: 'Remove credentials' },
            { name: 'whoami', description: 'Show auth info' },
            { name: 'health', description: 'Check connectivity' },
            { name: 'sn', description: 'CLI tools (publish, preflight, etc.)' },
            { name: 'repl', description: 'Interactive REPL mode' },
          ],
          schema_version: '1',
        },
        null,
        2
      ) + '\n'
    );
  } else {
    console.log(
      `
@socialneuron/mcp-server — AI content creation tools for Claude

Usage:
  socialneuron-mcp                Start MCP server (stdio transport)
  socialneuron-mcp setup          Interactive OAuth setup flow
  socialneuron-mcp login          Alias for setup
  socialneuron-mcp login --device Device code flow (headless environments)
  socialneuron-mcp login --paste  Paste API key directly
  socialneuron-mcp logout         Remove stored credentials
  socialneuron-mcp whoami         Show authenticated user info
  socialneuron-mcp health         Check connectivity, key validity, credits
  socialneuron-mcp sn <command>   CLI tools (publish, preflight, e2e, etc.)
  socialneuron-mcp repl           Interactive REPL mode
  socialneuron-mcp --version      Show version
  socialneuron-mcp --help         Show this help

Environment:
  SOCIALNEURON_API_KEY          API key (recommended — secure cloud mode)
  SOCIALNEURON_SERVICE_KEY      Service role key (deprecated — full admin access)
  SOCIALNEURON_SUPABASE_URL     Supabase project URL (optional in cloud mode)

Docs: https://github.com/socialneuron/mcp-server#readme
`.trim()
    );
  }
  process.exit(0);
}

if (command === 'setup' || command === 'login') {
  // Determine login method from flags
  const flags = process.argv.slice(3);
  if (flags.includes('--paste')) {
    const { runLogin } = await import('./cli/commands.js');
    await runLogin('paste');
  } else if (flags.includes('--device')) {
    const { runLogin } = await import('./cli/commands.js');
    await runLogin('device');
  } else {
    const { runSetup } = await import('./cli/setup.js');
    await runSetup();
  }
  process.exit(0);
}

if (command === 'logout') {
  const { runLogoutCommand } = await import('./cli/commands.js');
  const jsonFlag = process.argv.slice(3).includes('--json');
  await runLogoutCommand({ json: jsonFlag });
  process.exit(0);
}

if (command === 'whoami') {
  const { runWhoami } = await import('./cli/commands.js');
  const jsonFlag = process.argv.slice(3).includes('--json');
  await runWhoami({ json: jsonFlag });
  process.exit(0);
}

if (command === 'health') {
  const { runHealthCheck } = await import('./cli/commands.js');
  const jsonFlag = process.argv.slice(3).includes('--json');
  await runHealthCheck({ json: jsonFlag });
  process.exit(0);
}

if (command === 'repl') {
  const { runRepl } = await import('./cli/repl.js');
  await runRepl();
  // runRepl never returns (runs until exit)
}

if (command === 'sn') {
  const snSubcommand = process.argv[3];
  if (!snSubcommand || snSubcommand === '--help' || snSubcommand === '-h') {
    // Show help without requiring auth
    const { printSnUsage } = await import('./cli/sn.js');
    printSnUsage();
    process.exit(snSubcommand ? 0 : 1);
  }
  // Auth is deferred — each subcommand calls ensureAuth() only if needed
  await runSnCli(process.argv.slice(3));
  process.exit(0);
}

// ── Unknown command check ────────────────────────────────────────────

if (command && !['setup', 'login', 'logout', 'whoami', 'health', 'sn', 'repl'].includes(command)) {
  process.stderr.write(`Unknown command: ${command}\nRun socialneuron-mcp --help for usage.\n`);
  process.exit(1);
}

// ── Authenticate ─────────────────────────────────────────────────────

await initializeAuth();
initPostHog();

// ── Start MCP Server ─────────────────────────────────────────────────

const server = new McpServer({
  name: 'socialneuron',
  version: MCP_VERSION,
});

// ── Scope Enforcement + Tool Registration ────────────────────────────
applyScopeEnforcement(server, getAuthenticatedScopes);
registerAllTools(server);

// Graceful shutdown
async function shutdown() {
  await shutdownPostHog();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Connect via stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
