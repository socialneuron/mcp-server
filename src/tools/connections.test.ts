import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockServer } from "../test-setup.js";
import { registerConnectionTools } from "./connections.js";
import { callEdgeFunction } from "../lib/edge-function.js";

const mockCallEdge = vi.mocked(callEdgeFunction);

describe("connection tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerConnectionTools(server as any);
  });

  // =========================================================================
  // start_platform_connection
  // =========================================================================
  describe("start_platform_connection", () => {
    it("returns deep link + expiry for a valid platform", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          platform: "Instagram",
          expires_at: "2026-04-25T20:00:00.000Z",
          deep_link:
            "https://www.socialneuron.com/settings/connections?start=instagram&t=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
        error: null,
      });

      const handler = server.getHandler("start_platform_connection")!;
      const result = await handler({ platform: "instagram" });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Instagram connection ready");
      expect(result.content[0].text).toContain(
        "https://www.socialneuron.com/settings/connections?start=instagram&t=aaaaaaaa",
      );
      expect(result.content[0].text).toContain("one-time browser setup");
      expect(mockCallEdge).toHaveBeenCalledWith(
        "mcp-data",
        expect.objectContaining({
          action: "mint-connection-nonce",
          platform: "instagram",
        }),
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
    });

    it("returns JSON format with next-step guidance when requested", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          platform: "TikTok",
          expires_at: "2026-04-25T20:00:00.000Z",
          deep_link:
            "https://www.socialneuron.com/settings/connections?start=tiktok&t=xxx",
        },
        error: null,
      });

      const handler = server.getHandler("start_platform_connection")!;
      const result = await handler({
        platform: "tiktok",
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.platform).toBe("TikTok");
      expect(parsed.deep_link).toMatch(/start=tiktok/);
      expect(parsed.next_step).toContain("wait_for_connection");
    });

    it("passes project_id when minting a brand-scoped connection link", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          platform: "Twitter",
          expires_at: "2026-04-25T20:00:00.000Z",
          deep_link:
            "https://www.socialneuron.com/settings/connections?start=twitter&t=xxx",
        },
        error: null,
      });

      const handler = server.getHandler("start_platform_connection")!;
      const result = await handler({
        platform: "twitter",
        project_id: "vpn-project",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Brand/project: vpn-project");
      expect(mockCallEdge).toHaveBeenCalledWith(
        "mcp-data",
        expect.objectContaining({
          action: "mint-connection-nonce",
          platform: "twitter",
          projectId: "vpn-project",
          project_id: "vpn-project",
        }),
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
    });

    it("returns project_id in JSON connection link output", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          platform: "Twitter",
          expires_at: "2026-04-25T20:00:00.000Z",
          deep_link:
            "https://www.socialneuron.com/settings/connections?start=twitter&t=xxx",
        },
        error: null,
      });

      const handler = server.getHandler("start_platform_connection")!;
      const result = await handler({
        platform: "twitter",
        project_id: "vpn-project",
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.project_id).toBe("vpn-project");
    });

    it("surfaces EF errors cleanly", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: "Rate limit exceeded",
      });

      const handler = server.getHandler("start_platform_connection")!;
      const result = await handler({ platform: "youtube" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Failed to start youtube connection",
      );
      expect(result.content[0].text).toContain("Rate limit exceeded");
    });

    it("handles success=false response from EF", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: false,
          nonce: "",
          platform: "",
          expires_at: "",
          deep_link: "",
          error: "Unsupported platform: pinterest",
        },
        error: null,
      });

      const handler = server.getHandler("start_platform_connection")!;
      const result = await handler({ platform: "instagram" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Unsupported platform: pinterest",
      );
    });
  });

  // =========================================================================
  // wait_for_connection
  // =========================================================================
  describe("wait_for_connection", () => {
    beforeEach(() => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => {
        const current = now;
        now += 1_000;
        return current;
      });
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: unknown[]) => void,
        _delay?: number,
        ...args: unknown[]
      ) => {
        queueMicrotask(() => callback(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns connected account on first successful poll", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: "acc-1",
              platform: "Instagram",
              status: "active",
              username: "creator_a",
              created_at: "2026-04-25T19:55:00.000Z",
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("wait_for_connection")!;
      const result = await handler({
        platform: "instagram",
        poll_interval_s: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Instagram is connected");
      expect(result.content[0].text).toContain("creator_a");
    });

    it("returns JSON envelope when connected", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: "acc-2",
              platform: "YouTube",
              status: "active",
              username: null,
              created_at: "2026-04-25T19:55:00.000Z",
              expires_at: null,
              has_refresh_token: false,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("wait_for_connection")!;
      const result = await handler({
        platform: "youtube",
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.connected).toBe(true);
      expect(parsed.platform).toBe("YouTube");
      expect(parsed.account_id).toBe("acc-2");
      expect(parsed.attempts).toBe(1);
    });

    it("passes project_id while polling for a brand-scoped account", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: "acc-brand",
              platform: "Twitter",
              status: "active",
              effective_status: "active",
              username: "thevpnmatrix",
              project_id: "vpn-project",
              created_at: "2026-04-25T19:55:00.000Z",
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("wait_for_connection")!;
      const result = await handler({
        platform: "twitter",
        project_id: "vpn-project",
        poll_interval_s: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Brand/project: vpn-project");
      expect(mockCallEdge).toHaveBeenCalledWith(
        "mcp-data",
        expect.objectContaining({
          action: "connected-accounts",
          projectId: "vpn-project",
          project_id: "vpn-project",
        }),
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
    });

    it("treats inactive accounts as not yet connected", async () => {
      // First poll: inactive row, should keep waiting.
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: "acc-3",
              platform: "Instagram",
              status: "expired",
              username: "creator_b",
              created_at: "2026-04-20T00:00:00.000Z",
              expires_at: "2026-04-21T00:00:00.000Z",
              has_refresh_token: false,
            },
          ],
        },
        error: null,
      });
      // Second poll: now active.
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: "acc-3",
              platform: "Instagram",
              status: "active",
              username: "creator_b",
              created_at: "2026-04-25T19:58:00.000Z",
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("wait_for_connection")!;
      const result = await handler({
        platform: "instagram",
        timeout_s: 10,
        poll_interval_s: 2,
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Instagram is connected");
      expect(mockCallEdge).toHaveBeenCalledTimes(2);
    });

    it("returns timeout message when connection never appears", async () => {
      mockCallEdge.mockResolvedValue({
        data: { success: true, accounts: [] },
        error: null,
      });

      const handler = server.getHandler("wait_for_connection")!;
      const result = await handler({
        platform: "tiktok",
        timeout_s: 5,
        poll_interval_s: 2,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("did not connect within 5s");
      expect(result.content[0].text).toContain("start_platform_connection");
    });

    it("returns timeout JSON envelope", async () => {
      mockCallEdge.mockResolvedValue({
        data: { success: true, accounts: [] },
        error: null,
      });

      const handler = server.getHandler("wait_for_connection")!;
      const result = await handler({
        platform: "youtube",
        timeout_s: 5,
        poll_interval_s: 2,
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(false);
      expect(parsed.timed_out).toBe(true);
      expect(parsed.platform).toBe("youtube");
    });
  });
});
