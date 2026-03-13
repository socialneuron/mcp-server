import { parseSnArgs, isEnabledFlag } from './sn/parse.js';
import { withSnErrorHandling } from './error-handling.js';
import type { SnArgs } from './sn/types.js';

// ── Command Registry ────────────────────────────────────────────────

type CommandEntry = {
  handler: (args: SnArgs, asJson: boolean) => Promise<void>;
  needsAuth: boolean;
  group: string;
};

const COMMAND_REGISTRY: Record<string, CommandEntry> = {
  publish: { handler: lazyContent('handlePublish'), needsAuth: true, group: 'content' },
  'quality-check': {
    handler: lazyContent('handleQualityCheck'),
    needsAuth: false,
    group: 'content',
  },
  e2e: { handler: lazyContent('handleE2e'), needsAuth: true, group: 'content' },
  'oauth-health': {
    handler: lazyAccount('handleOauthHealth'),
    needsAuth: true,
    group: 'account',
  },
  'oauth-refresh': {
    handler: lazyAccount('handleOauthRefresh'),
    needsAuth: true,
    group: 'account',
  },
  preflight: { handler: lazyAccount('handlePreflight'), needsAuth: true, group: 'account' },
  status: { handler: lazySystem('handleStatus'), needsAuth: true, group: 'system' },
  autopilot: { handler: lazySystem('handleAutopilot'), needsAuth: true, group: 'system' },
  usage: { handler: lazySystem('handleUsage'), needsAuth: true, group: 'system' },
  credits: { handler: lazySystem('handleCredits'), needsAuth: true, group: 'system' },
  posts: { handler: lazyAnalytics('handlePosts'), needsAuth: true, group: 'analytics' },
  'refresh-analytics': {
    handler: lazyAnalytics('handleRefreshAnalytics'),
    needsAuth: true,
    group: 'analytics',
  },
  loop: { handler: lazyAnalytics('handleLoop'), needsAuth: true, group: 'analytics' },
  tools: { handler: lazyDiscovery('handleTools'), needsAuth: false, group: 'discovery' },
  info: { handler: lazyDiscovery('handleInfo'), needsAuth: false, group: 'discovery' },
  plan: { handler: lazyPlanning('handlePlan'), needsAuth: true, group: 'content' },
  preset: { handler: lazyPresets('handlePreset'), needsAuth: false, group: 'content' },
};

// Command groups for "sn content", "sn account", etc.
const GROUP_COMMANDS: Record<string, string[]> = {
  content: ['publish', 'quality-check', 'e2e', 'plan', 'preset'],
  account: ['oauth-health', 'oauth-refresh', 'preflight'],
  analytics: ['posts', 'refresh-analytics', 'loop'],
  system: ['status', 'autopilot', 'usage', 'credits'],
  discovery: ['tools', 'info'],
};

// ── Lazy loaders (avoid importing all modules upfront) ──────────────

function lazyContent(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/content.js');
    return (mod as any)[name](args, asJson);
  };
}

function lazyAccount(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/account.js');
    return (mod as any)[name](args, asJson);
  };
}

function lazyAnalytics(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/analytics.js');
    return (mod as any)[name](args, asJson);
  };
}

function lazySystem(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/system.js');
    return (mod as any)[name](args, asJson);
  };
}

function lazyDiscovery(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/discovery.js');
    return (mod as any)[name](args, asJson);
  };
}

function lazyPlanning(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/planning.js');
    return (mod as any)[name](args, asJson);
  };
}

function lazyPresets(name: string) {
  return async (args: SnArgs, asJson: boolean) => {
    const mod = await import('./sn/presets.js');
    return (mod as any)[name](args, asJson);
  };
}

// ── Help ────────────────────────────────────────────────────────────

export function printSnUsage(): void {
  console.error('');
  console.error('Usage: socialneuron-mcp sn <command> [flags]');
  console.error('');
  console.error('Discovery:');
  console.error('  tools [--scope <scope>] [--module <module>] [--json]');
  console.error('  info [--json]');
  console.error('');
  console.error('Content:');
  console.error(
    '  publish --media-url <url> --caption <text> --platforms <comma-list> --confirm [--title <text>] [--schedule-at <iso8601>] [--idempotency-key <key>] [--json]'
  );
  console.error(
    '  quality-check --caption <text> [--title <text>] [--platforms <comma-list>] [--threshold <0-35>] [--json]'
  );
  console.error(
    '  e2e --media-url <url> --caption <text> --platforms <comma-list> --confirm [--title <text>] [--schedule-at <iso8601>] [--check-urls] [--threshold <0-35>] [--dry-run] [--force] [--json]'
  );
  console.error(
    '  plan (list|view|approve) [--plan-id <id>] [--status <draft|submitted|approved>] [--json]'
  );
  console.error(
    '  preset (list|show|save|delete) [--name <name>] [--platform <name>] [--max-length <n>] [--aspect-ratio <ratio>] [--json]'
  );
  console.error('');
  console.error('Account:');
  console.error('  preflight [--privacy-url <url>] [--terms-url <url>] [--check-urls] [--json]');
  console.error('  oauth-health [--warn-days <1-90>] [--platforms <comma-list>] [--all] [--json]');
  console.error('  oauth-refresh (--platforms <comma-list> | --all) [--json]');
  console.error('');
  console.error('Analytics:');
  console.error(
    '  posts [--days <1-90>] [--platform <name>] [--status <draft|scheduled|published|failed>] [--json]'
  );
  console.error('  refresh-analytics [--json]');
  console.error('  loop [--json]');
  console.error('');
  console.error('System:');
  console.error('  status --job-id <id> [--json]');
  console.error('  autopilot [--json]');
  console.error('  usage [--json]');
  console.error('  credits [--json]');
  console.error('');
}

// ── Dispatcher ──────────────────────────────────────────────────────

export async function runSnCli(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (!first) {
    printSnUsage();
    process.exit(1);
  }

  // Check if first arg is a group name (e.g., "sn content publish")
  if (GROUP_COMMANDS[first]) {
    const [subcommand, ...groupRest] = rest;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      console.error(`\nCommands in "${first}" group:`);
      for (const cmd of GROUP_COMMANDS[first]) {
        console.error(`  ${cmd}`);
      }
      console.error('');
      process.exit(subcommand ? 0 : 1);
    }

    const entry = COMMAND_REGISTRY[subcommand];
    if (!entry || entry.group !== first) {
      console.error(`Unknown ${first} subcommand: ${subcommand}`);
      console.error(`Available: ${GROUP_COMMANDS[first].join(', ')}`);
      process.exit(1);
    }

    const args = parseSnArgs(groupRest);
    const asJson = isEnabledFlag(args.json);
    await withSnErrorHandling(subcommand, asJson, () => entry.handler(args, asJson));
    return;
  }

  // Direct command (e.g., "sn publish")
  const entry = COMMAND_REGISTRY[first];
  if (!entry) {
    console.error(`Unknown subcommand: ${first}`);
    printSnUsage();
    process.exit(1);
  }

  const args = parseSnArgs(rest);
  const asJson = isEnabledFlag(args.json);
  await withSnErrorHandling(first, asJson, () => entry.handler(args, asJson));
}
