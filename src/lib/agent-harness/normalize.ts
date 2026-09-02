const OVERRIDE_CHARS = /[‪-‮⁦-⁩]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const EXCESSIVE_WHITESPACE = /\s{2,}/g;

export function normalize(text: string): string {
  if (typeof text !== 'string') return '';
  let out = text.normalize('NFKC');
  out = out.replace(OVERRIDE_CHARS, '');

  let previous: string;
  do {
    previous = out;
    out = out.replace(HTML_COMMENT, '');
  } while (out !== previous);

  out = out.replace(EXCESSIVE_WHITESPACE, ' ');
  return out;
}

/**
 * Cyrillic and Greek characters that are visually confusable with Latin ones.
 *
 * NFKC deliberately does NOT fold these — they are distinct letters, not
 * compatibility variants — so an instruction phrase spelled with Cyrillic `о`
 * (U+043E) sails past an ASCII blocklist. This map exists solely so the
 * detectors can compare a folded *skeleton* of the text.
 *
 * Keep this list conservative and auditable: only characters whose Latin
 * lookalike is unambiguous belong here.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic, lowercase
  а: 'a',
  в: 'b',
  е: 'e',
  ѕ: 's',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ԁ: 'd',
  ё: 'e',
  һ: 'h',
  ѵ: 'v',
  ԛ: 'q',
  ѡ: 'w',
  ӏ: 'l',
  ԝ: 'w',
  // Cyrillic, uppercase
  А: 'A',
  В: 'B',
  Е: 'E',
  Ѕ: 'S',
  І: 'I',
  Ј: 'J',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  // Greek, lowercase
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ϲ: 'c',
  γ: 'y',
  η: 'n',
  // Greek, uppercase
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
};

const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

/**
 * Fold confusable characters to their Latin lookalikes for DETECTION ONLY.
 *
 * Never feed the result into `sanitized_text`: folding is lossy and would
 * corrupt legitimate Cyrillic or Greek content (a Russian-language brand
 * profile, say). `normalize()` remains the output path; this is the scanning
 * path.
 */
export function skeleton(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CONFUSABLE_RE, ch => CONFUSABLES[ch] ?? ch);
}
