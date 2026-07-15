import { callEdgeFunction } from "./edge-function.js";

interface ConnectedAccountRoute {
  id: string;
  platform: string;
  project_id?: string | null;
  status: string;
  effective_status?: string;
  username?: string | null;
}

interface RoutingResult {
  connectedAccountIds?: Record<string, string>;
  error?: string;
}

const PLATFORM_CASE_MAP: Record<string, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "Twitter",
  x: "Twitter",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  threads: "Threads",
  bluesky: "Bluesky",
};

function canonicalPlatform(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "x" ? "twitter" : normalized;
}

function providerPlatform(value: string): string {
  return PLATFORM_CASE_MAP[canonicalPlatform(value)] ?? value;
}

function isUsable(account: ConnectedAccountRoute): boolean {
  const status = account.effective_status ?? account.status;
  return status === "active" || status === "expires_soon";
}

function normalizeRequestedIds(requested: Record<string, string> | undefined): {
  ids?: Map<string, string>;
  error?: string;
} {
  const ids = new Map<string, string>();
  for (const [platform, accountId] of Object.entries(requested ?? {})) {
    const canonical = canonicalPlatform(platform);
    const existing = ids.get(canonical);
    if (existing && existing !== accountId) {
      return {
        error: `Conflicting account IDs were supplied for ${platform} and its platform alias.`,
      };
    }
    ids.set(canonical, accountId);
  }
  return { ids };
}

/**
 * Resolve one immutable connected-account route for every target platform.
 *
 * This deliberately fails closed when the account inventory cannot be loaded,
 * when a row is not bound to the exact project, or when more than one account
 * is eligible without an explicit choice. The returned map uses provider-case
 * keys because that is the canonical schedule-post contract.
 */
export async function resolveConnectedAccountRouting(input: {
  projectId: string;
  platforms: string[];
  requestedAccountIds?: Record<string, string>;
}): Promise<RoutingResult> {
  const normalizedRequested = normalizeRequestedIds(input.requestedAccountIds);
  if (normalizedRequested.error) return { error: normalizedRequested.error };

  const targetPlatforms = new Set(input.platforms.map(canonicalPlatform));
  for (const requestedPlatform of normalizedRequested.ids?.keys() ?? []) {
    if (!targetPlatforms.has(requestedPlatform)) {
      return {
        error: `An account ID was supplied for untargeted platform ${requestedPlatform}.`,
      };
    }
  }

  const { data, error } = await callEdgeFunction<{
    success?: boolean;
    accounts?: ConnectedAccountRoute[];
    error?: string;
  }>(
    "mcp-data",
    {
      action: "connected-accounts",
      projectId: input.projectId,
      project_id: input.projectId,
    },
    { timeoutMs: 10_000 },
  );

  if (error || !Array.isArray(data?.accounts)) {
    return {
      error: `Connected-account verification failed: ${error ?? data?.error ?? "no account inventory returned"}.`,
    };
  }

  const connectedAccountIds: Record<string, string> = {};
  for (const platform of input.platforms) {
    const canonical = canonicalPlatform(platform);
    const displayPlatform = providerPlatform(platform);
    const platformAccounts = data.accounts.filter(
      (account) =>
        canonicalPlatform(account.platform) === canonical &&
        account.project_id === input.projectId &&
        isUsable(account),
    );
    const requestedId = normalizedRequested.ids?.get(canonical);

    let selected: ConnectedAccountRoute | undefined;
    if (requestedId) {
      selected = data.accounts.find((account) => account.id === requestedId);
      if (!selected) {
        return {
          error: `${displayPlatform}: account ${requestedId} is not available for project_id ${input.projectId}.`,
        };
      }
      if (canonicalPlatform(selected.platform) !== canonical) {
        return {
          error: `${displayPlatform}: account ${requestedId} belongs to ${selected.platform}.`,
        };
      }
      if (selected.project_id !== input.projectId) {
        return {
          error: `${displayPlatform}: account ${requestedId} is not bound to project_id ${input.projectId}.`,
        };
      }
      if (!isUsable(selected)) {
        return {
          error: `${displayPlatform}: account ${requestedId} is ${selected.effective_status ?? selected.status}.`,
        };
      }
    } else if (platformAccounts.length === 1) {
      selected = platformAccounts[0];
    } else if (platformAccounts.length === 0) {
      return {
        error: `${displayPlatform}: no active account is bound to project_id ${input.projectId}.`,
      };
    } else {
      return {
        error:
          `${displayPlatform}: multiple active accounts are bound to project_id ${input.projectId}; ` +
          "pass the exact account ID returned by list_connected_accounts.",
      };
    }

    connectedAccountIds[displayPlatform] = selected.id;
  }

  return { connectedAccountIds };
}
