import type { ResponseEnvelope } from '../types/index.js';

/** Wrap a tool response in the standard envelope with version + timestamp. */
export function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: '0.2.0',
      timestamp: new Date().toISOString(),
    },
    data,
  };
}
