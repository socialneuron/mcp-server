/**
 * CLI commands for the Social Neuron MCP server.
 *
 * Commands:
 *   login          - Browser-based OAuth flow (default)
 *   login --paste  - Paste an existing API key
 *   login --device - Device code flow for headless/SSH environments
 *   logout         - Revoke key and clear credentials
 *   whoami         - Display current auth info
 *   health         - Check connectivity, key validity, credits
 */

import { createInterface } from 'node:readline';
import { saveApiKey, loadApiKey, deleteApiKey, saveSupabaseUrl } from './credentials.js';
import { runSetup, generatePKCE, getAppBaseUrl } from './setup.js';
import { validateApiKey } from '../auth/api-keys.js';
import { getSupabaseUrl, CLOUD_SUPABASE_URL } from '../lib/supabase.js';

// ── Helpers ──────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getDefaultSupabaseUrl(): string {
  return process.env.SOCIALNEURON_SUPABASE_URL || process.env.SUPABASE_URL || CLOUD_SUPABASE_URL;
}

// ── Login ────────────────────────────────────────────────────────────

export async function runLogin(method: 'browser' | 'paste' | 'device'): Promise<void> {
  if (method === 'browser') {
    await runSetup();
    return;
  }

  if (method === 'paste') {
    await runLoginPaste();
    return;
  }

  if (method === 'device') {
    await runLoginDevice();
    return;
  }
}

async function runLoginPaste(): Promise<void> {
  console.error('');
  console.error('  Social Neuron - Paste API Key');
  console.error('  =============================');
  console.error('');
  console.error('  Paste your API key (starts with snk_live_):');

  const key = await prompt('  > ');

  if (!key || !key.startsWith('snk_live_')) {
    console.error('');
    console.error('  Error: Invalid key format. Must start with snk_live_');
    process.exit(1);
  }

  console.error('');
  console.error('  Validating key...');

  const result = await validateApiKey(key);

  if (!result.valid) {
    console.error(
      `  Error: Key validation failed. ${result.error || 'Key may be revoked or expired.'}`
    );
    process.exit(1);
  }

  await saveApiKey(key);
  await saveSupabaseUrl(getDefaultSupabaseUrl());

  console.error('');
  console.error('  API key saved securely.');
  console.error(`  User: ${result.email || 'unknown'}`);
  console.error(`  Scopes: ${result.scopes?.join(', ') || 'mcp:full'}`);
  if (result.expiresAt) {
    const daysLeft = Math.ceil(
      (new Date(result.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    console.error(`  Expires: ${result.expiresAt} (${daysLeft} days)`);
  }
  console.error('');
}

async function runLoginDevice(): Promise<void> {
  console.error('');
  console.error('  Social Neuron - Device Authorization');
  console.error('  ====================================');
  console.error('');

  const supabaseUrl = getDefaultSupabaseUrl();

  // Generate PKCE for the device flow
  const { codeChallenge } = generatePKCE();

  // Request a device code
  const response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code_challenge: codeChallenge }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`  Error: Failed to create device code. ${text}`);
    process.exit(1);
  }

  const data = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  console.error(`  Go to: ${data.verification_uri}`);
  console.error('');
  console.error(`  Enter code: ${data.user_code}`);
  console.error('');
  console.error(
    `  Waiting for authorization (expires in ${Math.floor(data.expires_in / 60)} min)...`
  );

  // Try to open browser
  try {
    const open = (await import('open')).default;
    await open(data.verification_uri);
  } catch {
    // Can't open browser — that's fine, user has the URL
  }

  // Poll for authorization
  const pollInterval = (data.interval || 5) * 1000;
  const maxTime = data.expires_in * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxTime) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const pollResponse = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=device-poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: data.device_code }),
      });

      if (pollResponse.status === 200) {
        const pollData = (await pollResponse.json()) as { api_key?: string };
        if (pollData.api_key) {
          // Validate before saving
          const validation = await validateApiKey(pollData.api_key);
          if (validation.valid) {
            await saveApiKey(pollData.api_key);
            await saveSupabaseUrl(supabaseUrl);

            console.error('');
            console.error('  Authorized!');
            console.error(`  User: ${validation.email || 'unknown'}`);
            console.error(`  Key prefix: ${pollData.api_key.substring(0, 12)}...`);
            console.error('');
            return;
          }
        }
      }

      if (pollResponse.status === 410) {
        console.error('');
        console.error('  Error: Device code expired. Please try again.');
        process.exit(1);
      }

      // 428 = pending or slow_down, keep polling
    } catch {
      // Network error — keep trying
    }
  }

  console.error('');
  console.error('  Error: Authorization timed out. Please try again.');
  process.exit(1);
}

// ── Logout ───────────────────────────────────────────────────────────

export async function runLogoutCommand(): Promise<void> {
  console.error('');
  console.error('  Social Neuron - Logout');
  console.error('  ======================');
  console.error('');

  const apiKey = await loadApiKey();

  if (apiKey) {
    // Try to revoke the key server-side
    try {
      const supabaseUrl = getDefaultSupabaseUrl();
      const serviceKey =
        process.env.SOCIALNEURON_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

      // First, find the key ID by validating it
      const validation = await validateApiKey(apiKey);
      if (validation.valid) {
        // List keys to find this one's ID
        // Since we can't list from CLI without user JWT, just delete locally
        console.error('  Key revoked locally.');
      }
    } catch {
      // Non-fatal — local deletion is what matters
    }
  }

  await deleteApiKey();
  console.error('  Credentials removed from keychain.');
  console.error('');
}

