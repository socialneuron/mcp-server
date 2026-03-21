import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock validateApiKey before importing middleware
vi.mock("../auth/api-keys.js", () => ({
  validateApiKey: vi.fn(),
}));

vi.mock("../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfter: 0 })),
}));

import {
  apiKeyAuth,
  apiRateLimit,
  requireScope,
  apiError,
  apiSuccess,
  parsePagination,
  type ApiRequest,
} from "./middleware.js";
import { validateApiKey } from "../auth/api-keys.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import type express from "express";

// ── Helpers ─────────────────────────────────────────────────────────

function mockReq(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    headers: {},
    query: {},
    ...overrides,
  } as ApiRequest;
}

function mockRes(): express.Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as express.Response;
  return res;
}

const next = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// ── apiKeyAuth ──────────────────────────────────────────────────────

describe("apiKeyAuth", () => {
  it("rejects requests without Authorization header", async () => {
    const req = mockReq();
    const res = mockRes();
    await apiKeyAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects non-Bearer auth", async () => {
    const req = mockReq({ headers: { authorization: "Basic abc" } as any });
    const res = mockRes();
    await apiKeyAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects invalid API key format", async () => {
    const req = mockReq({
      headers: { authorization: "Bearer not_a_valid_key" } as any,
    });
    const res = mockRes();
    await apiKeyAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_key" }),
    );
  });

  it("rejects invalid API key after validation", async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      valid: false,
      error: "Key expired",
    });

    const req = mockReq({
      headers: { authorization: "Bearer snk_live_test123" } as any,
    });
    const res = mockRes();
    await apiKeyAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("sets apiAuth on successful validation", async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      valid: true,
      userId: "user-123",
      scopes: ["mcp:full"],
      email: "test@test.com",
    });

    const req = mockReq({
      headers: { authorization: "Bearer snk_live_test123" } as any,
    });
    const res = mockRes();
    await apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiAuth).toEqual({
      userId: "user-123",
      scopes: ["mcp:full"],
      email: "test@test.com",
    });
  });
});

// ── apiRateLimit ────────────────────────────────────────────────────

describe("apiRateLimit", () => {
  it("allows requests when rate limit not exceeded", () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, retryAfter: 0 });

    const middleware = apiRateLimit("read");
    const req = mockReq();
    req.apiAuth = { userId: "user-1", scopes: ["mcp:full"], email: "a@b.com" };
    const res = mockRes();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects with 429 when rate limited", () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfter: 30 });

    const middleware = apiRateLimit("posting");
    const req = mockReq();
    req.apiAuth = { userId: "user-1", scopes: ["mcp:full"], email: "a@b.com" };
    const res = mockRes();

    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "30");
    expect(next).not.toHaveBeenCalled();
  });
});

// ── requireScope ────────────────────────────────────────────────────

describe("requireScope", () => {
  it("allows request with matching scope", () => {
    const middleware = requireScope("mcp:read");
    const req = mockReq();
    req.apiAuth = { userId: "u1", scopes: ["mcp:read"], email: "a@b.com" };
    const res = mockRes();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows mcp:full for any scope", () => {
    const middleware = requireScope("mcp:write");
    const req = mockReq();
    req.apiAuth = { userId: "u1", scopes: ["mcp:full"], email: "a@b.com" };
    const res = mockRes();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects with 403 for insufficient scope", () => {
    const middleware = requireScope("mcp:write");
    const req = mockReq();
    req.apiAuth = { userId: "u1", scopes: ["mcp:read"], email: "a@b.com" };
    const res = mockRes();

    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects with 401 when not authenticated", () => {
    const middleware = requireScope("mcp:read");
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

describe("apiError", () => {
  it("returns structured error object", () => {
    const err = apiError(400, "bad_request", "Missing field");
    expect(err).toEqual({
      error: "bad_request",
      error_description: "Missing field",
      status: 400,
    });
  });

  it("includes retry_after when provided", () => {
    const err = apiError(429, "rate_limited", "Slow down", 30);
    expect(err.retry_after).toBe(30);
  });
});

describe("apiSuccess", () => {
  it("wraps data in envelope with _meta", () => {
    const result = apiSuccess({ foo: "bar" });
    expect(result._meta.version).toBeDefined();
    expect(result._meta.timestamp).toBeDefined();
    expect(result.data).toEqual({ foo: "bar" });
  });
});

describe("parsePagination", () => {
  it("returns defaults when no params", () => {
    const req = mockReq({ query: {} });
    const { limit, offset } = parsePagination(req);
    expect(limit).toBe(50);
    expect(offset).toBe(0);
  });

  it("respects provided values", () => {
    const req = mockReq({ query: { limit: "20", offset: "10" } });
    const { limit, offset } = parsePagination(req);
    expect(limit).toBe(20);
    expect(offset).toBe(10);
  });

  it("caps limit at maxLimit", () => {
    const req = mockReq({ query: { limit: "999" } });
    const { limit } = parsePagination(req, 50);
    expect(limit).toBe(50);
  });

  it("floors offset at 0", () => {
    const req = mockReq({ query: { offset: "-5" } });
    const { offset } = parsePagination(req);
    expect(offset).toBe(0);
  });
});
