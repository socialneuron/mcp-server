/**
 * Shell completion generation for the `sn` CLI.
 *
 * sn completions bash   — Bash completions
 * sn completions zsh    — Zsh completions
 */

import type { SnArgs } from './types.js';

const ALL_COMMANDS = [
  'generate', 'video', 'image',
  'publish', 'quality-check', 'e2e', 'plan', 'preset',
  'oauth-health', 'oauth-refresh', 'preflight',
  'posts', 'refresh-analytics', 'loop',
  'status', 'autopilot', 'usage', 'credits',
  'tools', 'info', 'completions', 'config',
  'content', 'account', 'analytics', 'system', 'discovery',
  'login', 'logout', 'whoami', 'health',
];

const GLOBAL_FLAGS = ['--json', '--output', '--help'];

const BASH_COMPLETION = `
# Bash completion for sn (Social Neuron CLI)
_sn_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${ALL_COMMANDS.join(' ')}"
  local flags="${GLOBAL_FLAGS.join(' ')}"

  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
  elif [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${flags} --prompt --platform --model --aspect-ratio --days --limit --plan-id --job-id --scope --module --confirm" -- "\${cur}") )
  fi
}
complete -F _sn_completions sn
complete -F _sn_completions socialneuron-mcp
`.trim();

const ZSH_COMPLETION = `
#compdef sn socialneuron-mcp

_sn() {
  local -a commands=(
    'generate:Generate text content'
    'video:Generate video (async)'
    'image:Generate image (async)'
    'publish:Schedule a post'
    'quality-check:Quality check content'
    'e2e:End-to-end publish flow'
    'plan:Content plan management'
    'preset:Platform presets'
    'oauth-health:Check OAuth status'
    'oauth-refresh:Refresh OAuth tokens'
    'preflight:Pre-publish checks'
    'posts:List recent posts'
    'refresh-analytics:Refresh analytics'
    'loop:Feedback loop summary'
    'status:Check job status'
    'autopilot:Autopilot config'
    'usage:Usage statistics'
    'credits:Credit balance'
    'tools:List MCP tools'
    'info:Server info'
    'completions:Shell completions'
    'config:Configuration'
    'login:Authenticate'
    'logout:Clear credentials'
    'whoami:Show identity'
    'health:System health'
  )

  _arguments \\
    '1: :->command' \\
    '*: :->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      _arguments \\
        '--json[Output as JSON]' \\
        '--output[Output format (json, table, csv)]:format:(json table csv)' \\
        '--prompt[Content prompt]:prompt:' \\
        '--platform[Target platform]:platform:(youtube tiktok instagram twitter linkedin facebook threads bluesky)' \\
        '--model[AI model]:model:' \\
        '--help[Show help]'
      ;;
  esac
}

_sn "$@"
`.trim();

export async function handleCompletions(args: SnArgs, _asJson: boolean): Promise<void> {
  const shell = args._[0] as string;

  if (!shell || shell === '--help' || shell === '-h') {
    console.log('Usage: sn completions <bash|zsh>');
    console.log('');
    console.log('Add to your shell profile:');
    console.log('  Bash: eval "$(sn completions bash)"');
    console.log('  Zsh:  eval "$(sn completions zsh)"');
    return;
  }

  if (shell === 'bash') {
    process.stdout.write(BASH_COMPLETION + '\n');
  } else if (shell === 'zsh') {
    process.stdout.write(ZSH_COMPLETION + '\n');
  } else {
    console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
    process.exit(1);
  }
}
