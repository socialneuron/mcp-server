// Mirror of lib/agent-harness/types.ts. Update README.md when this file changes.
export type ScanRole =
  'mcp_tool_input' | 'mcp_tool_output' | 'agent_chat_tool' | 'content_safety_publish';

export type ScanMode = 'block' | 'sanitize' | 'observe';

export interface ScanOptions {
  mode: ScanMode;
  source: ScanRole;
  user_id?: string;
  /**
   * Deliberate per-caller widening of the role's length ceiling (the MCP
   * wrapper's per-tool allowance). Absent keeps the role default; every
   * other check still runs in full on the longer text.
   */
  maxLength?: number;
}

export interface ScanResult {
  passed: boolean;
  risk_score: number;
  flagged_patterns: string[];
  sanitized_text?: string;
  pii_redacted: boolean;
}
