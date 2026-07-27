/**
 * Comment-stripping fixpoint coverage for `normalize()`.
 *
 * A single `.replace(HTML_COMMENT, '')` pass can splice fragments into a
 * fresh comment — `<!<!-- x -->-- y -->` collapses to `<!-- y -->` — so
 * crafted input could carry an HTML comment (and its hidden payload) through
 * the sanitizer into `sanitized_text`.
 */
import { describe, it, expect } from 'vitest';
import { normalize } from '../normalize.js';

describe('normalize HTML comment stripping', () => {
  it('strips a plain comment', () => {
    expect(normalize('before <!-- hidden --> after')).toBe('before after');
  });

  it('strips comments that only form after an inner comment is removed', () => {
    const out = normalize('<!<!-- x -->-- payload -->');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('payload');
  });

  it('strips deeper splice nesting', () => {
    const out = normalize('<!<!<!-- a -->-- b -->-- c -->');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('b');
    expect(out).not.toContain('c');
  });

  it('leaves comment-free text intact', () => {
    expect(normalize('a normal sentence with < and > and -- dashes')).toBe(
      'a normal sentence with < and > and -- dashes'
    );
  });
});
