/**
 * `sn` — standalone Social Neuron CLI binary.
 *
 * Same commands as `socialneuron-mcp` minus MCP-server mode:
 *   sn posts | loop | publish | preset list | quality-check | ...   (sn namespace)
 *   sn login | logout | whoami | health | repl                       (account/system)
 *
 * Build:  `npm run build:sn` → dist/sn.js   ·   Bin: "sn" in package.json.
 *
 * Auth chatter is suppressed by default (SN_CLI_QUIET, honored in lib/supabase.ts)
 * so `--json` output pipes clean; pass `--verbose` to restore the [MCP] auth logs.
 *
 * NOTE: this entry deliberately does NOT import src/index.ts — that file is the
 * deployed MCP-server entry and must stay untouched. The small dispatch below
 * mirrors index.ts's CLI branches; if it grows, extract a shared dispatch module.
 */

import { MCP_VERSION } from './lib/version.js';
import { runSnCli, printSnUsage } from './cli/sn.js';

// Read at runtime by lib/supabase.ts to silence the [MCP] auth lines.
process.env.SN_CLI_QUIET = '1';

async function main(): Promise<void> {
  const command = process.argv[2];
  const wantsJson = process.argv.includes('--json');

  if (command === '--version' || command === '-v') {
    if (wantsJson) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, command: 'version', version: MCP_VERSION, name: 'sn', schema_version: '1' },
          null,
          2
        ) + '\n'
      );
    } else {
      console.log(`sn (Social Neuron CLI) v${MCP_VERSION}`);
    }
    process.exit(0);
  }

  if (!command || command === '--help' || command === '-h') {
    printSnUsage();
    process.exit(0);
  }

  switch (command) {
    case 'setup':
    case 'login': {
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
    case 'logout': {
      const { runLogoutCommand } = await import('./cli/commands.js');
      await runLogoutCommand({ json: wantsJson });
      process.exit(0);
    }
    case 'whoami': {
      const { runWhoami } = await import('./cli/commands.js');
      await runWhoami({ json: wantsJson });
      process.exit(0);
    }
    case 'health': {
      const { runHealthCheck } = await import('./cli/commands.js');
      await runHealthCheck({ json: wantsJson });
      process.exit(0);
    }
    case 'repl': {
      const { runRepl } = await import('./cli/repl.js');
      await runRepl(); // never returns
      return;
    }
    default: {
      // sn-namespace command (posts, loop, publish, preset, quality-check, …).
      // Auth is deferred — each subcommand calls ensureAuth() only if it needs it.
      await runSnCli(process.argv.slice(2));
      // Flush stdout fully before exit so piped output is never truncated.
      await new Promise<void>(resolve => {
        process.stdout.write('', () => resolve());
      });
      process.exit(0);
    }
  }
}

main().catch(err => {
  process.stderr.write(`sn: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
