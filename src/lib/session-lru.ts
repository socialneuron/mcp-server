export interface SessionUsage {
  userId: string;
  lastActivity: number;
  activeRequests: number;
}

/**
 * Select the least-recently-used session that has no request or SSE stream in
 * flight. A user filter keeps per-user reclamation from affecting another
 * account; omitting it supports the bounded global session pool.
 */
export function findOldestIdleSessionId(
  sessions: ReadonlyMap<string, SessionUsage>,
  userId?: string,
): string | null {
  let candidateId: string | null = null;
  let candidateActivity = Number.POSITIVE_INFINITY;

  for (const [sessionId, entry] of sessions) {
    if (userId !== undefined && entry.userId !== userId) continue;
    if (entry.activeRequests > 0) continue;
    if (entry.lastActivity >= candidateActivity) continue;

    candidateId = sessionId;
    candidateActivity = entry.lastActivity;
  }

  return candidateId;
}
