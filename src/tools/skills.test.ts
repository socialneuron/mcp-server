/**
 * Tests for skills MCP tools (list_skills, get_skill, run_skill).
 *
 * Mocks the MCP server to capture tool handlers, then invokes them
 * directly. No network — the manifest is in-process.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSkillsTools } from "./skills.js";
import { callEdgeFunction } from "../lib/edge-function.js";

const mockCallEdge = vi.mocked(callEdgeFunction);

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function makeMockServer() {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: CapturedTool["handler"],
      ) => {
        tools.set(name, { name, description, schema, handler });
      },
    ),
  };
  return { server, tools };
}

describe("registerSkillsTools", () => {
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCallEdge.mockResolvedValue({ data: null, error: null });
    mock = makeMockServer();
    // The first argument to server.tool is the McpServer instance — we cast to any
    // because the mock is a minimal duck-typed stand-in.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSkillsTools(mock.server as any);
  });

  it("registers list_skills, get_skill, and run_skill", () => {
    expect(mock.tools.has("list_skills")).toBe(true);
    expect(mock.tools.has("get_skill")).toBe(true);
    expect(mock.tools.has("run_skill")).toBe(true);
  });

  describe("list_skills", () => {
    it("merges live guide rows with executable workflows", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          skills: [
            {
              slug: "tiktok-content",
              kind: "platform",
              platform: "tiktok",
              model_id: null,
              tier_minimum: "free",
              frontmatter: { description: "How to win on TikTok" },
              updated_at: "2026-07-13T00:00:00Z",
              body_chars: 4231,
              locked: false,
            },
          ],
        },
        error: null,
      });
      const result = await mock.tools.get("list_skills")!.handler({});
      expect(result.content[0].text).toContain("tiktok-content");
      expect(result.content[0].text).toContain(
        'get_skill(slug: "tiktok-content")',
      );
      expect(result.content[0].text).toContain(
        "skill-brand-locked-viral-hook-reel",
      );
      expect(result.content[0].text).toContain("GUIDES —");
      expect(result.content[0].text).toContain("WORKFLOWS —");
      expect(mockCallEdge).toHaveBeenCalledWith("mcp-data", {
        action: "get-skills",
      });
    });

    it("does not leak unrelated guides into a studio-filtered workflow list", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          skills: [
            {
              slug: "tiktok-content",
              kind: "platform",
              platform: "tiktok",
              model_id: null,
              tier_minimum: "free",
              frontmatter: { description: "How to win on TikTok" },
              updated_at: null,
              body_chars: 100,
              locked: false,
            },
          ],
        },
        error: null,
      });

      const result = await mock.tools
        .get("list_skills")!
        .handler({ studio: "video" });
      expect(result.content[0].text).not.toContain("tiktok-content");
      expect(result.content[0].text).toContain("WORKFLOWS —");
    });

    it("returns the manifest as text by default", async () => {
      const tool = mock.tools.get("list_skills")!;
      const result = await tool.handler({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(
        "skill-brand-locked-viral-hook-reel",
      );
      expect(result.content[0].text).toContain("Brand-locked viral hook reel");
      expect(result.content[0].text).toContain(
        "Inspired by: MrBeast, Alex Hormozi",
      );
    });

    it("returns JSON when response_format=json", async () => {
      const tool = mock.tools.get("list_skills")!;
      const result = await tool.handler({ response_format: "json" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.count).toBeGreaterThanOrEqual(1);
      expect(parsed.data.skills[0].id).toBe(
        "skill-brand-locked-viral-hook-reel",
      );
      expect(parsed._meta.version).toBeDefined();
    });

    it("filters by studio", async () => {
      const tool = mock.tools.get("list_skills")!;
      const videoResult = await tool.handler({
        studio: "video",
        response_format: "json",
      });
      const videoParsed = JSON.parse(videoResult.content[0].text);
      expect(videoParsed.data.count).toBeGreaterThanOrEqual(1);
      for (const s of videoParsed.data.skills) {
        expect(s.studio).toBe("video");
      }

      const carouselResult = await tool.handler({
        studio: "carousel",
        response_format: "json",
      });
      const carouselParsed = JSON.parse(carouselResult.content[0].text);
      expect(carouselParsed.data.count).toBe(0);
    });

    it("featured_only narrows results", async () => {
      const tool = mock.tools.get("list_skills")!;
      const result = await tool.handler({
        featured_only: true,
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);
      for (const s of parsed.data.skills) {
        expect(s.featured).toBe(true);
      }
    });

    it("returns a helpful empty message when filter has no matches", async () => {
      const tool = mock.tools.get("list_skills")!;
      const result = await tool.handler({ studio: "voice" });
      expect(result.content[0].text).toMatch(/No skills match/);
      expect(result.content[0].text).toMatch(/Available studios/);
    });
  });

  describe("get_skill", () => {
    const detail = {
      slug: "tiktok-content",
      kind: "platform",
      platform: "tiktok",
      tier_minimum: "free",
      frontmatter: { description: "How to win on TikTok" },
      body: "# TikTok Content\n\nAct on this document top-to-bottom.",
      compiled_section: "Short hooks beat long intros.",
      recipe_slug: null,
      version: 1,
      updated_at: "2026-07-13T00:00:00Z",
      locked: false,
    };

    it("returns the skill body and compiled section", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { skill: detail },
        error: null,
      });
      const result = await mock.tools
        .get("get_skill")!
        .handler({ slug: "tiktok-content" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("TikTok Content");
      expect(result.content[0].text).toContain("What's working now");
      expect(result.content[0].text).toContain("Short hooks beat long intros.");
      expect(mockCallEdge).toHaveBeenCalledWith("mcp-data", {
        action: "get-skill",
        slug: "tiktok-content",
      });
    });

    it("returns a JSON envelope", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { skill: detail },
        error: null,
      });
      const result = await mock.tools.get("get_skill")!.handler({
        slug: "tiktok-content",
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.slug).toBe("tiktok-content");
      expect(parsed._meta.version).toBeDefined();
    });

    it("returns an error for a missing skill or Edge Function failure", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { skill: null },
        error: null,
      });
      const missing = await mock.tools
        .get("get_skill")!
        .handler({ slug: "missing" });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain("No skill found");

      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: "upstream unavailable",
      });
      const failed = await mock.tools
        .get("get_skill")!
        .handler({ slug: "tiktok-content" });
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain(
        "skill catalogue could not be loaded",
      );
      expect(failed.content[0].text).not.toContain("upstream unavailable");
    });

    it("does not expose a locked skill body", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          skill: {
            ...detail,
            locked: true,
            tier_minimum: "agency",
            body: "paid guide body must stay private",
            compiled_section: "paid performance data must stay private",
          },
        },
        error: null,
      });
      const result = await mock.tools
        .get("get_skill")!
        .handler({ slug: "tiktok-content" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("permission_denied");
      expect(result.content[0].text).not.toContain("paid guide body");
      expect(result.content[0].text).not.toContain("paid performance data");
    });
  });

  describe("run_skill", () => {
    it("returns isError=true for unknown skill_id", async () => {
      const tool = mock.tools.get("run_skill")!;
      const result = await tool.handler({
        skill_id: "skill-does-not-exist",
        topic: "t",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Unknown skill_id/);
      expect(result.content[0].text).toMatch(/list_skills/);
    });

    it("returns a structured preview for a valid skill_id", async () => {
      const tool = mock.tools.get("run_skill")!;
      const result = await tool.handler({
        skill_id: "skill-brand-locked-viral-hook-reel",
        topic: "why we built SN",
        audience: "first-time founders",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Brand-locked viral hook reel");
      expect(result.content[0].text).toContain("why we built SN");
      expect(result.content[0].text).toContain("first-time founders");
      expect(result.content[0].text).toContain(
        "socialneuron.com/dashboard/creation",
      );
    });

    it("falls back to brand defaults when optional inputs omitted", async () => {
      const tool = mock.tools.get("run_skill")!;
      const result = await tool.handler({
        skill_id: "skill-brand-locked-viral-hook-reel",
        topic: "t",
      });
      expect(result.content[0].text).toContain("(brand persona)");
      expect(result.content[0].text).toContain("(brand default)");
    });

    it("returns JSON envelope when response_format=json", async () => {
      const tool = mock.tools.get("run_skill")!;
      const result = await tool.handler({
        skill_id: "skill-brand-locked-viral-hook-reel",
        topic: "t",
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.status).toBe("preview");
      expect(parsed.data.skill.id).toBe("skill-brand-locked-viral-hook-reel");
      expect(parsed.data.runUrl).toContain(
        "skill-brand-locked-viral-hook-reel",
      );
      expect(parsed._meta.version).toBeDefined();
    });

    it("URL-encodes skill_id in runUrl", async () => {
      const tool = mock.tools.get("run_skill")!;
      const result = await tool.handler({
        skill_id: "skill-brand-locked-viral-hook-reel",
        topic: "t",
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.runUrl).toBe(
        "https://socialneuron.com/dashboard/creation?skill=skill-brand-locked-viral-hook-reel",
      );
    });
  });
});
