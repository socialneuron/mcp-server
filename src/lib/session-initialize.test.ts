import { describe, expect, it } from 'vitest';
import { isSessionInitializeEnvelope } from './session-initialize.js';

const initializeRequest = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'connector-test', version: '1.0.0' },
  },
};

describe('isSessionInitializeEnvelope', () => {
  it('accepts a direct JSON-RPC initialize request', () => {
    expect(isSessionInitializeEnvelope(initializeRequest)).toBe(true);
  });

  it('accepts a one-item batch containing initialize', () => {
    expect(isSessionInitializeEnvelope([initializeRequest])).toBe(true);
  });

  it.each([
    [],
    [initializeRequest, initializeRequest],
    [initializeRequest, { jsonrpc: '2.0', method: 'notifications/initialized' }],
    { method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    null,
  ])('rejects a non-initialize sessionless envelope without reserving a slot', body => {
    expect(isSessionInitializeEnvelope(body)).toBe(false);
  });
});
