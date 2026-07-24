const PRODUCTION_FALLBACK_ORIGINS = [
  'https://socialneuron.com',
  'https://www.socialneuron.com',
  'https://app.socialneuron.com',
];

const DEVELOPMENT_FALLBACK_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
];

export interface OriginPolicy {
  allowedOrigins: Set<string>;
  source: 'env' | 'fallback';
}

export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'null') return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const normalized = normalizeOrigin(entry);
    if (normalized) origins.add(normalized);
  }
  return origins;
}

export function buildOriginPolicy(input: {
  allowedOriginsEnv?: string;
  configuredUrls?: string[];
  nodeEnv?: string;
}): OriginPolicy {
  const envOrigins = parseAllowedOrigins(input.allowedOriginsEnv);
  const source = envOrigins.size > 0 ? 'env' : 'fallback';
  const allowedOrigins = source === 'env' ? envOrigins : new Set(PRODUCTION_FALLBACK_ORIGINS);

  // Configured service/client URLs are explicit operator trust decisions and
  // must remain additive when ALLOWED_ORIGINS is set. Previously the env value
  // silently discarded them, which broke browser-hosted MCP connectors while
  // leaving non-browser clients unaffected.
  for (const configuredUrl of input.configuredUrls ?? []) {
    const normalized = normalizeOrigin(configuredUrl);
    if (normalized) allowedOrigins.add(normalized);
  }

  if (source === 'fallback' && input.nodeEnv !== 'production') {
    for (const origin of DEVELOPMENT_FALLBACK_ORIGINS) allowedOrigins.add(origin);
  }

  return { allowedOrigins, source };
}

export function validateBrowserOrigin(
  originHeader: string | string[] | undefined,
  policy: OriginPolicy
): { allowed: true; origin: string | null } | { allowed: false; reason: 'invalid_origin' } {
  // Non-browser MCP clients generally do not send Origin. The MCP DNS-rebinding
  // risk is browser-originated, so absence of Origin is not rejected.
  if (originHeader === undefined) return { allowed: true, origin: null };
  if (Array.isArray(originHeader)) return { allowed: false, reason: 'invalid_origin' };

  const normalized = normalizeOrigin(originHeader);
  if (!normalized || !policy.allowedOrigins.has(normalized)) {
    return { allowed: false, reason: 'invalid_origin' };
  }

  return { allowed: true, origin: normalized };
}
