import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockServer } from "../test-setup.js";
import { registerCommentsTools } from "./comments.js";
import { callEdgeFunction } from "../lib/edge-function.js";
import { MCP_VERSION } from "../lib/version.js";

const mockCallEdge = vi.mocked(callEdgeFunction);
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Queues the mcp-data connected-accounts inventory response the shared
 * routing lib fetches (F3, 2026-07-15). Must be queued BEFORE the test's own
 * mockResolvedValueOnce for the real youtube-comments call, since the
 * routing preflight fetch happens first — even when connected_account_id is
 * supplied explicitly (the routing lib still verifies it belongs to the
 * project and is active).
 */
function mockAccountRouting(accountId = ACCOUNT_ID): void {
  mockCallEdge.mockResolvedValueOnce({
    data: {
      success: true,
      accounts: [
        {
          id: accountId,
          platform: "YouTube",
          project_id: PROJECT_ID,
          status: "active",
        },
      ],
    },
    error: null,
  });
}

describe("comments tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCommentsTools(server as any);
  });

  // =========================================================================
  // list_comments
  // =========================================================================
  describe("list_comments", () => {
    it("truncates text to 120 chars and includes pagination token in output", async () => {
      const longText = "A".repeat(200);

      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: {
          comments: [
            {
              id: "c1",
              videoId: "v1",
              videoTitle: "My Video",
              authorDisplayName: "TestUser",
              authorProfileImageUrl: "https://example.com/avatar.jpg",
              textDisplay: longText,
              textOriginal: longText,
              likeCount: 5,
              publishedAt: "2026-02-01T10:00:00Z",
              replyCount: 2,
            },
          ],
          nextPageToken: "token-abc-123",
        },
        error: null,
      });

      const handler = server.getHandler("list_comments")!;
      const result = await handler({
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        "youtube-comments",
        expect.objectContaining({
          projectId: PROJECT_ID,
          project_id: PROJECT_ID,
          connectedAccountId: ACCOUNT_ID,
        }),
      );

      const text = result.content[0].text;
      // Should truncate to 120 chars + "..."
      expect(text).toContain("A".repeat(120) + "...");
      // Should NOT contain the full 200-char string
      expect(text).not.toContain("A".repeat(121) + '"');
      // Should contain pagination token
      expect(text).toContain("Next page token: token-abc-123");
      // Should contain comment metadata
      expect(text).toContain("[c1]");
      expect(text).toContain("TestUser");
      expect(text).toContain('on "My Video"');
      expect(text).toContain("5 likes");
      expect(text).toContain("2 replies");
    });

    it("returns JSON envelope when response_format=json", async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: {
          comments: [
            {
              id: "c1",
              videoId: "v1",
              authorDisplayName: "TestUser",
              authorProfileImageUrl: "https://example.com/avatar.jpg",
              textDisplay: "Hello",
              textOriginal: "Hello",
              likeCount: 1,
              publishedAt: "2026-02-01T10:00:00Z",
              replyCount: 0,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler("list_comments")!;
      const result = await handler({
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
        response_format: "json",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed.data.comments.length).toBe(1);
    });
  });

  // =========================================================================
  // reply_to_comment
  // =========================================================================
  describe("reply_to_comment", () => {
    it("passes action reply with parentId and text to edge function", async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: {
          comment: { id: "reply-1", textDisplay: "Thanks for the feedback!" },
        },
        error: null,
      });

      const handler = server.getHandler("reply_to_comment")!;
      const result = await handler({
        parent_id: "comment-parent-123",
        text: "Thanks for the feedback!",
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(mockCallEdge).toHaveBeenCalledTimes(2);
      const [fnName, body] = mockCallEdge.mock.calls[1];
      expect(fnName).toBe("youtube-comments");
      expect(body).toEqual({
        action: "reply",
        parentId: "comment-parent-123",
        text: "Thanks for the feedback!",
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        connectedAccountId: ACCOUNT_ID,
      });

      const text = result.content[0].text;
      expect(text).toContain("Reply posted successfully");
      expect(text).toContain("reply-1");
      expect(text).toContain("Thanks for the feedback!");
    });
  });

  describe("post_comment", () => {
    it("passes the immutable project/account tuple to the edge function", async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: { comment: { id: "comment-1", textDisplay: "First" } },
        error: null,
      });

      const result = await server.getHandler("post_comment")!({
        video_id: "video-1",
        text: "First",
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(result.isError).toBeUndefined();
      expect(mockCallEdge).toHaveBeenCalledWith("youtube-comments", {
        action: "post",
        videoId: "video-1",
        text: "First",
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        connectedAccountId: ACCOUNT_ID,
      });
    });
  });

  // =========================================================================
  // moderate_comment
  // =========================================================================
  describe("moderate_comment", () => {
    it("passes action moderate with commentId and moderationStatus to edge function", async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({ data: {}, error: null });

      const handler = server.getHandler("moderate_comment")!;
      const result = await handler({
        comment_id: "spam-comment-456",
        moderation_status: "rejected",
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(mockCallEdge).toHaveBeenCalledTimes(2);
      const [fnName, body] = mockCallEdge.mock.calls[1];
      expect(fnName).toBe("youtube-comments");
      expect(body).toEqual({
        action: "moderate",
        commentId: "spam-comment-456",
        moderationStatus: "rejected",
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        connectedAccountId: ACCOUNT_ID,
      });

      const text = result.content[0].text;
      expect(text).toContain("spam-comment-456");
      expect(text).toContain("rejected");
    });
  });

  // =========================================================================
  // delete_comment
  // =========================================================================
  describe("delete_comment", () => {
    it("returns success message with comment ID", async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({ data: {}, error: null });

      const handler = server.getHandler("delete_comment")!;
      const result = await handler({
        comment_id: "old-comment-789",
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(mockCallEdge).toHaveBeenCalledTimes(2);
      const [fnName, body] = mockCallEdge.mock.calls[1];
      expect(fnName).toBe("youtube-comments");
      expect(body).toEqual({
        action: "delete",
        commentId: "old-comment-789",
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        connectedAccountId: ACCOUNT_ID,
      });

      const text = result.content[0].text;
      expect(text).toContain("old-comment-789");
      expect(text).toContain("deleted successfully");
    });
  });

  // =========================================================================
  // connected_account_id auto-resolve (F3, 2026-07-15)
  // =========================================================================
  describe("connected_account_id auto-resolve", () => {
    it("auto-resolves when exactly one active YouTube account is bound to the project", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: ACCOUNT_ID,
              platform: "YouTube",
              project_id: PROJECT_ID,
              status: "active",
            },
          ],
        },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({ data: {}, error: null });

      const result = await server.getHandler("delete_comment")!({
        comment_id: "old-comment-789",
        project_id: PROJECT_ID,
      });

      expect(result.isError).toBeUndefined();
      expect(mockCallEdge).toHaveBeenCalledTimes(2);
      expect(mockCallEdge.mock.calls[0][0]).toBe("mcp-data");
      const [fnName, body] = mockCallEdge.mock.calls[1];
      expect(fnName).toBe("youtube-comments");
      expect(body).toEqual({
        action: "delete",
        commentId: "old-comment-789",
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        connectedAccountId: ACCOUNT_ID,
      });
    });

    it("fails closed with no active account when the project has zero YouTube accounts", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, accounts: [] },
        error: null,
      });

      const result = await server.getHandler("delete_comment")!({
        comment_id: "old-comment-789",
        project_id: PROJECT_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no active account");
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
      expect(mockCallEdge.mock.calls[0][0]).toBe("mcp-data");
    });

    it("fails closed with a clear ambiguity error when the project has two YouTube accounts", async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: "acct-1",
              platform: "YouTube",
              project_id: PROJECT_ID,
              status: "active",
            },
            {
              id: "acct-2",
              platform: "YouTube",
              project_id: PROJECT_ID,
              status: "active",
            },
          ],
        },
        error: null,
      });

      const result = await server.getHandler("delete_comment")!({
        comment_id: "old-comment-789",
        project_id: PROJECT_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("multiple active accounts");
      expect(result.content[0].text).toContain("exact account ID");
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
    });
  });
});
