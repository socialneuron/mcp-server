import { describe, expect, it } from 'vitest';
import {
  getVerifiedMediaReferences,
  registerVerifiedMediaReference,
  type VerifiedMediaCaller,
} from './verified-media-reference.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const ORG_ID = '00000000-0000-4000-8000-000000000003';
const CALLER: VerifiedMediaCaller = { userId: USER_ID, projectId: PROJECT_ID };
const PATH = ['content', 0, 'text'] as const;
const SIGNATURE = 'a'.repeat(64);
const ACCESS_KEY = 'AKIA' + 'Z'.repeat(16);

interface Fixture {
  caller: VerifiedMediaCaller;
  key: string;
  url: string;
  expiresAt: string;
  result: { content: Array<{ type: 'text'; text: string }> };
  credentialValue: string;
}

function makeFixture(overrides: Partial<Pick<Fixture, 'caller' | 'key' | 'url' | 'expiresAt'>> = {}): Fixture {
  const issuedAtMs = Math.floor(Date.now() / 1000) * 1000 - 1000;
  const issuedAt = new Date(issuedAtMs);
  const amzDate = `${issuedAt.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const dateFolder = issuedAt.toISOString().slice(0, 10);
  const key =
    overrides.key ??
    `org_${ORG_ID}/user_${USER_ID}/project_${PROJECT_ID}/images/${dateFolder}/1730686000123_fixture.png`;
  const credentialValue = `${ACCESS_KEY}%2F${amzDate.slice(0, 8)}%2Fauto%2Fs3%2Faws4_request`;
  const url =
    overrides.url ??
    `https://r2.example.invalid/media-bucket/${key}` +
      `?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
      `&X-Amz-Credential=${credentialValue}` +
      `&X-Amz-Date=${amzDate}` +
      `&X-Amz-Expires=3600` +
      `&X-Amz-SignedHeaders=host` +
      `&X-Amz-Signature=${SIGNATURE}`;
  const expiresAt = overrides.expiresAt ?? new Date(issuedAtMs + 3_600_000).toISOString();
  const result = {
    content: [{ type: 'text' as const, text: `Signed URL: ${url}\nExpires in: 3600s` }],
  };

  return { caller: overrides.caller ?? CALLER, key, url, expiresAt, result, credentialValue };
}

function submit(fixture: Fixture) {
  return registerVerifiedMediaReference(fixture.result, {
    caller: fixture.caller,
    key: fixture.key,
    url: fixture.url,
    expiresAt: fixture.expiresAt,
    path: PATH,
  });
}

function register(fixture: Fixture, overrides: Partial<Pick<Fixture, 'caller' | 'key' | 'url' | 'expiresAt'>> = {}) {
  const caller = overrides.caller ?? fixture.caller;
  const key = overrides.key ?? fixture.key;
  const url = overrides.url ?? fixture.url;
  const expiresAt = overrides.expiresAt ?? fixture.expiresAt;
  fixture.result.content[0].text = `Signed URL: ${url}\nExpires in: 3600s`;
  return registerVerifiedMediaReference(fixture.result, {
    caller,
    key,
    url,
    expiresAt,
    path: PATH,
  });
}

describe('verified media reference receipts', () => {
  it('records only credential and signature query value spans for the exact result leaf', () => {
    const fixture = makeFixture();
    expect(register(fixture)).toBe(true);

    const [reference] = getVerifiedMediaReferences(fixture.result, CALLER);
    const credentialStart = fixture.url.indexOf(fixture.credentialValue);
    const signatureValue = `X-Amz-Signature=${SIGNATURE}`;
    const signatureStart = fixture.url.indexOf(signatureValue) + 'X-Amz-Signature='.length;

    expect(reference).toEqual({
      path: PATH,
      url: fixture.url,
      credentialRanges: [
        [credentialStart, credentialStart + fixture.credentialValue.length],
        [signatureStart, signatureStart + SIGNATURE.length],
      ],
    });
  });

  it('does not trust unregistered results, clones, or callers outside the receipt owner/project', () => {
    const fixture = makeFixture();
    expect(getVerifiedMediaReferences(fixture.result, CALLER)).toEqual([]);
    expect(register(fixture)).toBe(true);
    expect(getVerifiedMediaReferences({ ...fixture.result }, CALLER)).toEqual([]);
    expect(getVerifiedMediaReferences(fixture.result, null)).toEqual([]);
    expect(getVerifiedMediaReferences(fixture.result, { userId: USER_ID, projectId: null })).toEqual([]);
    expect(getVerifiedMediaReferences(fixture.result, { userId: PROJECT_ID, projectId: PROJECT_ID })).toEqual([]);
    expect(
      getVerifiedMediaReferences(fixture.result, { userId: USER_ID, projectId: ORG_ID })
    ).toEqual([]);
  });

  it('requires canonical actor and project ownership in the returned key', () => {
    const fixture = makeFixture();
    expect(
      register(fixture, {
        key: fixture.key.replace(`user_${USER_ID}`, `user_${ORG_ID}`),
      })
    ).toBe(false);

    const projectMismatch = makeFixture({
      key: fixture.key.replace(`project_${PROJECT_ID}`, `project_${ORG_ID}`),
    });
    expect(register(projectMismatch)).toBe(false);

    const unscoped = makeFixture({ caller: { userId: USER_ID, projectId: null } });
    expect(register(unscoped)).toBe(true);
    expect(getVerifiedMediaReferences(unscoped.result, unscoped.caller)).toHaveLength(1);
    expect(getVerifiedMediaReferences(unscoped.result, CALLER)).toEqual([]);

    const defaultProject = makeFixture({
      caller: { userId: USER_ID, projectId: null },
      key: fixture.key.replace(`project_${PROJECT_ID}`, 'project_default'),
    });
    expect(register(defaultProject)).toBe(true);
  });

  it('requires a virtual-host or single-bucket URL path whose decoded suffix is the exact key', () => {
    const fixture = makeFixture();
    const wrongKeyUrl = fixture.url.replace(`/${fixture.key}?`, `/other/${fixture.key}?`);
    expect(register(fixture, { url: wrongKeyUrl })).toBe(false);

    const encodedSlash = makeFixture({ url: fixture.url.replace('/images/', '/images%2F') });
    expect(register(encodedSlash)).toBe(false);

    const virtualHostStyle = makeFixture({ url: fixture.url.replace('/media-bucket/', '/') });
    expect(register(virtualHostStyle)).toBe(true);
  });

  it.each([
    ['HTTP', (url: string) => url.replace('https://', 'http://')],
    ['userinfo', (url: string) => url.replace('https://', 'https://name@')],
    ['fragment', (url: string) => `${url}#fragment`],
    ['duplicate signature parameter', (url: string) => `${url}&X-Amz-Signature=${'b'.repeat(64)}`],
    ['duplicate unrelated parameter', (url: string) => `${url}&mode=one&mode=two`],
    ['wrong algorithm', (url: string) => url.replace('AWS4-HMAC-SHA256', 'AWS4-HMAC-SHA1')],
    ['invalid signing date', (url: string) => url.replace(/X-Amz-Date=[^&]+/, 'X-Amz-Date=20261340T256199Z')],
    ['wrong credential scope date', (url: string) => url.replace(/%2F\d{8}%2Fauto/, '%2F20250101%2Fauto')],
    ['wrong credential scope service', (url: string) => url.replace('%2Fauto%2Fs3%2Faws4_request', '%2Fauto%2Fiam%2Faws4_request')],
    ['unsupported expiry', (url: string) => url.replace('X-Amz-Expires=3600', 'X-Amz-Expires=604801')],
    ['wrong signed headers', (url: string) => url.replace('X-Amz-SignedHeaders=host', 'X-Amz-SignedHeaders=host%3Bcontent-type')],
    ['malformed signature', (url: string) => url.replace(SIGNATURE, 'not-a-hex-signature')],
  ])('rejects malformed or ambiguous SigV4 URL: %s', (_name, mutate) => {
    const fixture = makeFixture();
    expect(register(fixture, { url: mutate(fixture.url) })).toBe(false);
  });

  it('rejects expiry timestamps that are expired or do not match SigV4 expiry', () => {
    const fixture = makeFixture();
    expect(register(fixture, { expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(register(fixture, { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })).toBe(false);
  });

  it('rejects the same URL repeated, placed at another path, or embedded in another URI', () => {
    const repeated = makeFixture();
    repeated.result.content[0].text = `${repeated.url}\n${repeated.url}`;
    expect(registerVerifiedMediaReference(repeated.result, {
      caller: CALLER,
      key: repeated.key,
      url: repeated.url,
      expiresAt: repeated.expiresAt,
      path: PATH,
    })).toBe(false);

    const otherLeaf = makeFixture();
    otherLeaf.result.content.push({ type: 'text', text: otherLeaf.url });
    expect(register(otherLeaf)).toBe(false);

    const customScheme = makeFixture();
    customScheme.result.content[0].text = `r2://evil/${customScheme.url}`;
    expect(submit(customScheme)).toBe(false);

    const outerUri = makeFixture();
    outerUri.result.content[0].text = `https://wrapper.example.invalid/?target=${outerUri.url}`;
    expect(submit(outerUri)).toBe(false);
  });

  it('revalidates the exact result leaf on retrieval and returns defensive copies', () => {
    const fixture = makeFixture();
    expect(register(fixture)).toBe(true);
    const first = getVerifiedMediaReferences(fixture.result, CALLER);
    expect(first).toHaveLength(1);

    (first[0].credentialRanges as Array<[number, number]>).push([0, 1]);
    (first[0].path as Array<string | number>).push('tampered');
    expect(getVerifiedMediaReferences(fixture.result, CALLER)[0]).toEqual({
      path: PATH,
      url: fixture.url,
      credentialRanges: [
        [fixture.url.indexOf(fixture.credentialValue), fixture.url.indexOf(fixture.credentialValue) + fixture.credentialValue.length],
        [fixture.url.indexOf(`X-Amz-Signature=${SIGNATURE}`) + 'X-Amz-Signature='.length,
          fixture.url.indexOf(`X-Amz-Signature=${SIGNATURE}`) + 'X-Amz-Signature='.length + SIGNATURE.length],
      ],
    });

    fixture.result.content[0].text += `\nAgain: ${fixture.url}`;
    expect(getVerifiedMediaReferences(fixture.result, CALLER)).toEqual([]);
  });

  it('does not grant a receipt from generic backend metadata or user-visible verified flags', () => {
    const fixture = makeFixture();
    const genericResult = Object.assign(fixture.result, {
      verified: true,
      verified_reference: { url: fixture.url, key: fixture.key },
    });
    expect(getVerifiedMediaReferences(genericResult, CALLER)).toEqual([]);
  });
});
