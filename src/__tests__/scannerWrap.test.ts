import { describe, it, expect, vi } from 'vitest';
import { wrapToolWithScanner } from '../lib/register-tools.js';
import { requestContext } from '../lib/request-context.js';
import { getVerifiedMediaCaller } from '../lib/supabase.js';
import { registerVerifiedMediaReference } from '../lib/verified-media-reference.js';

describe('wrapToolWithScanner', () => {
  it('blocks input with zero-width injection', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const result = await wrapped(
      { msg: 'hello​world' }, // contains U+200B
      { userId: 'user-1' } as any
    );
    expect(handler).not.toHaveBeenCalled();
    expect((result as any).isError).toBe(true);
    // #188: input blocks now carry a machine-readable error_type (policy_block)
    // with the flagged patterns in structuredContent instead of a bare string.
    expect((result as any).structuredContent.error.error_type).toBe('policy_block');
    expect((result as any).structuredContent.error.blocked_patterns).toBeInstanceOf(Array);
    expect((result as any).content[0].text).toContain('policy_block');
    expect((result as any).structuredContent.error.recover_with).toEqual([
      'Remove instruction-like or unsafe phrasing from the input and retry.',
    ]);
  });

  it('sanitizes PII in tool output before returning', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'user email: jane@example.com' }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain('[REDACTED:email]');
    expect(JSON.stringify(r)).not.toContain('jane@example.com');
  });

  it('preserves JSON numeric values that contain 16 fractional digits', async () => {
    const confidence = 0.8333333333333334;
    const result = {
      content: [{ type: 'text', text: JSON.stringify({ confidence }) }],
      structuredContent: { confidence },
    };
    const wrapped = wrapToolWithScanner('test_tool', vi.fn().mockResolvedValue(result));

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);

    expect(r).toEqual(result);
    expect(JSON.parse((r as any).content[0].text)).toEqual({ confidence });
  });

  it('preserves non-card identifiers while redacting Luhn-valid cards', async () => {
    const wrapped = wrapToolWithScanner(
      'test_tool',
      vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'trace=8333333333333334 card=4111111111111111' }],
      })
    );

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain('8333333333333334');
    expect(JSON.stringify(r)).toContain('[REDACTED:credit_card]');
    expect(JSON.stringify(r)).not.toContain('4111111111111111');
  });

  it('fails closed for numeric PII and non-JSON-serializable outputs', async () => {
    const numeric = wrapToolWithScanner(
      'test_tool',
      vi.fn().mockResolvedValue({ structuredContent: { card: 4111111111111111 } })
    );
    const bigint = wrapToolWithScanner(
      'test_tool',
      vi.fn().mockResolvedValue({ structuredContent: { count: 1n } })
    );

    expect((await numeric({ msg: 'safe' }, { userId: 'user-1' } as any)).isError).toBe(true);
    expect((await bigint({ msg: 'safe' }, { userId: 'user-1' } as any)).isError).toBe(true);
  });

  it('still sanitizes PII in legitimate outputs larger than the input limit', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: `${'x'.repeat(20_000)} jane@example.com` }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain('[REDACTED:email]');
    expect(JSON.stringify(r)).not.toContain('jane@example.com');
  });

  it('fails closed when a tool output exceeds the maximum scan size', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'x'.repeat(1_000_001) }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect((r as any).isError).toBe(true);
    expect((r as any).structuredContent.error.error_type).toBe('server_error');
    expect(JSON.stringify(r)).not.toContain('x'.repeat(100));
    expect((r as any).structuredContent.error.message).toBe(
      'The response could not pass the output safety checks and was not returned.'
    );
  });

  it('preserves UUIDs in tool output', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: `post_id=${uuid}` }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain(uuid);
  });

  it('passes through benign tool result unchanged', async () => {
    const result = { content: [{ type: 'text', text: 'all good' }] };
    const handler = vi.fn().mockResolvedValue(result);
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'fine' }, { userId: 'user-1' } as any);
    expect(r).toEqual(result);
  });

  it('handles undefined args gracefully', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped(undefined, { userId: 'user-1' } as any);
    expect(handler).toHaveBeenCalled();
    expect((r as any).isError).toBeUndefined();
  });

  it('gives privacy-safe recovery for sensitive input URLs', async () => {
    const url = 'https://192.0.2.10/?email=fixture%40example.invalid';
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const result = await wrapToolWithScanner('test_tool', handler)({ media: url }, {
      userId: 'fixture-user',
    } as never);
    expect(handler).not.toHaveBeenCalled();
    expect(result.structuredContent.error).toMatchObject({
      error_type: 'policy_block',
      recover_with: ['Replace URLs that contain sensitive data and retry.'],
    });
    expect(JSON.stringify(result)).not.toContain(url);
    expect(JSON.stringify(result)).not.toContain('fixture%40example.invalid');
  });

  it('explains sensitive output refusal without suggesting a smaller request', async () => {
    const url = 'https://192.0.2.10/?email=fixture%40example.invalid';
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: url }] });
    const result = await wrapToolWithScanner('test_tool', handler)({ caption: 'safe' }, {
      userId: 'fixture-user',
    } as never);
    expect(result.structuredContent.error).toMatchObject({
      error_type: 'policy_block',
      retryable: false,
      action_may_have_completed: true,
    });
    expect(JSON.stringify(result)).not.toContain(url);
    expect(JSON.stringify(result)).not.toContain('fixture%40example.invalid');
    expect(JSON.stringify(result)).not.toContain('output limit');
  });

  it('preserves an IPv4-hosted media URL through input and output', async () => {
    const url = 'https://192.0.2.10/clip.png?expires=1790000000';
    const original = { content: [{ type: 'text', text: url }] };
    const handler = vi.fn().mockResolvedValue(original);
    const result = await wrapToolWithScanner('test_tool', handler)({ media: url }, {
      userId: 'fixture-user',
    } as never);
    expect(handler).toHaveBeenCalled();
    expect(result).toEqual(original);
  });
  it('does not recommend repeating a completed action when its output reference is blocked', async () => {
    let actions = 0;
    const url = 'https://example.invalid/items/4111111111111111';
    const handler = vi.fn(async () => { actions += 1; return { content: [{ type: 'text', text: url }] }; });
    const result = await wrapToolWithScanner('test_tool', handler)({ caption: 'safe' }, { userId: 'fixture-user' } as never);
    expect(actions).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.structuredContent.error).toMatchObject({ error_type: 'policy_block', retryable: false, action_may_have_completed: true });
    expect(result.structuredContent.error.message).toContain('may already have completed');
    expect(result.structuredContent.error.recover_with).toContain('Do not retry automatically. Check the existing action state or contact support.');
    expect(JSON.stringify(result)).not.toContain(url);
  });

});

