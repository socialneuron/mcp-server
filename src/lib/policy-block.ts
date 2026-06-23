type PolicyBlockOptions = {
  toolName: string;
  policy: 'ssrf' | 'prompt_injection' | 'content_safety' | 'platform_policy';
  reason?: string | null;
  inputKind?: string;
  recoverWith?: string[];
};

export function policyBlockedResult({
  toolName,
  policy,
  reason,
  inputKind,
  recoverWith,
}: PolicyBlockOptions) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            ok: false,
            error_type: 'policy_block',
            policy,
            tool: toolName,
            ...(inputKind ? { input_kind: inputKind } : {}),
            reason: reason ?? 'Input blocked by MCP server safety policy.',
            recover_with:
              recoverWith ??
              [
                'Use a public HTTPS URL that does not resolve to localhost, private, link-local, or cloud metadata addresses.',
                'Do not include credentials or internal hostnames in URL inputs.',
              ],
          },
          null,
          2
        ),
      },
    ],
    // Policy denials are successful safety outcomes, not server failures.
    isError: false,
  };
}
