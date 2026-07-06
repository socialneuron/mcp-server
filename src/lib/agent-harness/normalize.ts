// Mirror of lib/agent-harness/normalize.ts. Update README.md when this file changes.
const OVERRIDE_CHARS = /[‪-‮⁦-⁩]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const EXCESSIVE_WHITESPACE = /\s{2,}/g;

export function normalize(text: string): string {
  if (typeof text !== 'string') return '';
  let out = text.normalize('NFKC');
  out = out.replace(OVERRIDE_CHARS, '');
  out = out.replace(HTML_COMMENT, '');
  out = out.replace(EXCESSIVE_WHITESPACE, ' ');
  return out;
}
