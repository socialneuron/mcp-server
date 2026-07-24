import { isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Match exactly the initialization envelopes accepted by the SDK transport.
 * A single initialize request may be sent directly or inside a one-item
 * JSON-RPC batch. Larger batches are invalid during initialization and must be
 * rejected before reserving or reclaiming a session slot.
 */
export function isSessionInitializeEnvelope(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length !== 1) return false;

  const [message] = messages;
  return isJSONRPCRequest(message) && isInitializeRequest(message);
}
