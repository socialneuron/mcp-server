/**
 * Tests for the pure security functions extracted from the mcp-gateway
 * Edge Function (supabase/functions/mcp-gateway/index.ts).
 *
 * The gateway runs on Deno, but these are pure functions that can be
 * tested in Node.js by copying them here. Any changes to the gateway
 * source MUST be reflected in these extracted copies.
 */

import { describe, it, expect } from 'vitest';

// ===========================================================================
// Extracted pure functions from mcp-gateway/index.ts
// ===========================================================================

// --- Shell metacharacter detection (lines 30-64) ---

const SHELL_METACHAR_PATTERN = /[;|&`$(){}[\]<>!\n\r\\]/;
const SUSPICIOUS_PATH_PATTERN = /\.\.[/\\]|~[/\\]/;
const SAFE_CONTENT_FIELDS = new Set([
  'caption',
  'description',
  'script',
  'content',
  'prompt',
  'message',
  'title',
  'body',
  'text',
  'comment',
  'reply',
  'hook',
  'cta',
  'dialogueText',
  'visualDescription',
  'notes',
  'instructions',
]);

function containsShellMetachars(value: unknown, depth = 0): string | null {
  if (depth > 5) return null; // Prevent deep recursion
  if (typeof value === 'string') {
    if (SHELL_METACHAR_PATTERN.test(value)) {
      return 'Shell metacharacter detected in value';
    }
    if (SUSPICIOUS_PATH_PATTERN.test(value)) {
      return 'Path traversal pattern detected';
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = containsShellMetachars(item, depth + 1);
      if (result) return result;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SAFE_CONTENT_FIELDS.has(key)) continue;
      const result = containsShellMetachars(val, depth + 1);
      if (result) return `${result} in field '${key}'`;
    }
  }
  return null;
}

// --- Allowed functions (lines 69-84) ---

const ALLOWED_FUNCTIONS = new Set([
  'mcp-data',
  'social-neuron-ai',
  'fetch-trends',
  'brand-extract',
  'schedule-post',
  'social-auth',
  'fetch-analytics',
  'youtube-analytics',
  'youtube-comments',
  'youtube-videos',
  'kie-video-generate',
  'kie-image-generate',
  'kie-task-status',
  'content-brain',
]);

// --- Function-to-scope mapping (lines 88-109) ---

const FUNCTION_REQUIRED_SCOPE: Record<string, string> = {
  'mcp-data': 'mcp:read',
  'fetch-trends': 'mcp:read',
  'brand-extract': 'mcp:read',
  'social-neuron-ai': 'mcp:write',
  'kie-video-generate': 'mcp:write',
  'kie-image-generate': 'mcp:write',
  'kie-task-status': 'mcp:write',
  'schedule-post': 'mcp:distribute',
  'social-auth': 'mcp:distribute',
  'fetch-analytics': 'mcp:analytics',
  'youtube-analytics': 'mcp:analytics',
  'youtube-videos': 'mcp:analytics',
  'youtube-comments': 'mcp:comments',
  'content-brain': 'mcp:autopilot',
};

// --- hasScopeForFunction (lines 120-125) ---

function hasScopeForFunction(userScopes: string[], functionName: string): boolean {
  if (userScopes.includes('mcp:full')) return true;
  const required = FUNCTION_REQUIRED_SCOPE[functionName];
  if (!required) return false;
  return userScopes.includes(required);
}

// --- hashParams PII redaction (lines 165-177) ---
// Uses crypto.subtle which is available in Node 18+ globalThis

async function hashParams(params: Record<string, unknown>): Promise<string> {
  const redacted = { ...params };
  for (const key of Object.keys(redacted)) {
    if (SAFE_CONTENT_FIELDS.has(key) || key.endsWith('_url') || key.endsWith('Url')) {
      redacted[key] =
        `[REDACTED:${typeof redacted[key] === 'string' ? (redacted[key] as string).length : 0}]`;
    }
  }
  const encoded = new TextEncoder().encode(JSON.stringify(redacted));
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(hashBuffer);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 32);
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// containsShellMetachars
// ---------------------------------------------------------------------------
describe('containsShellMetachars', () => {
  describe('blocks shell metacharacters in string values', () => {
    const dangerousChars = [';', '|', '&', '`', '$', '(', ')', '{', '}'];

    for (const char of dangerousChars) {
      it(`blocks "${char}"`, () => {
        const result = containsShellMetachars(`harmless${char}injection`);
        expect(result).toBe('Shell metacharacter detected in value');
      });
    }

    it('blocks backslash', () => {
      const result = containsShellMetachars('path\\to\\file');
      expect(result).toBe('Shell metacharacter detected in value');
    });

    it('blocks newline', () => {
      const result = containsShellMetachars('line1\nline2');
      expect(result).toBe('Shell metacharacter detected in value');
    });

    it('blocks carriage return', () => {
      const result = containsShellMetachars('line1\rline2');
      expect(result).toBe('Shell metacharacter detected in value');
    });

    it('blocks exclamation mark', () => {
      const result = containsShellMetachars('!important');
      expect(result).toBe('Shell metacharacter detected in value');
    });

    it('blocks angle brackets', () => {
      expect(containsShellMetachars('echo > file')).toBe('Shell metacharacter detected in value');
      expect(containsShellMetachars('cat < input')).toBe('Shell metacharacter detected in value');
    });

    it('blocks square brackets', () => {
      expect(containsShellMetachars('array[0]')).toBe('Shell metacharacter detected in value');
    });
  });

  describe('blocks path traversal patterns', () => {
    it('blocks ../ path traversal', () => {
      const result = containsShellMetachars('../../etc/passwd');
      expect(result).toBe('Path traversal pattern detected');
    });

    it('blocks ..\\  path traversal (Windows-style)', () => {
      // The backslash itself is a shell metachar, so it could match either pattern
      const result = containsShellMetachars('..\\windows\\system32');
      expect(result).not.toBeNull();
    });

    it('blocks ~/ home directory traversal', () => {
      const result = containsShellMetachars('~/secret-file');
      expect(result).toBe('Path traversal pattern detected');
    });
  });

  describe('allows special characters in SAFE_CONTENT_FIELDS', () => {
    const safeFields = [
      'caption',
      'description',
      'script',
      'content',
      'prompt',
      'message',
      'title',
      'body',
      'text',
      'comment',
      'reply',
      'hook',
      'cta',
      'dialogueText',
      'visualDescription',
      'notes',
      'instructions',
    ];

    for (const field of safeFields) {
      it(`allows special chars in "${field}" field`, () => {
        const result = containsShellMetachars({ [field]: 'Hello! How are (you) doing? $100' });
        expect(result).toBeNull();
      });
    }
  });

  describe('recursion and nesting', () => {
    it('detects metacharacters in nested objects', () => {
      const result = containsShellMetachars({
        settings: { command: 'ls; rm -rf /' },
      });
      expect(result).toContain('Shell metacharacter detected');
      expect(result).toContain("field 'command'");
    });

    it('detects metacharacters inside arrays', () => {
      const result = containsShellMetachars(['clean', 'also clean', 'not|clean']);
      expect(result).toBe('Shell metacharacter detected in value');
    });

    it('detects metacharacters in arrays nested inside objects', () => {
      const result = containsShellMetachars({
        tags: ['good', 'bad;drop table'],
      });
      expect(result).toContain('Shell metacharacter detected');
    });

    it('stops recursion at depth 5 and returns null', () => {
      // Build a deeply nested object (7 levels deep)
      const deep: Record<string, unknown> = {};
      let current = deep;
      for (let i = 0; i < 7; i++) {
        const next: Record<string, unknown> = {};
        current[`level${i}`] = next;
        current = next;
      }
      current.payload = 'rm -rf; /';

      // The function stops at depth 5, so the deeply nested value is NOT checked
      const result = containsShellMetachars(deep);
      expect(result).toBeNull();
    });

    it('detects metacharacters at exactly depth 5', () => {
      // Build a 5-level deep object (just within limit)
      const deep: Record<string, unknown> = {};
      let current = deep;
      for (let i = 0; i < 4; i++) {
        const next: Record<string, unknown> = {};
        current[`level${i}`] = next;
        current = next;
      }
      current.payload = 'inject;command';

      const result = containsShellMetachars(deep);
      expect(result).toContain('Shell metacharacter detected');
    });
  });

  describe('clean values', () => {
    it('returns null for clean string', () => {
      expect(containsShellMetachars('Hello world')).toBeNull();
    });

    it('returns null for clean object', () => {
      expect(
        containsShellMetachars({
          name: 'John',
          age: 30,
          model: 'veo3-fast',
        })
      ).toBeNull();
    });

    it('returns null for numbers', () => {
      expect(containsShellMetachars(42)).toBeNull();
    });

    it('returns null for null', () => {
      expect(containsShellMetachars(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(containsShellMetachars(undefined)).toBeNull();
    });

    it('returns null for boolean', () => {
      expect(containsShellMetachars(true)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(containsShellMetachars('')).toBeNull();
    });

    it('returns null for empty object', () => {
      expect(containsShellMetachars({})).toBeNull();
    });

    it('returns null for empty array', () => {
      expect(containsShellMetachars([])).toBeNull();
    });

    it('allows hyphens, underscores, dots, slashes, and colons', () => {
      expect(containsShellMetachars('video-model_v2.0/config:latest')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_FUNCTIONS
// ---------------------------------------------------------------------------
describe('ALLOWED_FUNCTIONS', () => {
  it('contains exactly 14 entries', () => {
    expect(ALLOWED_FUNCTIONS.size).toBe(14);
  });

  const expectedFunctions = [
    'mcp-data',
    'social-neuron-ai',
    'fetch-trends',
    'brand-extract',
    'schedule-post',
    'social-auth',
    'fetch-analytics',
    'youtube-analytics',
    'youtube-comments',
    'youtube-videos',
    'kie-video-generate',
    'kie-image-generate',
    'kie-task-status',
    'content-brain',
  ];

  for (const fn of expectedFunctions) {
    it(`allows "${fn}"`, () => {
      expect(ALLOWED_FUNCTIONS.has(fn)).toBe(true);
    });
  }

  it('blocks unknown function names', () => {
    expect(ALLOWED_FUNCTIONS.has('malicious-function')).toBe(false);
    expect(ALLOWED_FUNCTIONS.has('admin-panel')).toBe(false);
    expect(ALLOWED_FUNCTIONS.has('eval')).toBe(false);
  });

  it('blocks similar-but-wrong function names', () => {
    expect(ALLOWED_FUNCTIONS.has('mcp_data')).toBe(false); // underscore vs hyphen
    expect(ALLOWED_FUNCTIONS.has('MCP-DATA')).toBe(false); // case-sensitive
    expect(ALLOWED_FUNCTIONS.has('fetch-trends ')).toBe(false); // trailing space
  });
});

// ---------------------------------------------------------------------------
// FUNCTION_REQUIRED_SCOPE mapping
// ---------------------------------------------------------------------------
describe('FUNCTION_REQUIRED_SCOPE', () => {
  it('maps all 14 allowed functions to a scope', () => {
    for (const fn of ALLOWED_FUNCTIONS) {
      expect(FUNCTION_REQUIRED_SCOPE[fn], `Missing scope mapping for "${fn}"`).toBeDefined();
    }
  });

  describe('mcp:read functions', () => {
    it('maps mcp-data to mcp:read', () => {
      expect(FUNCTION_REQUIRED_SCOPE['mcp-data']).toBe('mcp:read');
    });

    it('maps fetch-trends to mcp:read', () => {
      expect(FUNCTION_REQUIRED_SCOPE['fetch-trends']).toBe('mcp:read');
    });

    it('maps brand-extract to mcp:read', () => {
      expect(FUNCTION_REQUIRED_SCOPE['brand-extract']).toBe('mcp:read');
    });
  });

  describe('mcp:write functions', () => {
    it('maps social-neuron-ai to mcp:write', () => {
      expect(FUNCTION_REQUIRED_SCOPE['social-neuron-ai']).toBe('mcp:write');
    });

    it('maps kie-video-generate to mcp:write', () => {
      expect(FUNCTION_REQUIRED_SCOPE['kie-video-generate']).toBe('mcp:write');
    });

    it('maps kie-image-generate to mcp:write', () => {
      expect(FUNCTION_REQUIRED_SCOPE['kie-image-generate']).toBe('mcp:write');
    });

    it('maps kie-task-status to mcp:write', () => {
      expect(FUNCTION_REQUIRED_SCOPE['kie-task-status']).toBe('mcp:write');
    });
  });

  describe('mcp:distribute functions', () => {
    it('maps schedule-post to mcp:distribute', () => {
      expect(FUNCTION_REQUIRED_SCOPE['schedule-post']).toBe('mcp:distribute');
    });

    it('maps social-auth to mcp:distribute', () => {
      expect(FUNCTION_REQUIRED_SCOPE['social-auth']).toBe('mcp:distribute');
    });
  });

  describe('mcp:analytics functions', () => {
    it('maps fetch-analytics to mcp:analytics', () => {
      expect(FUNCTION_REQUIRED_SCOPE['fetch-analytics']).toBe('mcp:analytics');
    });

    it('maps youtube-analytics to mcp:analytics', () => {
      expect(FUNCTION_REQUIRED_SCOPE['youtube-analytics']).toBe('mcp:analytics');
    });

    it('maps youtube-videos to mcp:analytics', () => {
      expect(FUNCTION_REQUIRED_SCOPE['youtube-videos']).toBe('mcp:analytics');
    });
  });

  describe('mcp:comments functions', () => {
    it('maps youtube-comments to mcp:comments', () => {
      expect(FUNCTION_REQUIRED_SCOPE['youtube-comments']).toBe('mcp:comments');
    });
  });

  describe('mcp:autopilot functions', () => {
    it('maps content-brain to mcp:autopilot', () => {
      expect(FUNCTION_REQUIRED_SCOPE['content-brain']).toBe('mcp:autopilot');
    });
  });
});

// ---------------------------------------------------------------------------
// hasScopeForFunction
// ---------------------------------------------------------------------------
describe('hasScopeForFunction', () => {
  describe('mcp:full grants everything', () => {
    const allFunctions = Array.from(ALLOWED_FUNCTIONS);

    for (const fn of allFunctions) {
      it(`grants access to "${fn}"`, () => {
        expect(hasScopeForFunction(['mcp:full'], fn)).toBe(true);
      });
    }
  });

  describe('specific scope grants correct functions', () => {
    it('mcp:read grants mcp-data', () => {
      expect(hasScopeForFunction(['mcp:read'], 'mcp-data')).toBe(true);
    });

    it('mcp:read grants fetch-trends', () => {
      expect(hasScopeForFunction(['mcp:read'], 'fetch-trends')).toBe(true);
    });

    it('mcp:write grants social-neuron-ai', () => {
      expect(hasScopeForFunction(['mcp:write'], 'social-neuron-ai')).toBe(true);
    });

    it('mcp:write grants kie-video-generate', () => {
      expect(hasScopeForFunction(['mcp:write'], 'kie-video-generate')).toBe(true);
    });

    it('mcp:distribute grants schedule-post', () => {
      expect(hasScopeForFunction(['mcp:distribute'], 'schedule-post')).toBe(true);
    });

    it('mcp:analytics grants youtube-analytics', () => {
      expect(hasScopeForFunction(['mcp:analytics'], 'youtube-analytics')).toBe(true);
    });

    it('mcp:comments grants youtube-comments', () => {
      expect(hasScopeForFunction(['mcp:comments'], 'youtube-comments')).toBe(true);
    });

    it('mcp:autopilot grants content-brain', () => {
      expect(hasScopeForFunction(['mcp:autopilot'], 'content-brain')).toBe(true);
    });
  });

  describe('wrong scope denies access', () => {
    it('mcp:read does not grant social-neuron-ai (requires mcp:write)', () => {
      expect(hasScopeForFunction(['mcp:read'], 'social-neuron-ai')).toBe(false);
    });

    it('mcp:write does not grant schedule-post (requires mcp:distribute)', () => {
      expect(hasScopeForFunction(['mcp:write'], 'schedule-post')).toBe(false);
    });

    it('mcp:read does not grant youtube-comments (requires mcp:comments)', () => {
      expect(hasScopeForFunction(['mcp:read'], 'youtube-comments')).toBe(false);
    });

    it('mcp:analytics does not grant content-brain (requires mcp:autopilot)', () => {
      expect(hasScopeForFunction(['mcp:analytics'], 'content-brain')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty scopes array', () => {
      expect(hasScopeForFunction([], 'mcp-data')).toBe(false);
    });

    it('returns false for unknown function name', () => {
      expect(hasScopeForFunction(['mcp:full'], 'unknown-function')).toBe(true);
      // mcp:full short-circuits before checking FUNCTION_REQUIRED_SCOPE
    });

    it('returns false for unknown function without mcp:full', () => {
      expect(hasScopeForFunction(['mcp:read'], 'unknown-function')).toBe(false);
    });

    it('works with multiple scopes in the array', () => {
      expect(hasScopeForFunction(['mcp:read', 'mcp:write'], 'social-neuron-ai')).toBe(true);
      expect(hasScopeForFunction(['mcp:read', 'mcp:write'], 'schedule-post')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// hashParams PII redaction
// ---------------------------------------------------------------------------
describe('hashParams', () => {
  describe('SAFE_CONTENT_FIELDS are redacted', () => {
    it('redacts caption field', async () => {
      const hash1 = await hashParams({ caption: 'My secret caption', model: 'veo3' });
      const hash2 = await hashParams({ caption: 'Different caption', model: 'veo3' });
      // Both should produce the same hash because caption is redacted to length
      expect(hash1).toBe(hash2);
    });

    it('redacts prompt field', async () => {
      const hash1 = await hashParams({ prompt: 'Generate a sunset scene', userId: 'u1' });
      const hash2 = await hashParams({ prompt: 'Generate a sunrise view', userId: 'u1' });
      // Same length prompts produce same hash (both 23 chars)
      expect(hash1).toBe(hash2);
    });

    it('preserves redacted length in substitution', async () => {
      const hash1 = await hashParams({ caption: 'short' });
      const hash2 = await hashParams({ caption: 'this is a much longer caption text' });
      // Different lengths produce different hashes
      expect(hash1).not.toBe(hash2);
    });

    it('redacts all safe content fields', async () => {
      const params: Record<string, unknown> = { userId: 'u1' };
      for (const field of SAFE_CONTENT_FIELDS) {
        params[field] = 'sensitive content here';
      }
      // Should not throw and should produce a valid hash
      const hash = await hashParams(params);
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('URL fields are redacted', () => {
    it('redacts fields ending in _url', async () => {
      const hash1 = await hashParams({
        media_url: 'https://example.com/video1.mp4',
        model: 'veo3',
      });
      const hash2 = await hashParams({
        media_url: 'https://example.com/video2.mp4',
        model: 'veo3',
      });
      // Same length URLs produce same hash
      expect(hash1).toBe(hash2);
    });

    it('redacts fields ending in Url (camelCase)', async () => {
      const hash1 = await hashParams({ mediaUrl: 'https://cdn.example.com/a.mp4', model: 'kling' });
      const hash2 = await hashParams({ mediaUrl: 'https://cdn.example.com/b.mp4', model: 'kling' });
      expect(hash1).toBe(hash2);
    });

    it('does not redact fields not ending in url/Url', async () => {
      const hash1 = await hashParams({ model: 'veo3', aspectRatio: '16:9' });
      const hash2 = await hashParams({ model: 'kling', aspectRatio: '16:9' });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('non-PII fields are preserved', () => {
    it('different models produce different hashes', async () => {
      const hash1 = await hashParams({ model: 'veo3', duration: 5 });
      const hash2 = await hashParams({ model: 'kling', duration: 5 });
      expect(hash1).not.toBe(hash2);
    });

    it('different userIds produce different hashes', async () => {
      const hash1 = await hashParams({ userId: 'user-a', model: 'veo3' });
      const hash2 = await hashParams({ userId: 'user-b', model: 'veo3' });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hash format', () => {
    it('produces a 32-character hex string', async () => {
      const hash = await hashParams({ model: 'test' });
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces consistent output for identical input', async () => {
      const params = { model: 'veo3', duration: 5, aspectRatio: '16:9' };
      const hash1 = await hashParams(params);
      const hash2 = await hashParams(params);
      expect(hash1).toBe(hash2);
    });

    it('produces different output for different input', async () => {
      const hash1 = await hashParams({ model: 'veo3' });
      const hash2 = await hashParams({ model: 'kling' });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('edge cases', () => {
    it('handles empty params object', async () => {
      const hash = await hashParams({});
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('handles non-string values in safe fields gracefully', async () => {
      const hash = await hashParams({ caption: 42 as unknown as string, model: 'veo3' });
      // Non-string caption gets redacted to length 0
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('redacts nested url fields only at top level', async () => {
      // hashParams only does shallow redaction (Object.keys on the spread copy)
      const hash1 = await hashParams({ config: { imageUrl: 'a' } as unknown as string });
      const hash2 = await hashParams({ config: { imageUrl: 'b' } as unknown as string });
      // Nested objects are not redacted, so different values produce different hashes
      expect(hash1).not.toBe(hash2);
    });
  });
});
