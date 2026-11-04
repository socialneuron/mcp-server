/**
 * In-process provenance for the narrow R2/S3 download references issued by
 * authenticated media adapters. Receipts never enter the serialized MCP result.
 */
export interface VerifiedMediaCaller {
  userId: string;
  projectId: string | null;
}

export type VerifiedMediaPath = readonly (string | number)[];

export interface VerifiedMediaReference {
  path: VerifiedMediaPath;
  url: string;
  credentialRanges: readonly (readonly [number, number])[];
}

interface RegistrationInput {
  caller: VerifiedMediaCaller;
  key: string;
  url: string;
  expiresAt: string;
  path: VerifiedMediaPath;
}

interface StoredReceipt {
  userId: string;
  projectId: string | null;
  key: string;
  url: string;
  expiresAtMs: number;
  path: Array<string | number>;
  leafSnapshot: string;
  credentialRanges: Array<[number, number]>;
}

interface ParsedSigV4 {
  expiresAtMs: number;
  credentialRanges: Array<[number, number]>;
}

const RECEIPTS = new WeakMap<object, StoredReceipt[]>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMZ_DATE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const URL_TOKEN_RE = /https?:\/\/(?:\[[0-9A-Fa-f:.]*\][^\s"'<>)\]]*|[^\s"'<>)\]]+)/gi;
const URL_SCHEME_RE = /https?:\/\//gi;
const S3_DOWNLOAD_EXPIRY_SECONDS = 3600;
const ALLOWED_CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXPIRY_MATCH_TOLERANCE_MS = 5 * 1000;
const MAX_TREE_NODES = 10_000;
const MAX_PATH_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isCaller(value: unknown): value is VerifiedMediaCaller {
  if (!isRecord(value)) return false;
  return (
    typeof value.userId === 'string' &&
    UUID_RE.test(value.userId) &&
    (value.projectId === null || (typeof value.projectId === 'string' && UUID_RE.test(value.projectId)))
  );
}

function clonePath(path: unknown): Array<string | number> | null {
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH_DEPTH) return null;
  const copy: Array<string | number> = [];
  for (const segment of path) {
    if (typeof segment === 'string' && segment.length > 0) {
      copy.push(segment);
      continue;
    }
    if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
      copy.push(segment);
      continue;
    }
    return null;
  }
  return copy;
}

function dataProperty(value: object, key: string): PropertyDescriptor | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor : null;
  } catch {
    return null;
  }
}

function resolveStringLeaf(root: object, path: readonly (string | number)[]): string | null {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return null;
    if (Array.isArray(current)) {
      if (typeof segment !== 'number') return null;
      const descriptor = dataProperty(current, String(segment));
      if (!descriptor) return null;
      current = descriptor.value;
      continue;
    }
    if (typeof segment !== 'string') return null;
    const descriptor = dataProperty(current, segment);
    if (!descriptor) return null;
    current = descriptor.value;
  }
  return typeof current === 'string' ? current : null;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = 0;
  while ((at = text.indexOf(needle, at)) !== -1) {
    count += 1;
    at += needle.length;
    if (count > 1) return count;
  }
  return count;
}

