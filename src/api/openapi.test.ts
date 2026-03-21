import { describe, it, expect } from "vitest";
import { generateOpenApiSpec } from "./openapi.js";
import { TOOL_CATALOG } from "../lib/tool-catalog.js";

describe("OpenAPI spec generator", () => {
  const spec = generateOpenApiSpec() as any;

  it("generates valid OpenAPI 3.1 spec", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Social Neuron API");
    expect(spec.info.version).toBeDefined();
  });

  it("includes all convenience endpoints", () => {
    const paths = Object.keys(spec.paths);

    expect(paths).toContain("/v1/");
    expect(paths).toContain("/v1/tools");
    expect(paths).toContain("/v1/credits");
    expect(paths).toContain("/v1/credits/budget");
    expect(paths).toContain("/v1/brand");
    expect(paths).toContain("/v1/analytics");
    expect(paths).toContain("/v1/analytics/insights");
    expect(paths).toContain("/v1/analytics/best-times");
    expect(paths).toContain("/v1/posts");
    expect(paths).toContain("/v1/accounts");
    expect(paths).toContain("/v1/content/generate");
    expect(paths).toContain("/v1/content/adapt");
    expect(paths).toContain("/v1/content/video");
    expect(paths).toContain("/v1/content/image");
    expect(paths).toContain("/v1/content/status/{jobId}");
    expect(paths).toContain("/v1/distribution/schedule");
    expect(paths).toContain("/v1/loop");
  });

  it("generates tool proxy paths for all catalog tools", () => {
    for (const tool of TOOL_CATALOG) {
      const path = `/v1/tools/${tool.name}`;
      expect(spec.paths[path]).toBeDefined();
      expect(spec.paths[path].post.operationId).toBe(tool.name);
      expect(spec.paths[path].post["x-required-scope"]).toBe(tool.scope);
    }
  });

  it("has Bearer auth security scheme", () => {
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe("http");
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("has shared response schemas", () => {
    expect(spec.components.responses.ToolSuccess).toBeDefined();
    expect(spec.components.responses.ToolError).toBeDefined();
    expect(spec.components.responses.Unauthorized).toBeDefined();
    expect(spec.components.responses.InsufficientScope).toBeDefined();
    expect(spec.components.responses.NotFound).toBeDefined();
    expect(spec.components.responses.RateLimited).toBeDefined();
  });

  it("has component schemas", () => {
    expect(spec.components.schemas.Meta).toBeDefined();
    expect(spec.components.schemas.ToolEntry).toBeDefined();
    expect(spec.components.schemas.ApiError).toBeDefined();
  });

  it("marks x-tool-name on convenience endpoints", () => {
    expect(spec.paths["/v1/credits"].get["x-tool-name"]).toBe(
      "get_credit_balance",
    );
    expect(spec.paths["/v1/brand"].get["x-tool-name"]).toBe(
      "get_brand_profile",
    );
    expect(spec.paths["/v1/distribution/schedule"].post["x-tool-name"]).toBe(
      "schedule_post",
    );
  });

  it("includes contact and license info", () => {
    expect(spec.info.contact.email).toBe("socialneuronteam@gmail.com");
    expect(spec.info.license.name).toBe("MIT");
  });

  it("has production server URL", () => {
    expect(spec.servers[0].url).toBe("https://mcp.socialneuron.com");
  });

  it("has tags for all modules", () => {
    const tagNames = spec.tags.map((t: any) => t.name);
    expect(tagNames).toContain("tools");
    expect(tagNames).toContain("credits");
    expect(tagNames).toContain("content");
    expect(tagNames).toContain("distribution");
  });
});
