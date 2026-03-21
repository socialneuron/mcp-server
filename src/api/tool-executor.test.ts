import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockServer } from "../test-setup.js";
import {
  captureToolHandlers,
  executeToolDirect,
  hasRegisteredTool,
  checkToolScope,
  getToolCatalogForApi,
  getRegisteredToolCount,
} from "./tool-executor.js";

describe("tool-executor", () => {
  describe("captureToolHandlers", () => {
    it("captures handlers during tool registration", () => {
      const server = createMockServer();
      captureToolHandlers(server as any);

      // Register a tool through the wrapped server.tool()
      (server as any).tool("test_tool", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "hello" }],
      }));

      expect(hasRegisteredTool("test_tool")).toBe(true);
    });

    it("preserves original registration", () => {
      const server = createMockServer();
      captureToolHandlers(server as any);

      (server as any).tool("test_tool", "A test tool", {}, async () => ({
        content: [{ type: "text", text: "hello" }],
      }));

      // Original mock server should also have the handler
      expect(server.getHandler("test_tool")).toBeDefined();
    });
  });

  describe("executeToolDirect", () => {
    beforeEach(() => {
      const server = createMockServer();
      captureToolHandlers(server as any);

      // Register tools for testing
      (server as any).tool(
        "echo_tool",
        "Echoes input",
        {},
        async (args: any) => ({
          content: [
            { type: "text", text: JSON.stringify({ echo: args.message }) },
          ],
        }),
      );

      (server as any).tool("text_tool", "Returns plain text", {}, async () => ({
        content: [{ type: "text", text: "Hello, world!" }],
      }));

      (server as any).tool("error_tool", "Always errors", {}, async () => ({
        content: [{ type: "text", text: "Something went wrong" }],
        isError: true,
      }));

      (server as any).tool(
        "throwing_tool",
        "Throws an exception",
        {},
        async () => {
          throw new Error("Unexpected failure");
        },
      );
    });

    it("executes a tool and returns structured JSON data", async () => {
      const result = await executeToolDirect("echo_tool", { message: "test" });

      expect(result.isError).toBe(false);
      expect(result.error).toBeNull();
      expect(result.data).toEqual({ echo: "test" });
      expect(result._meta.tool).toBe("echo_tool");
      expect(result._meta.version).toBeDefined();
      expect(result._meta.timestamp).toBeDefined();
    });

    it("wraps plain text responses", async () => {
      const result = await executeToolDirect("text_tool", {});

      expect(result.isError).toBe(false);
      expect(result.data).toEqual({ text: "Hello, world!" });
    });

    it("handles tool errors (isError flag)", async () => {
      const result = await executeToolDirect("error_tool", {});

      expect(result.isError).toBe(true);
      expect(result.error).toBe("Something went wrong");
      expect(result.data).toBeNull();
    });

    it("handles thrown exceptions", async () => {
      const result = await executeToolDirect("throwing_tool", {});

      expect(result.isError).toBe(true);
      expect(result.error).toBe("Unexpected failure");
      expect(result.data).toBeNull();
    });

    it("returns error for unknown tools", async () => {
      const result = await executeToolDirect("nonexistent_tool", {});

      expect(result.isError).toBe(true);
      expect(result.error).toContain("not found");
    });
  });

  describe("checkToolScope", () => {
    it("allows when user has exact scope", () => {
      const result = checkToolScope("get_credit_balance", ["mcp:read"]);
      expect(result.allowed).toBe(true);
      expect(result.requiredScope).toBe("mcp:read");
    });

    it("allows when user has mcp:full (parent scope)", () => {
      const result = checkToolScope("get_credit_balance", ["mcp:full"]);
      expect(result.allowed).toBe(true);
    });

    it("denies when user lacks required scope", () => {
      const result = checkToolScope("generate_content", ["mcp:read"]);
      expect(result.allowed).toBe(false);
      expect(result.requiredScope).toBe("mcp:write");
    });

    it("denies for unknown tools", () => {
      const result = checkToolScope("nonexistent", ["mcp:full"]);
      expect(result.allowed).toBe(false);
      expect(result.requiredScope).toBeNull();
    });
  });

  describe("getToolCatalogForApi", () => {
    it("only returns tools that have registered handlers", () => {
      // Register a real tool from the catalog
      const server = createMockServer();
      captureToolHandlers(server as any);
      (server as any).tool(
        "get_credit_balance",
        "Check credits",
        {},
        async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      );

      const catalog = getToolCatalogForApi();

      // Should only include registered tools, not the full catalog
      expect(catalog.length).toBeGreaterThanOrEqual(1);
      expect(catalog.every((t) => t.endpoint.startsWith("/v1/tools/"))).toBe(
        true,
      );
      expect(catalog.every((t) => t.method === "POST")).toBe(true);

      // Verify the registered tool appears with enriched fields
      const creditsTool = catalog.find(
        (t) => t.name === "get_credit_balance",
      );
      expect(creditsTool).toBeDefined();
      expect(creditsTool!.endpoint).toBe("/v1/tools/get_credit_balance");
      expect(creditsTool!.module).toBe("credits");
      expect(creditsTool!.scope).toBe("mcp:read");
    });

    it("excludes unregistered tools (e.g. skipped screenshots)", () => {
      // capture_screenshot is in TOOL_CATALOG but not registered
      const catalog = getToolCatalogForApi();
      const screenshot = catalog.find((t) => t.name === "capture_screenshot");
      // It should only be present if it was registered via captureToolHandlers
      if (!hasRegisteredTool("capture_screenshot")) {
        expect(screenshot).toBeUndefined();
      }
    });
  });

  describe("getRegisteredToolCount", () => {
    it("returns count of captured handlers", () => {
      // From the beforeEach in executeToolDirect tests, we registered 4 tools
      // plus any from earlier captureToolHandlers tests
      expect(getRegisteredToolCount()).toBeGreaterThanOrEqual(1);
    });
  });
});
