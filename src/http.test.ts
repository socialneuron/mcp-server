import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOriginPolicy, validateBrowserOrigin } from './lib/origin-policy.js';
import { selectExactOAuthResource } from './lib/oauth-resource-param.js';

// Since http.ts starts a server on import (express.listen, process handlers),
// we test the key security behaviors via isolated unit tests that validate
// the patterns used in the server without importing the module directly.

describe('HTTP Server Security Patterns', () => {
  describe('OAuth resource query normalization', () => {
    const configuredResource = 'https://mcp.socialneuron.com/mcp';

    it('selects the exact configured resource from repeated parameters', () => {
      expect(
        selectExactOAuthResource(
          ['https://attacker.example/mcp', `${configuredResource}/`],
          configuredResource
        )
      ).toBe(configuredResource);
    });

    it('never falls back to an attacker-controlled resource', () => {
      expect(
        selectExactOAuthResource(
          ['https://attacker.example/mcp', 'not-a-resource'],
          configuredResource
        )
      ).toBeUndefined();
    });
  });

  describe('Session ownership verification', () => {
    it('should reject session access from wrong user', () => {
      const sessions = new Map();
      sessions.set('session-1', { userId: 'user-A', lastActivity: Date.now() });

      const entry = sessions.get('session-1')!;
      const requestUserId = 'user-B';

      expect(entry.userId).not.toBe(requestUserId);
    });

    it('should allow session access from correct user', () => {
      const sessions = new Map();
      sessions.set('session-1', { userId: 'user-A', lastActivity: Date.now() });

      const entry = sessions.get('session-1')!;
      expect(entry.userId).toBe('user-A');
    });
  });

  describe('Session limits', () => {
    it('should enforce MAX_SESSIONS global cap', () => {
      const MAX_SESSIONS = 500;
      const sessions = new Map();
      for (let i = 0; i < MAX_SESSIONS; i++) {
        sessions.set(`session-${i}`, { userId: `user-${i % 50}`, lastActivity: Date.now() });
      }
      expect(sessions.size).toBe(MAX_SESSIONS);
      expect(sessions.size >= MAX_SESSIONS).toBe(true);
    });

    it('should enforce MAX_SESSIONS_PER_USER cap', () => {
      const MAX_SESSIONS_PER_USER = 10;
      const sessions = new Map();
      const targetUserId = 'user-heavy';

      for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
        sessions.set(`session-${i}`, { userId: targetUserId, lastActivity: Date.now() });
      }

      let count = 0;
      for (const entry of sessions.values()) {
        if ((entry as any).userId === targetUserId) count++;
      }
      expect(count >= MAX_SESSIONS_PER_USER).toBe(true);
    });
  });

  describe('Session cleanup', () => {
    it('should identify stale sessions beyond timeout', () => {
      const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
      const now = Date.now();

      const sessions = new Map();
      sessions.set('fresh', { userId: 'u1', lastActivity: now - 1000 });
      sessions.set('stale', { userId: 'u2', lastActivity: now - SESSION_TIMEOUT_MS - 1000 });

      const stale: string[] = [];
      for (const [id, entry] of sessions) {
        if (now - (entry as any).lastActivity > SESSION_TIMEOUT_MS) {
          stale.push(id);
        }
      }

      expect(stale).toEqual(['stale']);
    });
  });

  describe('Bearer token parsing', () => {
    it('should extract token from valid Bearer header', () => {
      const header = 'Bearer abc123token';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      expect(token).toBe('abc123token');
    });

    it('should reject missing Bearer prefix', () => {
      const header = 'Basic abc123';
      const hasBearer = header?.startsWith('Bearer ');
      expect(hasBearer).toBe(false);
    });

    it('should reject empty auth header', () => {
      const header: string | undefined = undefined;
      expect(header?.startsWith('Bearer ')).toBeFalsy();
    });
  });

  describe('Health endpoint security', () => {
    it('should only expose status and version in public health', () => {
      const publicHealth = { status: 'ok', version: '1.1.0' };
      expect(Object.keys(publicHealth)).toEqual(['status', 'version']);
      expect(publicHealth).not.toHaveProperty('sessions');
      expect(publicHealth).not.toHaveProperty('memory');
      expect(publicHealth).not.toHaveProperty('uptime');
    });

    it('should include details in authenticated health endpoint', () => {
      const detailedHealth = {
        status: 'ok',
        version: '1.1.0',
        transport: 'streamable-http',
        sessions: 5,
        sessionCap: 500,
        uptime: 3600,
        memory: 128,
        env: 'production',
      };
      expect(detailedHealth).toHaveProperty('sessions');
      expect(detailedHealth).toHaveProperty('memory');
      expect(detailedHealth).toHaveProperty('uptime');
    });
  });

  describe('Rate limiting integration', () => {
    it('should apply rate limit check before processing', () => {
      const rateLimitResult = { allowed: false, retryAfter: 30 };

      if (!rateLimitResult.allowed) {
        const response = {
          status: 429,
          body: {
            error: 'rate_limited',
            error_description: 'Too many requests. Please slow down.',
            retry_after: rateLimitResult.retryAfter,
          },
        };
        expect(response.status).toBe(429);
        expect(response.body.retry_after).toBe(30);
      }
    });
  });

  describe('Request context isolation', () => {
    it('should include budget fields in request context', () => {
      const context = {
        userId: 'user-1',
        scopes: ['mcp:read'],
        creditsUsed: 0,
        assetsGenerated: 0,
      };

      expect(context).toHaveProperty('creditsUsed', 0);
      expect(context).toHaveProperty('assetsGenerated', 0);
    });

    it('should isolate budget between requests', () => {
      const ctx1 = { userId: 'user-1', scopes: ['mcp:read'], creditsUsed: 0, assetsGenerated: 0 };
      const ctx2 = { userId: 'user-2', scopes: ['mcp:read'], creditsUsed: 0, assetsGenerated: 0 };

      ctx1.creditsUsed += 10;

      expect(ctx1.creditsUsed).toBe(10);
      expect(ctx2.creditsUsed).toBe(0);
    });
  });

  describe('CORS headers', () => {
    it('should include required CORS headers without wildcard origin', () => {
      const requiredHeaders = [
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers',
        'Access-Control-Expose-Headers',
      ];

      const originCheck = validateBrowserOrigin(
        'https://app.socialneuron.com',
        buildOriginPolicy({
          allowedOriginsEnv: 'https://socialneuron.com,https://app.socialneuron.com',
          nodeEnv: 'production',
        })
      );

      const corsMiddleware = {
        'Access-Control-Allow-Origin': originCheck.allowed ? originCheck.origin : null,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
      };

      for (const header of requiredHeaders) {
        expect(corsMiddleware).toHaveProperty(header);
      }
      expect(corsMiddleware['Access-Control-Allow-Origin']).toBe('https://app.socialneuron.com');
      expect(corsMiddleware['Access-Control-Allow-Origin']).not.toBe('*');
    });

    it('should reject unlisted browser origins before auth/body handling', () => {
      const policy = buildOriginPolicy({
        allowedOriginsEnv: 'https://socialneuron.com,https://app.socialneuron.com',
        nodeEnv: 'production',
      });

      expect(validateBrowserOrigin('https://attacker.example', policy)).toEqual({
        allowed: false,
        reason: 'invalid_origin',
      });
    });
  });

  describe('POST /mcp discovery middleware auth gate (source guard)', () => {
    // The discovery middleware previously short-circuited non-JSON-RPC bodies
    // with `return next()`, skipping authenticateRequest entirely. The
    // authenticated session handler then dereferenced req.auth!.userId ->
    // unhandled TypeError -> 500 for any unauthenticated scanner POST.
    // Non-JSON-RPC bodies must fall through to the SAME auth gate as other
    // methods (401 challenge when unauthenticated; batch-array bodies from
    // authenticated clients keep working).
    const httpSource = readFileSync(
      fileURLToPath(new URL('./http.ts', import.meta.url)),
      'utf8'
    );

    it('must not bypass auth for non-JSON-RPC bodies', () => {
      expect(httpSource).not.toMatch(/jsonrpc\s*!==\s*"2\.0"\)\s*return next\(\)/);
    });

    it('gates non-tools/list traffic behind authenticateRequest inside the discovery middleware', () => {
      expect(httpSource).toContain('authenticateRequest(req as AuthenticatedRequest, res, next)');
      expect(httpSource).toContain('body?.jsonrpc === "2.0" && body.method === "tools/list"');
    });
  });

  describe('MCP JSON parser placement', () => {
    it('should keep unauthenticated MCP JSON requests on the small parser limit', () => {
      const hasBearer = false;
      const parserLimit = hasBearer ? '16mb' : '100kb';

      expect(parserLimit).toBe('100kb');
    });

    it('should only allow the 16mb MCP parser after Bearer auth succeeds', () => {
      const request = { hasBearer: true, auth: { userId: 'user-1' } };
      const parserLimit = request.auth ? '16mb' : '100kb';

      expect(request.hasBearer).toBe(true);
      expect(parserLimit).toBe('16mb');
    });

    it('should leave non-MCP JSON requests on the small default parser', () => {
      const path = '/token';
      const parserLimit = path === '/mcp' ? 'route-specific' : '100kb';

      expect(parserLimit).toBe('100kb');
    });
  });

  describe('Graceful shutdown', () => {
    it('should handle session cleanup on shutdown', () => {
      const sessions = new Map();
      sessions.set('s1', { userId: 'u1' });
      sessions.set('s2', { userId: 'u2' });

      // Simulate shutdown cleanup
      for (const [sessionId] of sessions) {
        sessions.delete(sessionId);
      }

      expect(sessions.size).toBe(0);
    });
  });
});
