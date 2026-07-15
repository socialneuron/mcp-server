import { beforeEach, describe, expect, it, vi } from "vitest";
import { callEdgeFunction } from "./edge-function.js";
import { resolveConnectedAccountRouting } from "./connected-account-routing.js";

const mockCallEdge = vi.mocked(callEdgeFunction);
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("resolveConnectedAccountRouting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attests one exact project-bound account for every publishing provider", async () => {
    const providers = [
      "YouTube",
      "TikTok",
      "Instagram",
      "Twitter",
      "LinkedIn",
      "Facebook",
      "Threads",
      "Bluesky",
    ];
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        accounts: providers.map((platform, index) => ({
          id: `account-${index}`,
          platform,
          project_id: PROJECT_ID,
          status: "active",
        })),
      },
      error: null,
    });

    const result = await resolveConnectedAccountRouting({
      projectId: PROJECT_ID,
      platforms: providers.map((platform) => platform.toLowerCase()),
    });

    expect(result.error).toBeUndefined();
    expect(result.connectedAccountIds).toEqual(
      Object.fromEntries(
        providers.map((platform, index) => [platform, `account-${index}`]),
      ),
    );
    expect(mockCallEdge).toHaveBeenCalledWith(
      "mcp-data",
      {
        action: "connected-accounts",
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
      },
      { timeoutMs: 10_000 },
    );
  });

  it("rejects a requested account returned from another project", async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        accounts: [
          {
            id: "foreign-account",
            platform: "Instagram",
            project_id: "22222222-2222-4222-8222-222222222222",
            status: "active",
          },
        ],
      },
      error: null,
    });

    const result = await resolveConnectedAccountRouting({
      projectId: PROJECT_ID,
      platforms: ["instagram"],
      requestedAccountIds: { instagram: "foreign-account" },
    });

    expect(result.connectedAccountIds).toBeUndefined();
    expect(result.error).toContain("not bound to project_id");
  });

  it("rejects ambiguity but accepts an explicit same-platform account choice", async () => {
    const accounts = ["account-one", "account-two"].map((id) => ({
      id,
      platform: "Instagram",
      project_id: PROJECT_ID,
      status: "active",
    }));
    mockCallEdge.mockResolvedValueOnce({ data: { accounts }, error: null });

    const ambiguous = await resolveConnectedAccountRouting({
      projectId: PROJECT_ID,
      platforms: ["instagram"],
    });
    expect(ambiguous.error).toContain("multiple active accounts");

    mockCallEdge.mockResolvedValueOnce({ data: { accounts }, error: null });
    const selected = await resolveConnectedAccountRouting({
      projectId: PROJECT_ID,
      platforms: ["instagram"],
      requestedAccountIds: { instagram: "account-two" },
    });
    expect(selected.connectedAccountIds).toEqual({ Instagram: "account-two" });
  });

  it("rejects conflicting X and Twitter aliases", async () => {
    const result = await resolveConnectedAccountRouting({
      projectId: PROJECT_ID,
      platforms: ["twitter"],
      requestedAccountIds: { twitter: "account-one", x: "account-two" },
    });

    expect(result.error).toContain("Conflicting account IDs");
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it("fails closed when the account inventory cannot be loaded", async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: null,
      error: "backend unavailable",
    });

    const result = await resolveConnectedAccountRouting({
      projectId: PROJECT_ID,
      platforms: ["youtube"],
    });

    expect(result.connectedAccountIds).toBeUndefined();
    expect(result.error).toContain("backend unavailable");
  });
});
