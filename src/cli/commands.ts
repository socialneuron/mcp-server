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
import { runSetup, getAppBaseUrl } from './setup.js';
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

  // Request a device code
  const response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    console.error(`  Error: Failed to create device code (HTTP ${response.status}).`);
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

  // Poll for authorization.
  //
  // TTL fix (PR #B): The server TTL starts at row-creation time (before this
  // function runs). Network latency on the device-code request plus any delay
  // before the first poll means the CLI's effective window is slightly shorter
  // than the server's. We add a 30-second grace period so the CLI keeps polling
  // past its nominal deadline, ensuring the final "did it just get authorized?"
  // poll still fires even if the browser confirmed at the last second.
  //
  // Loop structure: sleep FIRST, then check deadline, then poll.  This prevents
  // the previous bug where the loop exited after the last sleep without ever
  // making the poll that would have captured the 200.
  const pollInterval = (data.interval || 5) * 1000;
  const GRACE_MS = 30_000; // 30s extra beyond server-reported expires_in
  const deadline = Date.now() + data.expires_in * 1000 + GRACE_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    // Check deadline AFTER the sleep so the last poll always fires.
    if (Date.now() > deadline) {
      break;
    }

    let pollResponse;
    try {
      pollResponse = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=device-poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: data.device_code }),
      });
    } catch {
      // Network error — keep trying until deadline
      continue;
    }

    if (pollResponse.status === 200) {
      const pollData = (await pollResponse.json()) as { api_key?: string };
      if (pollData.api_key) {
        // Key received — save is critical, but never print the bearer token to logs.
        try {
          await saveApiKey(pollData.api_key);
        } catch (saveErr) {
          console.error('');
          console.error('  Warning: Could not save API key securely.');
          console.error(`  Error: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
          console.error('');
          console.error('  For security, the API key was not printed to the terminal.');
          console.error('  Create or copy an API key from your Social Neuron dashboard, then run:');
          console.error('  npx @socialneuron/mcp-server login --paste');
          console.error('');
          return;
        }

        try {
          await saveSupabaseUrl(supabaseUrl);
        } catch (saveErr) {
          console.error('');
          console.error('  Authorized!');
          console.error(`  Key prefix: ${pollData.api_key.substring(0, 12)}...`);
          console.error('');
          console.error('  Warning: API key saved, but could not save the Supabase URL.');
          console.error(`  Error: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
          console.error('  If needed, set SOCIALNEURON_SUPABASE_URL to your Supabase URL.');
          console.error('');
          return;
        }

        console.error('');
        console.error('  Authorized!');
        console.error(`  Key prefix: ${pollData.api_key.substring(0, 12)}...`);
        console.error('');
        return;
      }
    }

    if (pollResponse.status === 410) {
      // Check whether the browser DID confirm but the poll arrived too late.
      const expiredData = (await pollResponse.json().catch(() => ({}))) as {
        error?: string;
        authorized?: boolean;
        dashboard_url?: string;
        hint?: string;
      };

      if (expiredData.authorized) {
        // Race: key was minted on the server but the row aged out before delivery.
        const dashUrl =
          expiredData.dashboard_url || 'https://www.socialneuron.com/settings?tab=api-keys';
        console.error('');
        console.error('  Your browser confirmed the code and a key WAS issued on the server,');
        console.error('  but the CLI polled after the 15-minute server TTL elapsed.');
        console.error('');
        console.error('  To recover your key:');
        console.error(`  1. Open: ${dashUrl}`);
        console.error('  2. Copy the key named "Device Auth (…)"');
        console.error('  3. Run: npx @socialneuron/mcp-server login --paste');
        console.error('');
        process.exit(1);
      }

      console.error('');
      console.error('  Error: Device code expired. Please try again.');
      process.exit(1);
    }

    // 428 = authorization_pending or slow_down — keep polling
  }

  console.error('');
  console.error('  Error: Authorization timed out. Please try again.');
  process.exit(1);
}

