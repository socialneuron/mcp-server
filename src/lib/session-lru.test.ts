import { describe, expect, it } from 'vitest';
import { findOldestIdleSessionId, type SessionUsage } from './session-lru.js';

describe('findOldestIdleSessionId', () => {
  it('selects the least-recently-used idle session for one user', () => {
    const sessions = new Map<string, SessionUsage>([
      ['other-old', { userId: 'other', lastActivity: 1, activeRequests: 0 }],
      ['user-new', { userId: 'user-1', lastActivity: 30, activeRequests: 0 }],
      ['user-old', { userId: 'user-1', lastActivity: 10, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions, 'user-1')).toBe('user-old');
  });

  it('never selects a session with an active request or SSE stream', () => {
    const sessions = new Map<string, SessionUsage>([
      ['active-old', { userId: 'user-1', lastActivity: 1, activeRequests: 1 }],
      ['idle-new', { userId: 'user-1', lastActivity: 20, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions, 'user-1')).toBe('idle-new');
  });

  it('returns null when every matching session is active', () => {
    const sessions = new Map<string, SessionUsage>([
      ['active', { userId: 'user-1', lastActivity: 1, activeRequests: 2 }],
      ['other-idle', { userId: 'user-2', lastActivity: 1, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions, 'user-1')).toBeNull();
  });

  it('can select the global oldest idle session without a user filter', () => {
    const sessions = new Map<string, SessionUsage>([
      ['newer', { userId: 'user-1', lastActivity: 20, activeRequests: 0 }],
      ['oldest', { userId: 'user-2', lastActivity: 5, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions)).toBe('oldest');
  });
});
