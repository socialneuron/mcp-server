import type { RequestHandler } from 'express';

/** Public discovery only; robots policy is not an authorization boundary. */
export const robots: RequestHandler = (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(
    [
      'User-agent: *',
      'Allow: /v1/openapi.json',
      'Allow: /v1/tools',
      'Allow: /.well-known/',
      'Allow: /health',
      'Allow: /ready',
      'Disallow: /v1/tools/',
      'Disallow: /mcp',
      'Disallow: /authorize',
      'Disallow: /token',
      'Disallow: /register',
      '',
    ].join('\n')
  );
};
