/**
 * Shared parsing utilities for MCP tools.
 */

/**
 * Extract a JSON array from text that may contain surrounding prose.
 * Tries direct parse first, then unwraps common wrapper keys, then regex fallback.
 */
export function extractJsonArray(text: string): unknown[] | null {
  // Try 1: direct parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // Unwrap common wrapper keys
    for (const key of ['posts', 'plan', 'content', 'items', 'results']) {
      if (parsed[key] && Array.isArray(parsed[key])) return parsed[key];
    }
  } catch {
    /* fall through */
  }

  // Try 2: regex fallback
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* fall through */
    }
  }

  return null;
}
