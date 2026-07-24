/**
 * Select only the configured RFC 8707 protected resource from a repeated
 * Express query value. Never forward an attacker-controlled fallback.
 */
export function selectExactOAuthResource(
  value: unknown,
  configuredResource: string
): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const protectedResource = configuredResource.replace(/\/$/, '');
  const hasExactResource = values.some(
    item =>
      typeof item === 'string' && item.length > 0 && item.replace(/\/$/, '') === protectedResource
  );
  return hasExactResource ? protectedResource : undefined;
}
