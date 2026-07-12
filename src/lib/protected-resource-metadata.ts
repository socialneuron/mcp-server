export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_documentation: string;
}

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
