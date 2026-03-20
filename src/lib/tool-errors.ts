/**
 * Central error recovery formatter for MCP tool responses.
 * Appends actionable hints so agents know what to do next.
 */
export function formatToolError(rawMessage: string): string {
  const msg = rawMessage.toLowerCase();
  if (msg.includes('rate limit') || msg.includes('too many requests')) {
    return `${rawMessage} Reduce request frequency or wait before retrying.`;
  }
  if (msg.includes('insufficient credit') || msg.includes('budget') || msg.includes('spending cap')) {
    return `${rawMessage} Call get_credit_balance to check remaining credits. Consider a cheaper model or wait for monthly refresh.`;
  }
  if (msg.includes('oauth') || msg.includes('token expired') || msg.includes('not connected') || msg.includes('reconnect')) {
    return `${rawMessage} Call list_connected_accounts to check status. User may need to reconnect at socialneuron.com/settings/connections.`;
  }
  if (msg.includes('generation failed') || msg.includes('failed to start') || msg.includes('no job id') || msg.includes('could not be parsed')) {
    return `${rawMessage} Try simplifying the prompt, using a different model, or check credits with get_credit_balance.`;
  }
  if (msg.includes('not found') || (msg.includes('no ') && msg.includes(' found'))) {
    return `${rawMessage} Verify the ID is correct — use the corresponding list tool to find valid IDs.`;
  }
  if (msg.includes('not accessible') || msg.includes('unauthorized') || msg.includes('permission')) {
    return `${rawMessage} Check API key scopes with get_credit_balance. A higher-tier plan may be required.`;
  }
  if (msg.includes('ssrf') || msg.includes('url blocked')) {
    return `${rawMessage} The URL was blocked for security. Use a publicly accessible HTTPS URL.`;
  }
  if (msg.includes('failed to schedule') || msg.includes('scheduling failed')) {
    return `${rawMessage} Verify platform OAuth is active with list_connected_accounts, then retry.`;
  }
  if (msg.includes('no posts') || (msg.includes('plan') && msg.includes('has no'))) {
    return `${rawMessage} Generate a plan with plan_content_week first, then save with save_content_plan.`;
  }
  return rawMessage;
}
