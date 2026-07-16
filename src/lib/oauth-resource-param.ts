/**
 * Selects only the configured RFC 8707 protected resource from an Express
 * query value. Some clients serialize repeated `resource` parameters as an
 * array; an attacker-controlled fallback must never be forwarded to OAuth.
 */
export function selectExactOAuthResource(
  value: unknown,
  configuredResource: string
): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const protectedResource = configuredResource.replace(/\/$/, '');

  const hasExactResource = values.some(
    (item): item is string =>
      typeof item === 'string' &&
      item.length > 0 &&
      item.replace(/\/$/, '') === protectedResource
  );
  return hasExactResource ? protectedResource : undefined;
}