// ── Logout ───────────────────────────────────────────────────────────

export async function runLogoutCommand(options?: { json?: boolean }): Promise<void> {
  const asJson = options?.json ?? false;

  if (!asJson) {
    console.error('');
    console.error('  Social Neuron - Logout');
    console.error('  ======================');
    console.error('');
  }

  const apiKey = await loadApiKey();

  if (apiKey) {
    // Try to revoke the key server-side
    try {
      const validation = await validateApiKey(apiKey);
      if (validation.valid && !asJson) {
        console.error('  Key removed from this device.');
        console.error(
          '  Note: To revoke the key server-side, visit https://www.socialneuron.com/settings/developer'
        );
      }
    } catch {
      // Non-fatal — local deletion is what matters
    }
  }

  await deleteApiKey();

  // Clear validation cache on logout so stale auth doesn't persist
  const { clearValidationCache } = await import('../lib/validation-cache.js');
  clearValidationCache();

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ ok: true, message: 'Credentials removed', schema_version: '1' }, null, 2) +
        '\n'
    );
  } else {
    console.error('  Credentials removed from keychain.');
    console.error('');
  }
}

// ── Whoami ───────────────────────────────────────────────────────────

export async function runWhoami(options?: { json?: boolean }): Promise<void> {
  const asJson = options?.json ?? false;

  const apiKey = await loadApiKey();

  if (!apiKey) {
    if (asJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: 'Not logged in', schema_version: '1' }, null, 2) + '\n'
      );
    } else {
      console.error('');
      console.error('  Not logged in.');
      console.error('  Run: npx @socialneuron/mcp-server login');
      console.error('');
    }
    process.exit(1);
  }

  if (!asJson) {
    console.error('');
    console.error('  Social Neuron - Current Identity');
    console.error('  ================================');
    console.error('');
    console.error('  Validating key...');
  }

  const result = await validateApiKey(apiKey);

  if (!result.valid) {
    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          { ok: false, error: result.error || 'Key invalid or expired', schema_version: '1' },
          null,
          2
        ) + '\n'
      );
    } else {
      console.error('  Key is invalid or expired.');
      console.error(`  Error: ${result.error || 'Unknown'}`);
      console.error('  Run: npx @socialneuron/mcp-server login');
      console.error('');
    }
    process.exit(1);
  }

  if (asJson) {
    const payload: Record<string, unknown> = {
      ok: true,
      email: result.email || null,
      userId: result.userId,
      keyPrefix: apiKey.substring(0, 12) + '...',
      scopes: result.scopes || ['mcp:full'],
      schema_version: '1',
    };
    if (result.expiresAt) payload.expiresAt = result.expiresAt;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
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
}

// ── Health Check ─────────────────────────────────────────────────

export async function runHealthCheck(options?: { json?: boolean }): Promise<void> {
  const asJson = options?.json ?? false;

  if (!asJson) {
    console.error('');
    console.error('  Social Neuron — Health Check');
    console.error('  ============================');
    console.error('');
  }

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
        detail: 'Failed to reach the authentication service.',
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
      detail: 'Network request failed.',
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

  if (asJson) {
    const checksObj: Record<string, { status: string; detail: string }> = {};
    for (const check of checks) {
      checksObj[check.name.toLowerCase().replace(/\s+/g, '_')] = {
        status: check.ok ? 'pass' : 'fail',
        detail: check.detail,
      };
    }
    process.stdout.write(
      JSON.stringify({ ok: allOk, checks: checksObj, schema_version: '1' }, null, 2) + '\n'
    );
  } else {
    for (const check of checks) {
      const icon = check.ok ? '\u2713' : '\u2717';
      console.error(`  ${icon} ${check.name}: ${check.detail}`);
    }

    console.error('');
    console.error(`  Overall: ${allOk ? 'All checks passed' : 'Some checks failed'}`);
    console.error('');
  }

  if (!allOk) {
    process.exit(1);
  }
}
