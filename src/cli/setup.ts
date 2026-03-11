/**
 * Interactive setup flow for the Social Neuron MCP server.
 *
 * Triggered by: npx @socialneuron/mcp-server setup
 *
 * 1. Generates PKCE code challenge
 * 2. Opens browser to the Social Neuron authorize page
 * 3. Listens on a local HTTP server for the callback with the API key
 * 4. Completes PKCE exchange to activate the key
 * 5. Stores the key in OS keychain
 * 6. Auto-configures MCP client (Claude Desktop / Claude Code)
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { saveApiKey, saveSupabaseUrl, deleteApiKey } from './credentials.js';
import { CLOUD_SUPABASE_URL } from '../lib/supabase.js';

// ── Helpers ──────────────────────────────────────────────────────────

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const verifierBytes = randomBytes(32);
  const codeVerifier = base64url(verifierBytes);
  const challengeHash = createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = base64url(challengeHash);
  return { codeVerifier, codeChallenge };
}

export function getAppBaseUrl(): string {
  return process.env.SOCIALNEURON_APP_URL || 'https://app.socialneuron.com';
}

function getDefaultSupabaseUrl(): string {
  return process.env.SOCIALNEURON_SUPABASE_URL || process.env.SUPABASE_URL || CLOUD_SUPABASE_URL;
}

// ── MCP Client Config ────────────────────────────────────────────────

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function getConfigPaths(): { path: string; name: string }[] {
  const paths: { path: string; name: string }[] = [];
  const os = platform();

  // Claude Desktop
  if (os === 'darwin') {
    paths.push({
      path: join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      ),
      name: 'Claude Desktop',
    });
  } else if (os === 'linux') {
    paths.push({
      path: join(homedir(), '.config', 'claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop',
    });
  }

  // Claude Code global
  const claudeCodeGlobal = join(homedir(), '.claude', '.mcp.json');
  if (existsSync(claudeCodeGlobal)) {
    paths.push({ path: claudeCodeGlobal, name: 'Claude Code (global)' });
  }

  // Project-level (current working directory)
  const projectConfig = join(process.cwd(), '.mcp.json');
  if (existsSync(projectConfig)) {
    paths.push({ path: projectConfig, name: 'Claude Code (project)' });
  }

  return paths;
}

function configureMcpClient(configPath: string): boolean {
  try {
    let config: McpConfig = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as McpConfig;
    } else {
      // Create parent directory if needed
      const dir = join(configPath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers['socialneuron'] = {
      command: 'npx',
      args: ['-y', '@socialneuron/mcp-server'],
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

// ── HTTP Callback Server ─────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── PKCE Exchange ────────────────────────────────────────────────────

async function completePkceExchange(codeVerifier: string, state: string): Promise<boolean> {
  const supabaseUrl = getDefaultSupabaseUrl();

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=exchange-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code_verifier: codeVerifier, state }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`  PKCE exchange failed: ${text}`);
      return false;
    }

    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error(`  PKCE exchange error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Main Setup Flow ──────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  console.error('');
  console.error('  Social Neuron MCP Server Setup');
  console.error('  ==============================');
  console.error('');

  // Privacy notice (first-run)
  console.error('  Privacy Notice:');
  console.error('  - Your API key is stored locally in your OS keychain');
  console.error('  - Tool invocations are logged for usage metering (no content stored)');
  console.error('  - Set DO_NOT_TRACK=1 to disable telemetry');
  console.error('  - Data export/delete: https://app.socialneuron.com/settings');
  console.error('');

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomUUID();

  // Start local HTTP server on ephemeral port (loopback only)
  const { server, port } = await new Promise<{
    server: ReturnType<typeof createServer>;
    port: number;
  }>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({ server: srv, port: addr.port });
    });
    srv.on('error', reject);
  });

  // Build authorize URL
  const baseUrl = getAppBaseUrl();
  const authorizeUrl = new URL('/mcp/authorize', baseUrl);
  authorizeUrl.searchParams.set('callback_port', String(port));
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);

  // Open browser
  try {
    const open = (await import('open')).default;
    await open(authorizeUrl.toString());
    console.error('  Opening browser for authorization...');
    console.error(`  URL: ${authorizeUrl.toString()}`);
    console.error('');
    console.error('  Waiting for authorization (timeout: 120s)...');
  } catch {
    console.error('  Could not open browser automatically.');
    console.error('  Please open the following URL manually:');
    console.error('');
    console.error(`  ${authorizeUrl.toString()}`);
    console.error('');
    console.error('  Waiting for authorization (timeout: 120s)...');
  }

  // Wait for callback
  const result = await new Promise<{ apiKey: string } | { error: string }>(resolve => {
    const timeout = setTimeout(() => {
      server.close();
      resolve({ error: 'Authorization timed out after 120 seconds.' });
    }, 120_000);

    server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers for the browser POST
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/callback') {
        try {
          const body = await readBody(req);
          const data = JSON.parse(body) as { api_key?: string; state?: string };

          if (data.state !== state) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'State mismatch' }));
            return;
          }

          if (!data.api_key) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing api_key' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));

          clearTimeout(timeout);
          server.close();
          resolve({ apiKey: data.api_key });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
  });

  if ('error' in result) {
    console.error('');
    console.error(`  Error: ${result.error}`);
    console.error('  Run "npx @socialneuron/mcp-server setup" to try again.');
    process.exit(1);
  }

  // Complete PKCE exchange to activate the key
  console.error('');
  console.error('  Completing PKCE verification...');
  const exchangeSuccess = await completePkceExchange(codeVerifier, state);

  if (!exchangeSuccess) {
    console.error('  Warning: PKCE exchange failed. Key may not be activated.');
    console.error('  The key will still work if the server was in legacy mode.');
  } else {
    console.error('  PKCE verification complete.');
  }

  // Store credentials
  const apiKey = result.apiKey;
  await saveApiKey(apiKey);

  const supabaseUrl = getDefaultSupabaseUrl();
  await saveSupabaseUrl(supabaseUrl);

  console.error('');
  console.error('  API key stored securely.');
  console.error(`  Key prefix: ${apiKey.substring(0, 12)}...`);

  // Auto-configure MCP clients
  const configPaths = getConfigPaths();
  let configured = false;
  for (const { path, name } of configPaths) {
    if (configureMcpClient(path)) {
      console.error(`  Configured ${name}: ${path}`);
      configured = true;
    }
  }

  if (!configured) {
    console.error('');
    console.error('  No MCP client config found. Add this to your MCP config manually:');
    console.error('');
    console.error('    "socialneuron": {');
    console.error('      "command": "npx",');
    console.error('      "args": ["-y", "@socialneuron/mcp-server"]');
    console.error('    }');
  }

  console.error('');
  console.error('  Setup complete!');
  console.error('');
}

/**
 * Remove stored credentials and log out.
 */
export async function runLogout(): Promise<void> {
  await deleteApiKey();
  console.error('');
  console.error('  Logged out. API key removed.');
  console.error('');
}
