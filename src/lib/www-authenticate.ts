export interface WwwAuthenticateOptions {
  issuerUrl: string;
  realm?: string;
  error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope';
  errorDescription?: string;
  scope?: string;
}

function normalizeIssuerUrl(issuerUrl: string): string {
  return issuerUrl.replace(/\/+$/, '');
}

function quoteAuthParam(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/["\\]/g, '\\$&');
}

export function getProtectedResourceMetadataUrl(issuerUrl: string): string {
  return `${normalizeIssuerUrl(issuerUrl)}/.well-known/oauth-protected-resource`;
}

export function buildWwwAuthenticateHeader(options: WwwAuthenticateOptions): string {
  const params = new Map<string, string>();
  params.set('realm', options.realm ?? 'socialneuron');
  params.set('resource_metadata', getProtectedResourceMetadataUrl(options.issuerUrl));

  if (options.error) {
    params.set('error', options.error);
  }
  if (options.errorDescription) {
    params.set('error_description', options.errorDescription);
  }
  if (options.scope) {
    params.set('scope', options.scope);
  }

  return `Bearer ${Array.from(params.entries())
    .map(([key, value]) => `${key}="${quoteAuthParam(value)}"`)
    .join(', ')}`;
}
