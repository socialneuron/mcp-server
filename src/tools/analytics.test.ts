import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockServer } from "../test-setup.js";
import { registerAnalyticsTools } from "./analytics.js";
import { callEdgeFunction } from "../lib/edge-function.js";
import { MCP_VERSION } from "../lib/version.js";
import { getSupabaseClient, getDefaultUserId } from "../lib/supabase.js";

const mockCallEdge = vi.mocked(callEdgeFunction);
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

describe("analytics tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAnalyticsTools(server as any);
  });

  // =========================================================================
  // fetch_analytics
  // =========================================================================
  describe("fetch_analytics", () => {
    it("returns aggregated analytics from join query", async () => {
      const joinChain = chainMock({
        data: [
          {
            id: "pa1",
            post_id: "p1",
            platform: "youtube",
            views: 1000,
            likes: 50,
            comments: 10,
            shares: 5,
            captured_at: "2026-02-01T12:00:00Z",
            posts: {
              id: "p1",
              title: "My Video",
              platform: "youtube",
              published_at: "2026-01-30T10:00:00Z",
              content_history: {
                content_type: "video",
                model_used: "veo3-fast",
              },
            },
          },
          {
            id: "pa2",
            post_id: "p2",
            platform: "instagram",
            views: 500,
            likes: 30,
            comments: 8,
            shares: 2,
            captured_at: "2026-02-02T15:00:00Z",
            posts: {
              id: "p2",
              title: "Reel Post",
              platform: "instagram",
              published_at: "2026-02-01T09:00:00Z",
              content_history: null,
            },
          },
        ],
        error: null,
      });

      mockGetClient.mockReturnValue({ from: vi.fn(() => joinChain) } as any);
      mockGetUserId.mockResolvedValue("test-user-id");

      const handler = server.getHandler("fetch_analytics")!;
      const result = await handler({});

      const text = result.content[0].text;
      // totalViews = 1000 + 500 = 1500
      expect(text).toContain("1,500");
      // totalEngagement = (50+10+5) + (30+8+2) = 105
      expect(text).toContain("105");
      // Posts Analyzed: 2
      expect(text).toContain("Posts Analyzed: 2");
      // Should contain post titles
      expect(text).toContain("My Video");
      expect(text).toContain("Reel Post");
    });

    it("falls back to simple query when join errors", async () => {
      // First call (join query) returns error
      const joinChain = chainMock({
        data: null,
        error: { message: "join not supported" },
      });

      // Second call (posts lookup) returns post IDs
      const postsChain = chainMock({
        data: [{ id: "p1" }, { id: "p2" }],
        error: null,
      });

      // Third call (simple post_analytics query) returns data
      const simpleChain = chainMock({
        data: [
          {
            id: "pa1",
            post_id: "p1",
            platform: "youtube",
            views: 800,
            likes: 40,
            comments: 5,
            shares: 3,
            captured_at: "2026-02-01T12:00:00Z",
          },
        ],
        error: null,
      });

      let callCount = 0;
      const fromMock = vi.fn((table: string) => {
        if (table === "post_analytics") {
          callCount++;
          // First post_analytics call is the join, second is the fallback
          return callCount === 1 ? joinChain : simpleChain;
        }
        if (table === "posts") return postsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);
      mockGetUserId.mockResolvedValue("test-user-id");

      const handler = server.getHandler("fetch_analytics")!;
      const result = await handler({});

      const text = result.content[0].text;
      // Should still show results from the fallback
      expect(text).toContain("800");
      // totalEngagement from fallback = 40+5+3 = 48
      expect(text).toContain("48");
      expect(result.isError).toBeUndefined();
    });

    it("returns empty message when no data", async () => {
      const emptyChain = chainMock({ data: [], error: null });
      mockGetClient.mockReturnValue({ from: vi.fn(() => emptyChain) } as any);

      const handler = server.getHandler("fetch_analytics")!;
      const result = await handler({ platform: "tiktok" });

      expect(result.content[0].text).toContain("No analytics data found");
      expect(result.content[0].text).toContain("on tiktok");
    });

    it("aggregates correctly: totalViews = sum(views), totalEngagement = sum(likes+comments+shares)", async () => {
      const joinChain = chainMock({
        data: [
          {
            id: "pa1",
            post_id: "p1",
            platform: "youtube",
            views: 100,
            likes: 10,
            comments: 2,
            shares: 1,
            captured_at: "2026-02-01T12:00:00Z",
            posts: {
              id: "p1",
              title: "A",
              platform: "youtube",
              published_at: "2026-01-30T10:00:00Z",
              content_history: null,
            },
          },
          {
            id: "pa2",
            post_id: "p2",
            platform: "youtube",
            views: 200,
            likes: 20,
            comments: 3,
            shares: null,
            captured_at: "2026-02-02T12:00:00Z",
            posts: {
              id: "p2",
              title: "B",
              platform: "youtube",
              published_at: "2026-01-31T10:00:00Z",
              content_history: null,
            },
          },
          {
            id: "pa3",
            post_id: "p3",
            platform: "youtube",
            views: null,
            likes: null,
            comments: null,
            shares: 5,
            captured_at: "2026-02-03T12:00:00Z",
            posts: {
              id: "p3",
              title: "C",
              platform: "youtube",
              published_at: "2026-02-01T10:00:00Z",
              content_history: null,
            },
          },
        ],
        error: null,
      });

      mockGetClient.mockReturnValue({ from: vi.fn(() => joinChain) } as any);

      const handler = server.getHandler("fetch_analytics")!;
      const result = await handler({});

      const text = result.content[0].text;
      // totalViews = 100 + 200 + 0 = 300
      expect(text).toContain("300");
      // totalEngagement = (10+2+1) + (20+3+0) + (0+0+5) = 41
      expect(text).toContain("41");
      // Posts Analyzed: 3
      expect(text).toContain("Posts Analyzed: 3");
    });

    it("returns JSON envelope when response_format=json", async () => {
      const joinChain = chainMock({
        data: [
          {
            id: "pa1",
            post_id: "p1",
            platform: "youtube",
            views: 100,
            likes: 10,
            comments: 2,
            shares: 1,
            captured_at: "2026-02-01T12:00:00Z",
            posts: {
              id: "p1",
              title: "A",
              platform: "youtube",
              published_at: "2026-01-30T10:00:00Z",
              content_history: null,
            },
          },
        ],
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => joinChain) } as any);

      const handler = server.getHandler("fetch_analytics")!;
      const result = await handler({ response_format: "json" });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed.data.postCount).toBe(1);
      expect(parsed.data.totalViews).toBe(100);
    });
  });

  // =========================================================================
  // refresh_platform_analytics
  // =========================================================================
  describe("refresh_platform_analytics", () => {
    beforeEach(() => {
      mockGetUserId.mockResolvedValue("test-user-id");
    });

    it("calls fetch-analytics and reports queued count", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          postsProcessed: 5,
          results: [
            { postId: "p1", status: "queued" },
            { postId: "p2", status: "queued" },
            { postId: "p3", status: "queued" },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("refresh_platform_analytics")!;
      const result = await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith("fetch-analytics", {
        userId: "test-user-id",
      });
      const text = result.content[0].text;
      expect(text).toContain("Analytics refresh triggered successfully");
      expect(text).toContain("Posts processed: 5");
      expect(text).toContain("Jobs queued: 3");
      expect(text).not.toContain("Errors");
    });

    it("reports errored count when present", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          postsProcessed: 4,
          results: [
            { postId: "p1", status: "queued" },
            { postId: "p2", status: "error" },
            { postId: "p3", status: "queued" },
            { postId: "p4", status: "error" },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("refresh_platform_analytics")!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain("Jobs queued: 2");
      expect(text).toContain("Errors: 2");
    });
  });
});
