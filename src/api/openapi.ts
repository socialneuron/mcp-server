/**
 * OpenAPI 3.1 spec generator.
 *
 * Generates the spec dynamically from the TOOL_CATALOG so it's always
 * in sync with registered tools. Served at GET /v1/openapi.json.
 */

import { TOOL_CATALOG } from "../lib/tool-catalog.js";
import { MCP_VERSION } from "../lib/version.js";

export function generateOpenApiSpec(): Record<string, unknown> {
  // Group tools by module for tag generation
  const modules = [...new Set(TOOL_CATALOG.map((t) => t.module))];

  const toolPaths: Record<string, unknown> = {};
  for (const tool of TOOL_CATALOG) {
    toolPaths[`/v1/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        tags: [tool.module],
        "x-required-scope": tool.scope,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: `Input parameters for ${tool.name}. Pass tool-specific arguments as JSON.`,
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/ToolSuccess" },
          "400": { $ref: "#/components/responses/ToolError" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/InsufficientScope" },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Social Neuron API",
      version: MCP_VERSION,
      description:
        "AI content creation platform — generate, schedule, and analyze social media content across platforms. " +
        "52 tools accessible via REST API, MCP, CLI, or SDK. Same auth, scopes, and credit system across all methods.",
      contact: {
        name: "Social Neuron",
        email: "socialneuronteam@gmail.com",
        url: "https://socialneuron.com/for-developers",
      },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      termsOfService: "https://socialneuron.com/terms",
    },
    servers: [
      {
        url: "https://mcp.socialneuron.com",
        description: "Production",
      },
    ],
    tags: [
      {
        name: "tools",
        description: "Tool discovery and universal tool proxy",
      },
      {
        name: "credits",
        description: "Credit balance and budget tracking",
      },
      {
        name: "brand",
        description: "Brand profile management",
      },
      {
        name: "analytics",
        description: "Performance analytics and insights",
      },
      {
        name: "content",
        description: "Content generation (text, image, video)",
      },
      {
        name: "distribution",
        description: "Post scheduling and publishing",
      },
      {
        name: "posts",
        description: "Post listing and status",
      },
      ...modules.map((m) => ({
        name: m,
        description: `${m} tools (via tool proxy)`,
      })),
    ],
    paths: {
      "/v1/": {
        get: {
          operationId: "getApiInfo",
          summary: "API info and discovery",
          tags: ["tools"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "API metadata",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/v1/tools": {
        get: {
          operationId: "listTools",
          summary: "List available tools with optional filtering",
          tags: ["tools"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "module",
              in: "query",
              schema: { type: "string" },
              description: "Filter by module name",
            },
            {
              name: "scope",
              in: "query",
              schema: { type: "string" },
              description: "Filter by required scope",
            },
            {
              name: "q",
              in: "query",
              schema: { type: "string" },
              description: "Search tools by keyword",
            },
          ],
          responses: {
            "200": {
              description: "Tool catalog",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          tools: {
                            type: "array",
                            items: { $ref: "#/components/schemas/ToolEntry" },
                          },
                          total: { type: "integer" },
                          modules: {
                            type: "array",
                            items: { type: "string" },
                          },
                        },
                      },
                      _meta: { $ref: "#/components/schemas/Meta" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/credits": {
        get: {
          operationId: "getCreditBalance",
          summary: "Get credit balance, plan, and monthly usage",
          tags: ["credits"],
          "x-tool-name": "get_credit_balance",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/credits/budget": {
        get: {
          operationId: "getBudgetStatus",
          summary: "Get per-session budget and spending status",
          tags: ["credits"],
          "x-tool-name": "get_budget_status",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/brand": {
        get: {
          operationId: "getBrandProfile",
          summary: "Get current brand profile",
          tags: ["brand"],
          "x-tool-name": "get_brand_profile",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/analytics": {
        get: {
          operationId: "fetchAnalytics",
          summary: "Fetch post performance analytics",
          tags: ["analytics"],
          "x-tool-name": "fetch_analytics",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/analytics/insights": {
        get: {
          operationId: "getPerformanceInsights",
          summary: "Get AI-generated performance insights",
          tags: ["analytics"],
          "x-tool-name": "get_performance_insights",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/analytics/best-times": {
        get: {
          operationId: "getBestPostingTimes",
          summary: "Get recommended posting times based on audience data",
          tags: ["analytics"],
          "x-tool-name": "get_best_posting_times",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/posts": {
        get: {
          operationId: "listRecentPosts",
          summary: "List recently published or scheduled posts",
          tags: ["posts"],
          "x-tool-name": "list_recent_posts",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 20 },
              description: "Max number of posts to return",
            },
          ],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/accounts": {
        get: {
          operationId: "listConnectedAccounts",
          summary: "List connected social media accounts",
          tags: ["posts"],
          "x-tool-name": "list_connected_accounts",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/content/generate": {
        post: {
          operationId: "generateContent",
          summary: "Generate social media content with AI",
          tags: ["content"],
          "x-tool-name": "generate_content",
          "x-required-scope": "mcp:write",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    topic: {
                      type: "string",
                      description: "Content topic or prompt",
                    },
                    platforms: {
                      type: "array",
                      items: { type: "string" },
                      description: "Target platforms",
                    },
                    tone: { type: "string", description: "Content tone" },
                    content_type: {
                      type: "string",
                      description: "Type of content to generate",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/InsufficientScope" },
          },
        },
      },
      "/v1/content/adapt": {
        post: {
          operationId: "adaptContent",
          summary: "Adapt existing content for different platforms",
          tags: ["content"],
          "x-tool-name": "adapt_content",
          "x-required-scope": "mcp:write",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: {
                      type: "string",
                      description: "Content to adapt",
                    },
                    target_platforms: {
                      type: "array",
                      items: { type: "string" },
                      description: "Target platforms for adaptation",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/InsufficientScope" },
          },
        },
      },
      "/v1/content/video": {
        post: {
          operationId: "generateVideo",
          summary: "Generate video content using AI models",
          tags: ["content"],
          "x-tool-name": "generate_video",
          "x-required-scope": "mcp:write",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    aspect_ratio: { type: "string" },
                    duration: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/InsufficientScope" },
          },
        },
      },
      "/v1/content/image": {
        post: {
          operationId: "generateImage",
          summary: "Generate images using AI models",
          tags: ["content"],
          "x-tool-name": "generate_image",
          "x-required-scope": "mcp:write",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    aspect_ratio: { type: "string" },
                    style: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/InsufficientScope" },
          },
        },
      },
      "/v1/content/status/{jobId}": {
        get: {
          operationId: "checkJobStatus",
          summary: "Check status of async content generation job",
          tags: ["content"],
          "x-tool-name": "check_status",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "jobId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Job ID to check",
            },
          ],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/distribution/schedule": {
        post: {
          operationId: "schedulePost",
          summary: "Schedule or publish content to social platforms",
          tags: ["distribution"],
          "x-tool-name": "schedule_post",
          "x-required-scope": "mcp:distribute",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    media_url: {
                      type: "string",
                      description: "URL of media to post",
                    },
                    caption: {
                      type: "string",
                      description: "Post caption text",
                    },
                    platforms: {
                      type: "array",
                      items: { type: "string" },
                      description: "Target platforms",
                    },
                    schedule_at: {
                      type: "string",
                      format: "date-time",
                      description:
                        "ISO 8601 schedule time (omit for immediate)",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/InsufficientScope" },
          },
        },
      },
      "/v1/loop": {
        get: {
          operationId: "getLoopSummary",
          summary: "Get growth loop summary and optimization recommendations",
          tags: ["analytics"],
          "x-tool-name": "get_loop_summary",
          "x-required-scope": "mcp:read",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { $ref: "#/components/responses/ToolSuccess" },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      // Spread all tool proxy paths
      ...toolPaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "API key from Settings > Developer. Format: snk_live_...",
        },
      },
      schemas: {
        Meta: {
          type: "object",
          properties: {
            tool: { type: "string" },
            version: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        ToolEntry: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            module: { type: "string" },
            scope: { type: "string" },
            endpoint: { type: "string" },
            method: { type: "string" },
          },
        },
        ApiError: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                status: { type: "integer" },
              },
              required: ["code", "message", "status"],
            },
          },
        },
      },
      responses: {
        ToolSuccess: {
          description: "Successful tool execution",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: { type: "object" },
                  _meta: { $ref: "#/components/schemas/Meta" },
                },
              },
            },
          },
        },
        ToolError: {
          description: "Tool execution error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
        },
        Unauthorized: {
          description: "Missing or invalid Bearer token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
        },
        InsufficientScope: {
          description: "API key lacks required scope",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
        },
        NotFound: {
          description: "Tool or resource not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
        },
        RateLimited: {
          description: "Rate limit exceeded",
          headers: {
            "Retry-After": {
              schema: { type: "integer" },
              description: "Seconds to wait before retrying",
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
