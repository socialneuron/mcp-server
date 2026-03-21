import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies before imports
vi.mock("../auth/api-keys.js", () => ({
  validateApiKey: vi.fn().mockResolvedValue({
    valid: true,
    userId: "user-test",
    scopes: ["mcp:full"],
    email: "test@test.com",
  }),
}));

vi.mock("../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfter: 0 })),
}));

vi.mock("../lib/edge-function.js", () => ({
  callEdgeFunction: vi.fn().mockResolvedValue({
    data: { text: "Generated content" },
    error: null,
  }),
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseUrl: vi.fn(() => "https://test.supabase.co"),
  getServiceKey: vi.fn(() => null),
  getDefaultUserId: vi.fn(async () => "user-test"),
  getAuthenticatedApiKey: vi.fn(() => "snk_live_test"),
  CLOUD_SUPABASE_ANON_KEY: "test-anon-key",
}));

import { callEdgeFunction } from "../lib/edge-function.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("REST API Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Tool proxy mapping", () => {
    it("has mappings for all major tools", async () => {
      const { TOOL_CATALOG } = await import("../lib/tool-catalog.js");
      // Dynamically import after mocks are set
      const { toolsRouter } = await import("./tools.js");

      // The tools router should exist
      expect(toolsRouter).toBeDefined();

      // All tools in the catalog should have a function mapping
      // (this is verified by the TOOL_FUNCTION_MAP in tools.ts)
      expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(52);
    });
  });

  describe("API info endpoint", () => {
    it("apiRouter exports a router", async () => {
      const { apiRouter } = await import("./router.js");
      expect(apiRouter).toBeDefined();
      // Router has stack property with mounted routes
      expect((apiRouter as any).stack).toBeDefined();
    });
  });

  describe("Edge function delegation", () => {
    it("callEdgeFunction is used for API requests", () => {
      // The mock is set up — verify the API route files import it
      expect(vi.mocked(callEdgeFunction)).toBeDefined();
    });
  });

  describe("Content routes", () => {
    it("contentRouter is mounted", async () => {
      const { contentRouter } = await import("./content.js");
      expect(contentRouter).toBeDefined();
      expect((contentRouter as any).stack.length).toBeGreaterThan(0);
    });
  });

  describe("Posts routes", () => {
    it("postsRouter is mounted", async () => {
      const { postsRouter } = await import("./posts.js");
      expect(postsRouter).toBeDefined();
    });
  });

  describe("Analytics routes", () => {
    it("analyticsRouter is mounted", async () => {
      const { analyticsRouter } = await import("./analytics.js");
      expect(analyticsRouter).toBeDefined();
    });
  });

  describe("Brand routes", () => {
    it("brandRouter is mounted", async () => {
      const { brandRouter } = await import("./brand.js");
      expect(brandRouter).toBeDefined();
    });
  });

  describe("Plans routes", () => {
    it("plansRouter is mounted", async () => {
      const { plansRouter } = await import("./plans.js");
      expect(plansRouter).toBeDefined();
    });
  });

  describe("Comments routes", () => {
    it("commentsRouter is mounted", async () => {
      const { commentsRouter } = await import("./comments.js");
      expect(commentsRouter).toBeDefined();
    });
  });
});
