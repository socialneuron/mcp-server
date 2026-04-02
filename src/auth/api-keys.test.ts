import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateApiKey, type ValidateApiKeyResult } from "./api-keys.js";
import { getSupabaseUrl } from "../lib/supabase.js";

const mockGetUrl = vi.mocked(getSupabaseUrl);

// Save and restore globalThis.fetch so tests don't leak.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUrl.mockReturnValue("https://test.supabase.co");
  // Most tests need an anon key to be available (API key fallback was removed)
  process.env.SUPABASE_ANON_KEY = "eyJ_test_default_anon";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SOCIALNEURON_ANON_KEY;
  delete process.env.VITE_SUPABASE_ANON_KEY;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(status: number, body: unknown, ok?: boolean) {
  const isOk = ok ?? (status >= 200 && status < 300);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: isOk,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  });
}

function mockFetchNetworkError(message: string) {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(message));
}

function mockFetchNonError(value: unknown) {
  globalThis.fetch = vi.fn().mockRejectedValue(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateApiKey", () => {
  it("returns userId, scopes, and expiresAt for a valid key", async () => {
    const validResponse: ValidateApiKeyResult = {
      valid: true,
      userId: "user-abc-123",
      scopes: ["mcp:read", "mcp:write"],
      expiresAt: "2026-12-31T23:59:59Z",
    };
    mockFetchResponse(200, validResponse);

    const result = await validateApiKey("sn_test_key_abc");

    expect(result.valid).toBe(true);
    expect(result.userId).toBe("user-abc-123");
    expect(result.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(result.expiresAt).toBe("2026-12-31T23:59:59Z");
  });

  it("returns valid: false with error for HTTP 401", async () => {
    mockFetchResponse(401, "Unauthorized: invalid API key");

    const result = await validateApiKey("sn_bad_key");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Validation failed");
    expect(result.error).toContain("Unauthorized: invalid API key");
  });

  it("returns valid: false with error for HTTP 500", async () => {
    mockFetchResponse(500, "Internal Server Error");

    const result = await validateApiKey("sn_server_error_key");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Validation failed");
    expect(result.error).toContain("Internal Server Error");
  });

  it("returns valid: false with error message on network failure", async () => {
    mockFetchNetworkError("fetch failed: DNS resolution failed");

    const result = await validateApiKey("sn_network_error_key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("fetch failed: DNS resolution failed");
  });

  it("returns valid: false with stringified value for non-Error rejections", async () => {
    mockFetchNonError("raw string error");

    const result = await validateApiKey("sn_weird_error_key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("raw string error");
  });

  it("returns the parsed JSON body for a valid-but-expired key", async () => {
    const expiredResponse: ValidateApiKeyResult = {
      valid: false,
      error: "API key expired",
    };
    mockFetchResponse(200, expiredResponse);

    const result = await validateApiKey("sn_expired_key");

    // The function trusts the response body; HTTP 200 with valid:false is passed through
    expect(result.valid).toBe(false);
    expect(result.error).toBe("API key expired");
  });

  it("calls the correct URL with correct POST body and headers", async () => {
    mockFetchResponse(200, { valid: true, userId: "u1", scopes: ["mcp:full"] });

    await validateApiKey("sn_my_api_key_value");

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://test.supabase.co/functions/v1/mcp-auth?action=validate-key-public",
    );
    expect(options).toEqual({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer eyJ_test_default_anon",
      },
      body: JSON.stringify({ api_key: "sn_my_api_key_value" }),
    });
  });

  it("uses getSupabaseUrl() for the URL base", async () => {
    mockGetUrl.mockReturnValue("https://custom-project.supabase.co");
    mockFetchResponse(200, { valid: true, userId: "u2", scopes: [] });

    await validateApiKey("sn_key");

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://custom-project.supabase.co/functions/v1/mcp-auth?action=validate-key-public",
    );
  });

  it("uses cloud config anon key when env vars are absent", async () => {
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SOCIALNEURON_ANON_KEY;
    delete process.env.VITE_SUPABASE_ANON_KEY;

    // Pre-populate cloud config cache via fetchCloudConfig
    const { fetchCloudConfig } = await import("../lib/supabase.js");
    // Set env vars temporarily so fetchCloudConfig resolves from env
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key-from-config";
    await fetchCloudConfig();
    // Clear env var so getCloudAnonKey uses cached config
    delete process.env.SUPABASE_ANON_KEY;

    mockFetchResponse(200, {
      valid: true,
      userId: "u-fallback",
      scopes: ["mcp:read"],
    });

    const result = await validateApiKey("sn_test_key_fallback");
    expect(result.valid).toBe(true);
    expect(result.userId).toBe("u-fallback");

    // Verify fetch WAS called with the cached anon key
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0];
    const authHeader = (options as Record<string, Record<string, string>>)
      .headers.Authorization;
    expect(authHeader).toContain("Bearer test-anon-key-from-config");
  });

  it("prefers SUPABASE_ANON_KEY env var for Authorization header", async () => {
    process.env.SUPABASE_ANON_KEY = "eyJ_test_anon_key";
    mockFetchResponse(200, { valid: true, userId: "u4", scopes: ["mcp:read"] });

    await validateApiKey("sn_env_var_key");

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, options] = fetchMock.mock.calls[0];
    const headers = options?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer eyJ_test_anon_key");

    delete process.env.SUPABASE_ANON_KEY;
  });

  it("handles empty string API key without throwing", async () => {
    mockFetchResponse(400, "Missing api_key");

    const result = await validateApiKey("");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("handles non-JSON error response body without throwing", async () => {
    // HTTP 502 with HTML body (common for proxy errors)
    mockFetchResponse(502, "<html>Bad Gateway</html>");

    const result = await validateApiKey("sn_proxy_error");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Validation failed");
    expect(result.error).toContain("Bad Gateway");
  });

  it("preserves all fields from a successful response", async () => {
    const fullResponse: ValidateApiKeyResult = {
      valid: true,
      userId: "user-full",
      scopes: ["mcp:full"],
      email: "admin@socialneuron.com",
      expiresAt: "2027-06-15T00:00:00Z",
    };
    mockFetchResponse(200, fullResponse);

    const result = await validateApiKey("sn_full_key");

    expect(result).toEqual(fullResponse);
  });
});
