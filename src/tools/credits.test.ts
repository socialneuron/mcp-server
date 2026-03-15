import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockServer } from "../test-setup.js";
import { registerCreditsTools } from "./credits.js";
import { MCP_VERSION } from "../lib/version.js";
import { getSupabaseClient, getDefaultUserId } from "../lib/supabase.js";

const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);

function chainMock(
  resolvedValue: { data: any; error: any } = { data: [], error: null },
) {
  const c: Record<string, any> = {};
  const methods = [
    "select",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "in",
    "or",
    "not",
    "is",
    "order",
    "limit",
    "range",
    "single",
    "maybeSingle",
    "filter",
    "match",
    "contains",
    "containedBy",
    "insert",
    "update",
    "delete",
    "upsert",
  ];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c.then = (resolve: (value: { data: any; error: any }) => unknown) =>
    resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

describe("credits tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCreditsTools(server as any);
    mockGetUserId.mockResolvedValue("test-user-id");
  });

  // =========================================================================
  // get_credit_balance
  // =========================================================================
  describe("get_credit_balance", () => {
    function setupMocks(
      profileData: { data: any; error: any },
      subData: { data: any; error: any },
    ) {
      const profileChain = chainMock(profileData);
      const subChain = chainMock(subData);
      let callCount = 0;
      mockGetClient.mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === "user_profiles") return profileChain;
          if (table === "subscriptions") return subChain;
          // Fallback by call order for Promise.all
          callCount++;
          return callCount === 1 ? profileChain : subChain;
        }),
      } as any);
    }

    it("returns active subscription credits from user_profiles", async () => {
      setupMocks(
        { data: { credits: 1234, monthly_credits_used: 50 }, error: null },
        {
          data: { tier: "pro", status: "active", monthly_credits: 1500 },
          error: null,
        },
      );

      const handler = server.getHandler("get_credit_balance")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("Plan: pro");
      expect(result.content[0].text).toContain("Balance: 1234");
    });

    it("returns plan free and balance 0 when no data found", async () => {
      setupMocks({ data: null, error: null }, { data: null, error: null });

      const handler = server.getHandler("get_credit_balance")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("Plan: free");
      expect(result.content[0].text).toContain("Balance: 0");
      expect(result.isError).toBeUndefined();
    });

    it("returns isError with message on DB query error", async () => {
      setupMocks(
        { data: null, error: { message: 'column "credits" does not exist' } },
        { data: null, error: null },
      );

      const handler = server.getHandler("get_credit_balance")!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Failed to fetch credit balance",
      );
    });

    it("returns JSON envelope when response_format=json", async () => {
      setupMocks(
        { data: { credits: 500, monthly_credits_used: 100 }, error: null },
        {
          data: { tier: "starter", status: "active", monthly_credits: 500 },
          error: null,
        },
      );

      const handler = server.getHandler("get_credit_balance")!;
      const result = await handler({ response_format: "json" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data.plan).toBe("starter");
      expect(parsed.data.balance).toBe(500);
      expect(parsed.data.monthlyUsed).toBe(100);
      expect(parsed.data.monthlyLimit).toBe(500);
    });

    it("returns correct text format with monthly usage", async () => {
      setupMocks(
        { data: { credits: 9999, monthly_credits_used: 200 }, error: null },
        {
          data: { tier: "business", status: "active", monthly_credits: 5000 },
          error: null,
        },
      );

      const handler = server.getHandler("get_credit_balance")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toMatch(/^Credit Balance\n/);
      expect(text).toContain("Plan: business");
      expect(text).toContain("Balance: 9999");
      expect(text).toContain("Monthly used: 200 / 5000");
      expect(result.isError).toBeUndefined();
    });
  });

  // =========================================================================
  // get_budget_status
  // =========================================================================
  describe("get_budget_status", () => {
    it("returns JSON envelope for budget status", async () => {
      const handler = server.getHandler("get_budget_status")!;
      const result = await handler({ response_format: "json" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed.data).toHaveProperty("creditsUsedThisRun");
    });

    it("returns text format with all budget fields", async () => {
      const handler = server.getHandler("get_budget_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toMatch(/^Budget Status\n/);
      expect(text).toContain("Credits used this run:");
      expect(text).toContain("Credits limit:");
      expect(text).toContain("Credits remaining:");
      expect(text).toContain("Assets generated this run:");
      expect(text).toContain("Asset limit:");
      expect(text).toContain("Assets remaining:");
    });

    it("shows unlimited for limits when max is 0", async () => {
      const handler = server.getHandler("get_budget_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("Credits limit: unlimited");
      expect(text).toContain("Credits remaining: unlimited");
      expect(text).toContain("Asset limit: unlimited");
      expect(text).toContain("Assets remaining: unlimited");
    });

    it("returns correct JSON structure with all budget properties", async () => {
      const handler = server.getHandler("get_budget_status")!;
      const result = await handler({ response_format: "json" });
      const parsed = JSON.parse(result.content[0].text);
      const data = parsed.data;
      expect(data).toHaveProperty("creditsUsedThisRun");
      expect(data).toHaveProperty("maxCreditsPerRun");
      expect(data).toHaveProperty("remaining");
      expect(data).toHaveProperty("assetsGeneratedThisRun");
      expect(data).toHaveProperty("maxAssetsPerRun");
      expect(data).toHaveProperty("remainingAssets");
      expect(typeof data.creditsUsedThisRun).toBe("number");
      expect(typeof data.maxCreditsPerRun).toBe("number");
    });
  });
});