/** Counts URL copies as JSON serialization would expose them; cycles/accessors fail closed. */
function countTreeOccurrences(root: object, needle: string): number | null {
  const active = new WeakSet<object>();
  let nodes = 0;
  let matches = 0;
  let invalid = false;

  const visit = (value: unknown, depth: number): void => {
    if (invalid || depth > MAX_PATH_DEPTH) {
      invalid = true;
      return;
    }
    nodes += 1;
    if (nodes > MAX_TREE_NODES) {
      invalid = true;
      return;
    }
    if (typeof value === 'string') {
      matches += countOccurrences(value, needle);
      if (matches > 1) invalid = true;
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (active.has(value)) {
      invalid = true;
      return;
    }
    active.add(value);
    try {
      const keys = Object.keys(value);
      for (const key of keys) {
        matches += countOccurrences(key, needle);
        if (matches > 1) {
          invalid = true;
          break;
        }
        const descriptor = dataProperty(value, key);
        if (!descriptor) {
          invalid = true;
          break;
        }
        visit(descriptor.value, depth + 1);
        if (invalid) break;
      }
    } catch {
      invalid = true;
    }
    active.delete(value);
  };

  visit(root, 0);
  return invalid ? null : matches;
}

function isValidDateFolder(value: string): boolean {
  if (!DATE_FOLDER_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isCanonicalOwnedKey(key: string, caller: VerifiedMediaCaller): boolean {
  if (!isCaller(caller)) return false;
  const segments = key.split('/');
  if (segments.length !== 6 || segments.some(segment => segment.length === 0)) return false;

  const [organization, user, project, contentFolder, dateFolder, filename] = segments;
  const organizationId = organization.startsWith('org_') ? organization.slice(4) : '';
  if (organization !== 'org_personal' && !UUID_RE.test(organizationId)) return false;
  if (!user.startsWith('user_') || user.slice(5).toLowerCase() !== caller.userId.toLowerCase()) return false;
  if (!project.startsWith('project_')) return false;
  const keyProject = project.slice(8);
  if (caller.projectId === null) {
    if (keyProject !== 'default' && !UUID_RE.test(keyProject)) return false;
  } else if (!UUID_RE.test(keyProject) || keyProject.toLowerCase() !== caller.projectId.toLowerCase()) {
    return false;
  }
  if (!['images', 'videos', 'audio', 'other'].includes(contentFolder)) return false;
  if (!isValidDateFolder(dateFolder)) return false;
  if (
    filename === '.' ||
    filename === '..' ||
    filename.length > 255 ||
    !/^[A-Za-z0-9._-]+$/.test(filename)
  )
    return false;
  return true;
}

function decodeFormComponent(value: string): string | null {
  if (/%(?![0-9a-f]{2})/i.test(value)) return null;
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function parseAmzDate(value: string): number | null {
  const match = AMZ_DATE_RE.exec(value);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z' === value ? timestamp : null;
}

function parseSignedUrl(url: string, key: string, expiresAtMs: number, nowMs: number): ParsedSigV4 | null {
  if (
    !url.startsWith('https://') ||
    /[\u0000-\u0020\\]/.test(url) ||
    url.includes('#')
  )
    return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    return null;
  }

  const authorityStart = 'https://'.length;
  const authorityDelimiter = url.slice(authorityStart).search(/[/?#]/);
  if (authorityDelimiter < 0) return null;
  const authorityEnd = authorityStart + authorityDelimiter;
  const authority = url.slice(authorityStart, authorityEnd);
  if (!authority || authority.includes('@')) return null;

  const pathStart = authorityEnd;
  if (url[pathStart] !== '/') return null;
  const queryStartIndex = url.indexOf('?', pathStart);
  if (queryStartIndex <= pathStart || queryStartIndex === url.length - 1) return null;
  const rawPath = url.slice(pathStart, queryStartIndex);
  const encodedPathSegments = rawPath.slice(1).split('/');
  const keySegments = key.split('/');
  const hasBucketPrefix = encodedPathSegments.length === keySegments.length + 1;
  if (
    (!hasBucketPrefix && encodedPathSegments.length !== keySegments.length) ||
    encodedPathSegments.some(part => !part)
  )
    return null;

  let decodedPathSegments: string[];
  try {
    decodedPathSegments = encodedPathSegments.map(segment => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const decodedKeySegments = hasBucketPrefix ? decodedPathSegments.slice(1) : decodedPathSegments;
  if (
    decodedPathSegments.some(segment =>
      segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')
    ) ||
    (hasBucketPrefix && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(decodedPathSegments[0])) ||
    decodedKeySegments.join('/') !== key
  )
    return null;

  const rawQuery = url.slice(queryStartIndex + 1);
  const queryStart = queryStartIndex + 1;
  const queryParams = new Map<string, { value: string; rawValue: string; start: number; end: number }>();
  let offset = 0;
  for (const component of rawQuery.split('&')) {
    const equalsIndex = component.indexOf('=');
    if (!component || equalsIndex <= 0 || equalsIndex === component.length - 1) return null;
    const rawName = component.slice(0, equalsIndex);
    const rawValue = component.slice(equalsIndex + 1);
    const name = decodeFormComponent(rawName);
    const value = decodeFormComponent(rawValue);
    if (!name || value === null || queryParams.has(name)) return null;
    const valueStart = queryStart + offset + equalsIndex + 1;
    queryParams.set(name, { value, rawValue, start: valueStart, end: valueStart + rawValue.length });
    offset += component.length + 1;
  }

  const requiredNames = [
    'X-Amz-Algorithm',
    'X-Amz-Credential',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-SignedHeaders',
    'X-Amz-Signature',
  ] as const;
  const required = new Map<string, { value: string; rawValue: string; start: number; end: number }>();
  for (const name of requiredNames) {
    const param = queryParams.get(name);
    if (!param) return null;
    required.set(name, param);
  }

  const algorithm = required.get('X-Amz-Algorithm')!.value;
  const credential = required.get('X-Amz-Credential')!.value;
  const amzDate = required.get('X-Amz-Date')!.value;
  const expires = required.get('X-Amz-Expires')!.value;
  const signedHeaders = required.get('X-Amz-SignedHeaders')!.value;
  const signature = required.get('X-Amz-Signature')!.value;
  const issuedAtMs = parseAmzDate(amzDate);
  const credentialMatch = /^([A-Za-z0-9]{8,128})\/(\d{8})\/auto\/s3\/aws4_request$/.exec(credential);
  const signatureParam = required.get('X-Amz-Signature')!;
  const credentialParam = required.get('X-Amz-Credential')!;

  if (
    algorithm !== 'AWS4-HMAC-SHA256' ||
    !issuedAtMs ||
    !credentialMatch ||
    credentialMatch[2] !== amzDate.slice(0, 8) ||
    expires !== String(S3_DOWNLOAD_EXPIRY_SECONDS) ||
    signedHeaders !== 'host' ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return null;

  const expectedExpiryMs = issuedAtMs + S3_DOWNLOAD_EXPIRY_SECONDS * 1000;
  if (
    issuedAtMs > nowMs + ALLOWED_CLOCK_SKEW_MS ||
    expectedExpiryMs <= nowMs ||
    expiresAtMs <= nowMs ||
    Math.abs(expiresAtMs - expectedExpiryMs) > EXPIRY_MATCH_TOLERANCE_MS
  )
    return null;

  // Re-check key consistency here so every receipt validation has one narrow
  // issuer contract even if it is later called through a new adapter.
  if (!key || keySegments.length !== 6) return null;

  return {
    expiresAtMs,
    credentialRanges: [
      [credentialParam.start, credentialParam.end],
      [signatureParam.start, signatureParam.end],
    ],
  };
}

function parseExpiresAt(value: string): number | null {
  if (!ISO_UTC_RE.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function hasSingleExactUrlToken(leaf: string, url: string): boolean {
  if (countOccurrences(leaf, url) !== 1) return false;
  const tokens = [...leaf.matchAll(URL_TOKEN_RE)];
  const schemes = [...leaf.matchAll(URL_SCHEME_RE)];
  if (tokens.length !== 1 || tokens[0]![0] !== url || schemes.length !== 1) return false;
  const start = tokens[0]!.index ?? -1;
  if (start < 0) return false;
  const end = start + url.length;
  const before = leaf[start - 1];
  const after = leaf[end];
  if (before && !/[\s"'(<[{]/.test(before)) return false;
  if (after && !/[\s"')\]}>]/.test(after)) return false;
  return true;
}

function findValidatedReceipt(
  result: object,
  caller: VerifiedMediaCaller,
  receipt: StoredReceipt,
  nowMs: number
): VerifiedMediaReference | null {
  const projectMatches =
    caller.projectId === null
      ? receipt.projectId === null
      : receipt.projectId !== null && caller.projectId.toLowerCase() === receipt.projectId.toLowerCase();
  if (
    caller.userId.toLowerCase() !== receipt.userId.toLowerCase() ||
    !projectMatches ||
    receipt.expiresAtMs <= nowMs ||
    !isCanonicalOwnedKey(receipt.key, caller)
  )
    return null;

  const leaf = resolveStringLeaf(result, receipt.path);
  if (leaf === null || leaf !== receipt.leafSnapshot || !hasSingleExactUrlToken(leaf, receipt.url)) return null;
  if (countTreeOccurrences(result, receipt.url) !== 1) return null;

  const parsed = parseSignedUrl(receipt.url, receipt.key, receipt.expiresAtMs, nowMs);
  if (!parsed) return null;
  return {
    path: [...receipt.path],
    url: receipt.url,
    credentialRanges: parsed.credentialRanges.map(range => [range[0], range[1]] as [number, number]),
  };
}

export function registerVerifiedMediaReference(result: object, input: RegistrationInput): boolean {
  if (!isRecord(result) || !isRecord(input) || !isCaller(input.caller)) return false;
  const path = clonePath(input.path);
  if (!path || typeof input.key !== 'string' || !isCanonicalOwnedKey(input.key, input.caller)) return false;
  if (typeof input.url !== 'string' || typeof input.expiresAt !== 'string') return false;

  const nowMs = Date.now();
  const expiresAtMs = parseExpiresAt(input.expiresAt);
  if (expiresAtMs === null || expiresAtMs <= nowMs) return false;
  const parsed = parseSignedUrl(input.url, input.key, expiresAtMs, nowMs);
  if (!parsed) return false;

  const leaf = resolveStringLeaf(result, path);
  if (leaf === null || !hasSingleExactUrlToken(leaf, input.url)) return false;
  if (countTreeOccurrences(result, input.url) !== 1) return false;

  const stored: StoredReceipt = {
    userId: input.caller.userId,
    projectId: input.caller.projectId,
    key: input.key,
    url: input.url,
    expiresAtMs,
    path,
    leafSnapshot: leaf,
    credentialRanges: parsed.credentialRanges.map(range => [range[0], range[1]] as [number, number]),
  };
  const previous = RECEIPTS.get(result) ?? [];
  if (previous.some(receipt => receipt.url === stored.url || samePath(receipt.path, stored.path))) return false;
  RECEIPTS.set(result, [...previous, stored]);
  return true;
}

function samePath(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

export function getVerifiedMediaReferences(
  result: object,
  caller: VerifiedMediaCaller | null
): VerifiedMediaReference[] {
  if (!isRecord(result) || !isCaller(caller)) return [];
  const receipts = RECEIPTS.get(result);
  if (!receipts?.length) return [];
  const nowMs = Date.now();
  return receipts
    .map(receipt => findValidatedReceipt(result, caller, receipt, nowMs))
    .filter((reference): reference is VerifiedMediaReference => reference !== null);
}
