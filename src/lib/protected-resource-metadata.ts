export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_documentation: string;
}

// RFC 9728 clients may query the root well-known location or insert the
// well-known suffix before the protected resource path. Supporting both keeps
// discovery interoperable for a connector URL ending in /mcp.
export const PROTECTED_RESOURCE_METADATA_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
];

/**
 * Build RFC 9728 protected-resource metadata. The resource value deliberately
 * preserves the full MCP URL (including /mcp): Claude requires an exact match
 * with the connector URL entered by the user.
 */
export function buildProtectedResourceMetadata(options: {
  resourceUrl: string;
  authorizationServerUrl: string;
  scopesSupported: string[];
  documentationUrl: string;
}): ProtectedResourceMetadata {
  return {
    resource: options.resourceUrl,
    authorization_servers: [options.authorizationServerUrl],
    scopes_supported: [...options.scopesSupported],
    resource_documentation: options.documentationUrl,
  };
}
