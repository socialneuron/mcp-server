import { describe, it, expect, beforeEach } from 'vitest';
import { buildOpenApiDocument, publicRestToolCount, __resetOpenApiCache } from './openapi.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { TOOL_SCOPES } from '../auth/scopes.js';

describe('buildOpenApiDocument', () => {
  beforeEach(() => __resetOpenApiCache());

  it('is a valid OpenAPI 3.1 document with the right frame', async () => {
    const doc = (await buildOpenApiDocument()) as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Social Neuron REST API');
    expect(doc.servers[0].url).toMatch(/\/v1$/);
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('emits exactly one POST /tools/{name} per public tool', async () => {
    const doc = (await buildOpenApiDocument()) as any;
    const pathKeys = Object.keys(doc.paths);
    expect(pathKeys.length).toBe(publicRestToolCount());
    // Public surface = catalog minus localOnly + internal.
    const expected = TOOL_CATALOG.filter(t => !t.localOnly && !t.internal).length;
    expect(pathKeys.length).toBe(expected);
    for (const k of pathKeys) {
      expect(k).toMatch(/^\/tools\//);
      expect(doc.paths[k].post.operationId).toBe(k.replace('/tools/', ''));
    }
  });

  it('never exposes internal or localOnly tools', async () => {
    const doc = (await buildOpenApiDocument()) as any;
    const internal = TOOL_CATALOG.filter(t => t.internal).map(t => t.name);
    const local = TOOL_CATALOG.filter(t => t.localOnly).map(t => t.name);
    for (const n of [...internal, ...local]) {
      expect(doc.paths[`/tools/${n}`]).toBeUndefined();
    }
    // Spot-check a known internal tool is absent.
    expect(doc.paths['/tools/write_agent_reflection']).toBeUndefined();
    expect(doc.paths['/tools/get_loop_pulse']).toBeUndefined();
    expect(doc.paths['/tools/get_bandit_state']).toBeUndefined();
  });

  it('carries the required scope on each operation', async () => {
    const doc = (await buildOpenApiDocument()) as any;
    const sample = TOOL_CATALOG.find(t => !t.localOnly && !t.internal && TOOL_SCOPES[t.name])!;
    const op = doc.paths[`/tools/${sample.name}`].post;
    expect(op['x-required-scope']).toBe(TOOL_SCOPES[sample.name]);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
  });

  it('defines the ToolError schema with the #188 taxonomy', async () => {
    const doc = (await buildOpenApiDocument()) as any;
    const codes = doc.components.schemas.ToolError.properties.error.properties.error_type.enum;
    expect(codes).toEqual(
      expect.arrayContaining([
        'policy_block',
        'validation_error',
        'permission_denied',
        'billing_error',
        'rate_limited',
        'not_found',
        'upstream_error',
        'server_error',
      ])
    );
    // Error responses reference it.
    const anyOp = Object.values(doc.paths)[0] as any;
    expect(anyOp.post.responses['403'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ToolError'
    );
  });

  it('uses the real input schema as the request body when the tool has params', async () => {
    const doc = (await buildOpenApiDocument()) as any;
    // schedule_post is a known multi-arg tool.
    const op = doc.paths['/tools/schedule_post']?.post;
    if (op) {
      const schema = op.requestBody.content['application/json'].schema;
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });
});
