import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("./supabase.js");
vi.unmock("../lib/supabase.js");

const accessibleProjects: Array<{ id: string; name: string }> = [];
const connectedAccountRows: Array<{
  project_id: string;
  status: string;
  platform?: string;
  user_id?: string;
}> = [];
// The user_id the connected_accounts query is scoped to for the CURRENT
// call — captured by the `.eq('user_id', ...)` mock below so tests can
// assert the query was actually user-scoped (the P1 fix under test).
let lastConnectedAccountsEqUserId: string | undefined;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "organization_members") {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(async () => ({
            data: [{ organization_id: "org-a" }],
            error: null,
          })),
        };
        return query;
      }
      if (table === "projects") {
        // getDefaultProjectId chains `.order().limit(2)`; listAccessibleProjectsWithAccountStatus
        // stops at `.order()` and awaits it directly. Support both call shapes: `.order()`
        // returns an object that is itself thenable (resolves the full list) AND still has
        // `.limit(n)` (resolves the sliced list) for the chain that keeps going.
        const query = {
          select: vi.fn(() => query),
          in: vi.fn(() => query),
          order: vi.fn(() => ({
            then: (
              resolve: (v: {
                data: typeof accessibleProjects;
                error: null;
              }) => void,
            ) => resolve({ data: accessibleProjects, error: null }),
            limit: vi.fn(async (n: number) => ({
              data: accessibleProjects.slice(0, n),
              error: null,
            })),
          })),
        };
        return query;
      }
      if (table === "connected_accounts") {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn((_col: string, value: string) => {
            lastConnectedAccountsEqUserId = value;
            // Scope the mocked rows exactly like the real query would —
            // this is what makes a teammate-owned row invisible once the
            // `.eq('user_id', ...)` predicate is present.
            return {
              in: vi.fn(async () => ({
                data: connectedAccountRows.filter(
                  (r) => (r.user_id ?? "user-a") === value,
                ),
                error: null,
              })),
            };
          }),
          in: vi.fn(async () => ({ data: connectedAccountRows, error: null })),
        };
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  })),
}));