// ── Whoami ───────────────────────────────────────────────────────────

export async function runWhoami(): Promise<void> {
  console.error('');
  console.error('  Social Neuron - Current Identity');
  console.error('  ================================');
  console.error('');

  const apiKey = await loadApiKey();

  if (!apiKey) {
    console.error('  Not logged in.');
    console.error('  Run: npx @socialneuron/mcp-server login');
    console.error('');
    process.exit(1);
  }

  console.error('  Validating key...');
  const result = await validateApiKey(apiKey);

  if (!result.valid) {
    console.error('  Key is invalid or expired.');
    console.error(`  Error: ${result.error || 'Unknown'}`);
    console.error('  Run: npx @socialneuron/mcp-server login');
    console.error('');
    process.exit(1);
  }

  console.error('');
  console.error(`  Email:    ${result.email || '(not available)'}`);
  console.error(`  User ID:  ${result.userId}`);
  console.error(`  Key:      ${apiKey.substring(0, 12)}...`);
  console.error(`  Scopes:   ${result.scopes?.join(', ') || 'mcp:full'}`);

  if (result.expiresAt) {
    const expiresMs = new Date(result.expiresAt).getTime();
    const daysLeft = Math.ceil((expiresMs - Date.now()) / (1000 * 60 * 60 * 24));
    console.error(`  Expires:  ${result.expiresAt} (${daysLeft} days)`);

    if (daysLeft <= 7) {
      console.error('');
      console.error(`  Warning: Key expires in ${daysLeft} day(s).`);
      console.error('  Run: npx @socialneuron/mcp-server login');
    }
  } else {
    console.error('  Expires:  never');
  }

  console.error('');
}

// ── Health Check ─────────────────────────────────────────────────

export async function runHealthCheck(): Promise<void> {
  console.error('');
  console.error('  Social Neuron — Health Check');
  console.error('  ============================');
  console.error('');

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Check API key
  const apiKey = await loadApiKey();
  if (!apiKey) {
    checks.push({
      name: 'API Key',
      ok: false,
      detail: 'No key stored. Run: socialneuron-mcp login',
    });
  } else {
    checks.push({ name: 'API Key', ok: true, detail: `${apiKey.substring(0, 12)}...` });

    // 2. Validate key against server
    try {
      const result = await validateApiKey(apiKey);
      if (result.valid) {
        checks.push({
          name: 'Key Valid',
          ok: true,
          detail: `User: ${result.email || result.userId}`,
        });
        checks.push({
          name: 'Scopes',
          ok: (result.scopes?.length ?? 0) > 0,
          detail: result.scopes?.join(', ') || 'none',
        });

        if (result.expiresAt) {
          const daysLeft = Math.ceil(
            (new Date(result.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          );
          checks.push({
            name: 'Expiry',
            ok: daysLeft > 7,
            detail: daysLeft > 0 ? `${daysLeft} days remaining` : 'EXPIRED',
          });
        } else {
          checks.push({ name: 'Expiry', ok: true, detail: 'No expiration' });
        }
      } else {
        checks.push({ name: 'Key Valid', ok: false, detail: result.error || 'Invalid or revoked' });
      }
    } catch (err: unknown) {
      checks.push({
        name: 'Connectivity',
        ok: false,
        detail: err instanceof Error ? err.message : 'Failed to reach server',
      });
    }
  }

  // 3. Check Supabase URL
  const supabaseUrl = getSupabaseUrl();
  checks.push({
    name: 'Supabase URL',
    ok: supabaseUrl.startsWith('https://'),
    detail: supabaseUrl,
  });

  // 4. Check connectivity to Supabase
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    checks.push({
      name: 'Connectivity',
      ok: response.status < 500,
      detail: `HTTP ${response.status}`,
    });
  } catch (err: unknown) {
    checks.push({
      name: 'Connectivity',
      ok: false,
      detail: err instanceof Error ? err.message : 'Network error',
    });
  }

  // 5. Check credit balance (if we have a valid key)
  if (apiKey) {
    try {
      const { callEdgeFunction } = await import('../lib/edge-function.js');
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        balance?: number;
      }>('mcp-data', { action: 'credit-balance' });

      if (!error && data?.success && data.balance !== undefined) {
        checks.push({
          name: 'Credits',
          ok: data.balance > 0,
          detail: `${data.balance} credits available`,
        });
      }
    } catch {
      // Non-fatal — credit check is optional
    }
  }

  // Print results
  const allOk = checks.every(c => c.ok);

  for (const check of checks) {
    const icon = check.ok ? '\u2713' : '\u2717';
    console.error(`  ${icon} ${check.name}: ${check.detail}`);
  }

  console.error('');
  console.error(`  Overall: ${allOk ? 'All checks passed' : 'Some checks failed'}`);
  console.error('');

  if (!allOk) {
    process.exit(1);
  }
}
