import express from 'express';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { robots } from './robots.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
});
async function request(method = 'GET') {
  const app = express();
  // Execute the actual registration without importing http.ts, which starts the server.
  const source = readFileSync(new URL('../http.ts', import.meta.url), 'utf8');
  const registration = source.match(/app\.get\('\/robots\.txt', robots\);/)?.[0] ?? '';
  new Function('app', 'robots', registration)(app, robots);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return fetch(`http://127.0.0.1:${address.port}/robots.txt`, { method });
}
describe('public crawler discovery policy', () => {
  it('serves an unauthenticated text policy allowing discovery and disallowing execution paths', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const lines = (await response.text()).trim().split('\n');
    expect(lines[0]).toBe('User-agent: *');
    for (const path of ['/v1/openapi.json', '/v1/tools', '/.well-known/', '/health', '/ready'])
      expect(lines).toContain(`Allow: ${path}`);
    for (const path of ['/v1/tools/', '/mcp', '/authorize', '/token', '/register'])
      expect(lines).toContain(`Disallow: ${path}`);
  });
  it('supports HEAD without returning a response body', async () => {
    const response = await request('HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('');
  });
});
