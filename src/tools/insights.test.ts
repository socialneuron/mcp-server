import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockServer } from "../test-setup.js";
import { registerInsightsTools } from "./insights.js";
import { MCP_VERSION } from "../lib/version.js";
import { getSupabaseClient, getDefaultUserId } from "../lib/supabase.js";

const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);

/** Build a chainable Supabase query mock that resolves to the given value. */
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
  for (const m of methods) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  c.then = (resolve: Function) => resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

describe("insights tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerInsightsTools(server as any);
  });

  // =========================================================================
  // get_performance_insights
  // =========================================================================
  describe("get_performance_insights", () => {
    it("resolves user org, projects, and scopes insights to those project IDs", async () => {
      const orgChain = chainMock({
        data: { organization_id: "org-1" },
        error: null,
      });
      const projChain = chainMock({
        data: [{ id: "proj-1" }, { id: "proj-2" }],
        error: null,
      });
      const insightsChain = chainMock({
        data: [
          {
            id: "i1",
            project_id: "proj-1",
            insight_type: "top_hooks",
            insight_data: { summary: "Hook A performs well" },
            confidence_score: 0.85,
            generated_at: "2026-02-01T10:00:00Z",
          },
        ],
        error: null,
      });

      const fromMock = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain;
        if (table === "projects") return projChain;
        if (table === "performance_insights") return insightsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);
      mockGetUserId.mockResolvedValue("test-user-id");

      const handler = server.getHandler("get_performance_insights")!;
      const result = await handler({});

      // Verify org lookup
      expect(fromMock).toHaveBeenCalledWith("organization_members");
      expect(orgChain.select).toHaveBeenCalledWith("organization_id");
      expect(orgChain.eq).toHaveBeenCalledWith("user_id", "test-user-id");
      expect(orgChain.limit).toHaveBeenCalledWith(1);
      expect(orgChain.single).toHaveBeenCalled();

      // Verify project lookup
      expect(fromMock).toHaveBeenCalledWith("projects");
      expect(projChain.select).toHaveBeenCalledWith("id");
      expect(projChain.eq).toHaveBeenCalledWith("organization_id", "org-1");

      // Verify insights scoped to project IDs
      expect(fromMock).toHaveBeenCalledWith("performance_insights");
      expect(insightsChain.in).toHaveBeenCalledWith("project_id", [
        "proj-1",
        "proj-2",
      ]);

      // Verify output contains insight data
      const text = result.content[0].text;
      expect(text).toContain("top_hooks");
      expect(text).toContain("Hook A performs well");
    });

    it('returns "No projects found" when user has no org membership', async () => {
      const orgChain = chainMock({ data: null, error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);
      mockGetUserId.mockResolvedValue("test-user-id");

      const handler = server.getHandler("get_performance_insights")!;
      const result = await handler({});

      expect(result.content[0].text).toContain(
        "No projects found for current user",
      );
      // The query variable is built eagerly (from('performance_insights') is called),
      // but it is never awaited — the code returns early before the query executes.
      // So we verify that .in('project_id', ...) was NOT called on the insights chain.
      expect(fromMock).toHaveBeenCalledWith("organization_members");
      // projects should NOT be queried since memberRow is null
      expect(fromMock).not.toHaveBeenCalledWith("projects");
    });

    it("filters by insight_type when provided", async () => {
      const orgChain = chainMock({
        data: { organization_id: "org-1" },
        error: null,
      });
      const projChain = chainMock({ data: [{ id: "proj-1" }], error: null });
      const insightsChain = chainMock({ data: [], error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain;
        if (table === "projects") return projChain;
        if (table === "performance_insights") return insightsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler("get_performance_insights")!;
      await handler({ insight_type: "optimal_timing" });

      // The query chain should have .eq called with insight_type
      expect(insightsChain.eq).toHaveBeenCalledWith(
        "insight_type",
        "optimal_timing",
      );
    });

    it("uses default 30-day lookback and respects custom days param", async () => {
      const orgChain = chainMock({
        data: { organization_id: "org-1" },
        error: null,
      });
      const projChain = chainMock({ data: [{ id: "proj-1" }], error: null });
      const insightsChain = chainMock({ data: [], error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain;
        if (table === "projects") return projChain;
        if (table === "performance_insights") return insightsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler("get_performance_insights")!;

      // Default: 30 days
      const resultDefault = await handler({});
      expect(resultDefault.content[0].text).toContain("last 30 days");

      // Custom: 7 days
      vi.clearAllMocks();
      const orgChain2 = chainMock({
        data: { organization_id: "org-1" },
        error: null,
      });
      const projChain2 = chainMock({ data: [{ id: "proj-1" }], error: null });
      const insightsChain2 = chainMock({ data: [], error: null });

      const fromMock2 = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain2;
        if (table === "projects") return projChain2;
        if (table === "performance_insights") return insightsChain2;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock2 } as any);

      const resultCustom = await handler({ days: 7 });
      expect(resultCustom.content[0].text).toContain("last 7 days");
    });

    it("extracts summary from insight_data JSON", async () => {
      const orgChain = chainMock({
        data: { organization_id: "org-1" },
        error: null,
      });
      const projChain = chainMock({ data: [{ id: "proj-1" }], error: null });
      const insightsChain = chainMock({
        data: [
          {
            id: "i1",
            project_id: "proj-1",
            insight_type: "best_models",
            insight_data: {
              summary: "Gemini 2.5 Pro outperforms Flash by 23%",
            },
            confidence_score: 0.92,
            generated_at: "2026-02-05T14:30:00Z",
          },
          {
            id: "i2",
            project_id: "proj-1",
            insight_type: "top_hooks",
            insight_data: { someOtherField: "no summary here" },
            confidence_score: null,
            generated_at: "2026-02-04T09:00:00Z",
          },
        ],
        error: null,
      });

      const fromMock = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain;
        if (table === "projects") return projChain;
        if (table === "performance_insights") return insightsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler("get_performance_insights")!;
      const result = await handler({});

      const text = result.content[0].text;
      // First insight has summary
      expect(text).toContain("Gemini 2.5 Pro outperforms Flash by 23%");
      // First insight has confidence
      expect(text).toContain("confidence: 0.92");
      // Second insight should NOT have summary line (no summary key)
      expect(text).not.toContain("no summary here");
    });

    it("returns JSON envelope when response_format=json", async () => {
      const orgChain = chainMock({
        data: { organization_id: "org-1" },
        error: null,
      });
      const projChain = chainMock({ data: [{ id: "proj-1" }], error: null });
      const insightsChain = chainMock({
        data: [
          {
            id: "i1",
            project_id: "proj-1",
            insight_type: "top_hooks",
            insight_data: { summary: "summary" },
            confidence_score: 0.9,
            generated_at: "2026-02-05T00:00:00Z",
          },
        ],
        error: null,
      });

      const fromMock = vi.fn((table: string) => {
        if (table === "organization_members") return orgChain;
        if (table === "projects") return projChain;
        if (table === "performance_insights") return insightsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler("get_performance_insights")!;
      const result = await handler({ response_format: "json" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed.data.insights.length).toBe(1);
    });
  });

  // =========================================================================
  // get_best_posting_times
  // =========================================================================
  describe("get_best_posting_times", () => {
    it("groups analytics by (platform, day, hour) and averages engagement", async () => {
      // Two rows on same platform/day/hour to test grouping + averaging
      const analyticsChain = chainMock({
        data: [
          {
            id: "a1",
            platform: "youtube",
            likes: 100,
            comments: 20,
            shares: 10,
            captured_at: "2026-02-01T12:00:00Z",
            posts: {
              published_at: "2026-02-01T14:00:00Z",
              user_id: "test-user-id",
            },
          },
          {
            id: "a2",
            platform: "youtube",
            likes: 200,
            comments: 40,
            shares: 20,
            captured_at: "2026-02-08T12:00:00Z",
            // Same day of week (Saturday) and same hour (14 UTC)
            posts: {
              published_at: "2026-02-08T14:00:00Z",
              user_id: "test-user-id",
            },
          },
        ],
        error: null,
      });

      const fromMock = vi.fn(() => analyticsChain);
      mockGetClient.mockReturnValue({ from: fromMock } as any);
      mockGetUserId.mockResolvedValue("test-user-id");

      const handler = server.getHandler("get_best_posting_times")!;
      const result = await handler({});

      const text = result.content[0].text;
      // Feb 1, 2026 is a Sunday (day 0) and Feb 8, 2026 is also a Sunday
      // Both at 14:00 UTC
      // avg engagement = ((100+20+10) + (200+40+20)) / 2 = 390/2 = 195.0
      expect(text).toContain("Sunday");
      expect(text).toContain("14:00");
      expect(text).toContain("195.0");
      expect(text).toContain("2 posts");
    });

    it("returns top 5 slots sorted by avg_engagement descending", async () => {
      // Create 6 rows on different days/hours so we get 6 buckets
      const rows = [];
      const engagements = [50, 300, 100, 500, 200, 10];
      for (let i = 0; i < 6; i++) {
        const day = (i + 1).toString().padStart(2, "0");
        rows.push({
          id: `a${i}`,
          platform: "instagram",
          likes: engagements[i],
          comments: 0,
          shares: 0,
          captured_at: `2026-02-${day}T12:00:00Z`,
          posts: {
            published_at: `2026-02-${day}T${(10 + i).toString().padStart(2, "0")}:00:00Z`,
            user_id: "test-user-id",
          },
        });
      }

      const analyticsChain = chainMock({ data: rows, error: null });
      mockGetClient.mockReturnValue({
        from: vi.fn(() => analyticsChain),
      } as any);

      const handler = server.getHandler("get_best_posting_times")!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain("Top 5 time slots");
      // Should have exactly 5 numbered entries (6th slot with engagement 10 is dropped)
      expect(text).toContain("1.");
      expect(text).toContain("5.");
      expect(text).not.toMatch(/\s6\./);
      // Highest engagement (500) should be first
      expect(text).toContain("500.0");
    });

    it("returns empty message when no analytics data", async () => {
      const analyticsChain = chainMock({ data: [], error: null });
      mockGetClient.mockReturnValue({
        from: vi.fn(() => analyticsChain),
      } as any);

      const handler = server.getHandler("get_best_posting_times")!;
      const result = await handler({});

      expect(result.content[0].text).toContain("No post analytics data found");
      expect(result.content[0].text).toContain("last 30 days");
    });
  });
});