describe("MCP default project isolation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    accessibleProjects.splice(0);
    connectedAccountRows.splice(0);
    process.env.SOCIALNEURON_SUPABASE_URL = "https://example.supabase.co";
    process.env.SOCIALNEURON_SERVICE_KEY = "service-key";
    process.env.SOCIALNEURON_USER_ID = "user-a";
    delete process.env.SOCIALNEURON_PROJECT_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("auto-resolves the sole accessible brand", async () => {
    accessibleProjects.push({ id: "project-only", name: "Only Brand" });
    const { getDefaultProjectId } = await import("./supabase.js");

    await expect(getDefaultProjectId()).resolves.toBe("project-only");
  });

  it("returns no default when an unscoped MCP user has multiple brands", async () => {
    accessibleProjects.push(
      { id: "project-a", name: "Brand A" },
      { id: "project-b", name: "Brand B" },
    );
    const { getDefaultProjectId } = await import("./supabase.js");

    await expect(getDefaultProjectId()).resolves.toBeNull();
  });

  // ===========================================================================
  // resolveProjectForConnectedAccountTool (F1, 2026-07-15)
  //
  // getDefaultProjectId (above) stays strict — this is the ONE additional
  // auto-resolve layered on top, scoped to the connected-account-requiring
  // tools, and it must still never guess when genuinely ambiguous.
  // ===========================================================================
  describe("resolveProjectForConnectedAccountTool", () => {
    it("passes an explicit project_id straight through without any DB call", async () => {
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result =
        await resolveProjectForConnectedAccountTool("explicit-project");

      expect(result).toEqual({ projectId: "explicit-project" });
    });

    it("defers to getDefaultProjectId when there is a sole accessible brand", async () => {
      accessibleProjects.push({ id: "project-only", name: "Only Brand" });
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      expect(result.projectId).toBe("project-only");
      expect(result.autoResolvedNote).toBeUndefined();
    });

    it("auto-resolves to the ONE project that owns an active connected account, with a note", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      connectedAccountRows.push({ project_id: "project-a", status: "active" });
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      expect(result.projectId).toBe("project-a");
      expect(result.autoResolvedNote).toContain("Brand A");
      expect(result.autoResolvedNote).toContain("project-a");
      expect(result.projects).toHaveLength(2);
    });

    it("treats expires_soon as active for the sole-account-owner auto-resolve", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      connectedAccountRows.push({
        project_id: "project-a",
        status: "expires_soon",
      });
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      expect(result.projectId).toBe("project-a");
    });

    it("fails closed with the project list when TWO projects own active accounts (still ambiguous)", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      connectedAccountRows.push(
        { project_id: "project-a", status: "active" },
        { project_id: "project-b", status: "active" },
      );
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      expect(result.projectId).toBeUndefined();
      expect(result.error).toContain("project_id is required");
      expect(result.error).toContain("Brand A");
      expect(result.error).toContain("Brand B");
      expect(result.projects).toHaveLength(2);
    });

    it("fails closed with the project list when ZERO projects own an active account (never guesses)", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      // connectedAccountRows stays empty — neither project has any account.
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      expect(result.projectId).toBeUndefined();
      expect(result.error).toContain("project_id is required");
      expect(result.projects).toHaveLength(2);
    });

    // =========================================================================
    // P1 fix (a): a teammate's account in another project must NOT count
    // =========================================================================
    it("a TEAMMATE-owned account in the other project does not manufacture a sole-candidate (P1 fix)", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      // project-b's account belongs to a different user in the same org —
      // before the fix, the missing `.eq('user_id', ...)` predicate made
      // this count toward "project-b has an account", wrongly producing a
      // sole-candidate auto-resolve to project-b for user-a.
      connectedAccountRows.push({
        project_id: "project-b",
        status: "active",
        platform: "instagram",
        user_id: "user-b",
      });
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      // Neither project has an account OWNED BY user-a, so this must fail
      // closed with both projects listed — never auto-resolve to project-b.
      expect(result.projectId).toBeUndefined();
      expect(result.error).toContain("project_id is required");
      expect(result.projects).toHaveLength(2);
      expect(lastConnectedAccountsEqUserId).toBe("user-a");
    });

    it("a teammate's account does not break YOUR OWN sole-candidate resolution either", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      // user-a owns an account in project-a; a teammate (user-b) also owns
      // one in project-b. If user scoping were missing, this would look like
      // TWO projects have accounts (ambiguous) instead of exactly one for user-a.
      connectedAccountRows.push(
        {
          project_id: "project-a",
          status: "active",
          platform: "instagram",
          user_id: "user-a",
        },
        {
          project_id: "project-b",
          status: "active",
          platform: "tiktok",
          user_id: "user-b",
        },
      );
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool();

      expect(result.projectId).toBe("project-a");
      expect(result.autoResolvedNote).toContain("project-a");
    });

    // =========================================================================
    // Platform-aware sole-project resolution
    // =========================================================================
    it("is platform-aware: a project with only an UNRELATED platform account does not count", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      // project-a only has a YouTube account; the caller is resolving for Instagram.
      connectedAccountRows.push({
        project_id: "project-a",
        status: "active",
        platform: "youtube",
      });
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool(
        undefined,
        "instagram",
      );

      expect(result.projectId).toBeUndefined();
      expect(result.error).toContain("project_id is required");
    });

    it("is platform-aware: auto-resolves to the ONE project with a usable account for the REQUESTED platform", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      // project-a has an unrelated YouTube account AND the requested Instagram
      // account; project-b has nothing. Only project-a's Instagram account
      // should drive the auto-resolve.
      connectedAccountRows.push(
        { project_id: "project-a", status: "active", platform: "youtube" },
        { project_id: "project-a", status: "active", platform: "instagram" },
      );
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool(
        undefined,
        "instagram",
      );

      expect(result.projectId).toBe("project-a");
      expect(result.autoResolvedNote).toContain("instagram");
    });

    it("is platform-aware over an array of platforms (schedule_post multi-platform)", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      connectedAccountRows.push(
        { project_id: "project-a", status: "active", platform: "twitter" },
        { project_id: "project-b", status: "active", platform: "youtube" },
      );
      const { resolveProjectForConnectedAccountTool } =
        await import("./supabase.js");

      const result = await resolveProjectForConnectedAccountTool(undefined, [
        "instagram",
        "twitter",
      ]);

      expect(result.projectId).toBe("project-a");
    });
  });

  // ===========================================================================
  // resolveProjectStrict (F1-followup, 2026-07-15)
  //
  // start_platform_connection / fetch_analytics / refresh_platform_analytics:
  // "has a connected account" is the WRONG auto-resolve signal for these, so
  // this resolver NEVER widens past getDefaultProjectId()'s sole-accessible-
  // project rule, no matter how the connected_accounts table looks.
  // ===========================================================================
  describe("resolveProjectStrict", () => {
    it("passes an explicit project_id straight through", async () => {
      const { resolveProjectStrict } = await import("./supabase.js");

      const result = await resolveProjectStrict("explicit-project");

      expect(result).toEqual({ projectId: "explicit-project" });
    });

    it("defers to getDefaultProjectId when there is a sole accessible brand", async () => {
      accessibleProjects.push({ id: "project-only", name: "Only Brand" });
      const { resolveProjectStrict } = await import("./supabase.js");

      const result = await resolveProjectStrict();

      expect(result.projectId).toBe("project-only");
    });

    it("NEVER auto-resolves based on connected accounts, even when exactly one project owns one", async () => {
      accessibleProjects.push(
        { id: "project-a", name: "Brand A" },
        { id: "project-b", name: "Brand B" },
      );
      // This is exactly the shape that WOULD auto-resolve under
      // resolveProjectForConnectedAccountTool — resolveProjectStrict must
      // still fail closed, because starting a brand-new connection (or
      // reading historical analytics) must never bind on unrelated
      // existing accounts.
      connectedAccountRows.push({
        project_id: "project-a",
        status: "active",
        platform: "youtube",
      });
      const { resolveProjectStrict } = await import("./supabase.js");

      const result = await resolveProjectStrict();

      expect(result.projectId).toBeUndefined();
      expect(result.error).toContain("project_id is required");
      expect(result.error).toContain("Brand A");
      expect(result.error).toContain("Brand B");
      expect(result.projects).toHaveLength(2);
    });
  });
});