describe('authenticated media receipt wrapper', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const projectId = '00000000-0000-4000-8000-000000000002';
  const caller = {userId,projectId};
  const accessKey = 'AKIA' + 'Z'.repeat(16);
  const context = {...caller,token:'synthetic-test-auth',scopes:['mcp:read'],creditsUsed:0,assetsGenerated:0};
  it('never substitutes operator environment identity for authenticated caller context', () => {
    vi.stubEnv('SOCIALNEURON_USER_ID',userId);
    try {
      expect(getVerifiedMediaCaller()).toBeNull();
      expect(requestContext.run({...context,token:''},()=>getVerifiedMediaCaller())).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  function fixture() {
    const now = new Date();
    const date = now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const key = 'org_00000000-0000-4000-8000-000000000003/user_'+userId+'/project_'+projectId+'/images/'+now.toISOString().slice(0,10)+'/file.png';
    const url = 'https://media.example.com/bucket/'+key+'?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential='+accessKey+'%2F'+date.slice(0,8)+'%2Fauto%2Fs3%2Faws4_request&X-Amz-Date='+date+'&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature='+'a'.repeat(64);
    return {url,key,expiresAt:new Date(Date.parse(now.toISOString().slice(0,19)+'Z')+3600000).toISOString()};
  }
  it('returns an issued link without logging its credentials and blocks the same unreceipted link', async () => {
    const issued=fixture();
    const result={content:[{type:'text',text:'Signed URL: '+issued.url+'\nExpires soon'}]};
    expect(registerVerifiedMediaReference(result,{caller,...issued,path:['content',0,'text']})).toBe(true);
    const logScan=vi.fn();
    const wrapped=wrapToolWithScanner('get_media_url',vi.fn().mockResolvedValue(result));
    const returned=await requestContext.run(context,()=>wrapped({}, {logScan}));
    expect(returned).toEqual(result);
    expect(JSON.stringify(logScan.mock.calls)).not.toContain(accessKey);
    const copied=wrapToolWithScanner('get_media_url',vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(result))));
    const rejected=await requestContext.run(context,()=>copied({}));
    expect(rejected.structuredContent.error.error_type).toBe('policy_block');
  });
  it('rejects context mismatches and a copied signed URL in another field', async () => {
    const issued=fixture();
    const result: {content:Array<{type:string;text:string}>;other?:string}={content:[{type:'text',text:issued.url}]};
    expect(registerVerifiedMediaReference(result,{caller,...issued,path:['content',0,'text']})).toBe(true);
    result.other=issued.url;
    const wrapped=wrapToolWithScanner('get_media_url',vi.fn().mockResolvedValue(result));
    expect((await requestContext.run(context,()=>wrapped({}))).isError).toBe(true);
    delete (result as {other?:string}).other;
    const otherContext={...context,projectId:'00000000-0000-4000-8000-000000000004'};
    expect((await requestContext.run(otherContext,()=>wrapped({}))).isError).toBe(true);
  });
});

describe('nonretryable output refusals', () => {
  it.each([
    ['numeric privacy failure', {structuredContent:{card:4111111111111111}}],
    ['serialization failure', {structuredContent:{count:1n}}],
    ['oversized output', {content:[{type:'text',text:'x'.repeat(1_000_001)}]}],
  ])('does not encourage repeating a completed action after %s', async (_name,result) => {
    const handler=vi.fn().mockResolvedValue(result);
    const wrapped=wrapToolWithScanner('schedule_post',handler);
    const response=await wrapped({});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(true);
    expect(response.structuredContent.error.retryable).toBe(false);
    expect(response.structuredContent.error.action_may_have_completed).toBe(true);
    expect(response.structuredContent.error.recover_with.join(' ')).toContain('Do not retry automatically');
  });
});
