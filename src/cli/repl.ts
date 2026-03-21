import { createInterface } from 'node:readline';
import { MCP_VERSION } from '../lib/version.js';

/**
 * Interactive REPL for the Social Neuron CLI.
 * Entry point: `socialneuron-mcp repl` or `sn shell`.
 */
export async function runRepl(): Promise<void> {
  // 1. Print banner
  process.stderr.write(`\nSocial Neuron CLI v${MCP_VERSION} — Interactive Mode\n`);
  process.stderr.write('Type a command, .help for help, or .exit to quit.\n\n');

  // 2. Try to authenticate once at startup (non-fatal)
  let authUserId: string | null = null;
  try {
    const { loadApiKey } = await import('./credentials.js');
    const { validateApiKey } = await import('../auth/api-keys.js');
    const key = await loadApiKey();
    if (key) {
      const result = await validateApiKey(key);
      if (result.valid) {
        authUserId = result.userId || null;
        process.stderr.write(`  Authenticated (user: ${authUserId || 'unknown'})\n\n`);
      }
    }
  } catch {
    process.stderr.write('  Not authenticated (some commands will require login)\n\n');
  }

  // 3. Command names for tab completion
  const COMPLETIONS = [
    'publish',
    'quality-check',
    'e2e',
    'oauth-health',
    'oauth-refresh',
    'preflight',
    'posts',
    'refresh-analytics',
    'loop',
    'status',
    'autopilot',
    'usage',
    'credits',
    'tools',
    'info',
    'plan',
    'preset',
    'content',
    'account',
    'analytics',
    'system',
    '.help',
    '.exit',
    '.clear',
  ];

  // 4. Create readline interface
  const promptStr = authUserId ? `sn[${authUserId.substring(0, 8)}]> ` : 'sn> ';

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: promptStr,
    completer: (line: string) => {
      const hits = COMPLETIONS.filter(c => c.startsWith(line.trim()));
      return [hits.length ? hits : COMPLETIONS, line];
    },
  });

  rl.prompt();

  rl.on('line', async line => {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Special REPL commands
    if (trimmed === '.exit' || trimmed === 'exit' || trimmed === 'quit') {
      process.stderr.write('Goodbye.\n');
      rl.close();
      process.exit(0);
    }

    if (trimmed === '.help') {
      process.stderr.write('\nREPL Commands:\n');
      process.stderr.write('  .help     Show this help\n');
      process.stderr.write('  .clear    Clear the screen\n');
      process.stderr.write('  .exit     Exit the REPL\n');
      process.stderr.write('\nCLI Commands:\n');
      process.stderr.write('  publish, quality-check, e2e, posts, credits, etc.\n');
      process.stderr.write('  Type any sn subcommand directly (no "sn" prefix needed)\n\n');
      rl.prompt();
      return;
    }

    if (trimmed === '.clear') {
      process.stderr.write('\x1b[2J\x1b[H');
      rl.prompt();
      return;
    }

    // Parse as CLI command — override process.exit so it doesn't kill the REPL
    const originalExit = process.exit;
    process.exit = ((_code?: number) => {
      // Swallow exit calls — REPL stays alive
    }) as typeof process.exit;

    try {
      const { runSnCli } = await import('./sn.js');
      const argv = splitArgs(trimmed);
      await runSnCli(argv);
    } catch (err) {
      // withSnErrorHandling should catch most errors, but just in case:
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
    } finally {
      process.exit = originalExit;
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });

  // Keep the process alive — never resolves; REPL runs until exit
  await new Promise(() => {});
}

/**
 * Split a command line string into argv-like tokens.
 * Handles double-quoted strings.
 */
function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}
