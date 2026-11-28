/**
 * Contract tests for the multi-client Social Neuron plugin suite (plugins/socialneuron).
 *
 * Covers Cursor, Claude Code, Codex, Grok Bot, and the MCP Registry manifest,
 * plus regression tests for all hardened validator checks.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePlugin as validate } from "../../scripts/validate-plugin.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");

async function fixture(
  mutate: (root: string) => Promise<void>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sn-plugin-"));
  for (const f of [
    ".cursor-plugin",
    ".claude-plugin",
    "plugins",
    "tools.lock.json",
    "package.json",
    "mcp.json",
    "registry",
  ]) {
    await cp(join(REPO_ROOT, f), join(root, f), { recursive: true });
  }
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await cp(
    join(REPO_ROOT, "src/lib/tool-catalog.ts"),
    join(root, "src/lib/tool-catalog.ts"),
  );
  await mutate(root);
  return root;
}

describe("Multi-client Social Neuron plugin contract", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(
      roots.map((r) => rm(r, { recursive: true, force: true })),
    );
  });

  it("the checked-in plugin validates with zero errors", async () => {
    const { errors } = await validate(REPO_ROOT);
    expect(errors).toEqual([]);
  });

  it("runs cleanly from an unrelated cwd via import.meta.url default root", () => {
    const out = execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "validate-plugin.mjs")],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    expect(out).toContain("plugin OK");
  });

  it("rejects an mcp.json that is not url-only", async () => {
    const root = await fixture(async (r) => {
      await writeFile(
        join(r, "plugins/socialneuron/mcp.json"),
        JSON.stringify({
          mcpServers: {
            socialneuron: {
              type: "http",
              url: "https://mcp.socialneuron.com/mcp",
            },
          },
        }),
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("mcp.json") && e.includes("type")),
    ).toBe(true);
  });

  it("rejects a skill that names a tool missing from tools.lock.json", async () => {
    const root = await fixture(async (r) => {
      const dir = join(r, "plugins/socialneuron/skills/sn-bogus");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: sn-bogus\ndescription: A skill used only by the validator test to prove unknown tool names are caught.\n---\n\nCall `publish_everything_now` first.\n",
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some(
        (e) =>
          e.includes("unknown tool") && e.includes("publish_everything_now"),
      ),
    ).toBe(true);
  });

  it("rejects localOnly tools inside plugin skills or docs", async () => {
    const root = await fixture(async (r) => {
      const dir = join(r, "plugins/socialneuron/skills/sn-local");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: sn-local\ndescription: A skill used only by the validator test to prove localOnly tools are blocked.\n---\n\nCall `capture_app_page` first.\n",
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some(
        (e) =>
          e.includes("capture_app_page") && e.includes("localOnly/internal"),
      ),
    ).toBe(true);
  });

  it("rejects credentials, Gmail addresses, and local paths in the plugin", async () => {
    const key = ["snk_live_", "abcdefghijklmnop"].join("");
    const mailbox = ["someone", "@", "gmail.com"].join("");
    const localPath = ["/Users", "/someone/x"].join("");
    const root = await fixture(async (r) => {
      await writeFile(
        join(r, "plugins/socialneuron/README.md"),
        `Use ${key} and mail ${mailbox} from ${localPath}\n`,
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    const forbidden = errors.filter((e) => e.includes("forbidden content"));
    expect(forbidden.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects JSON null / primitive manifests instead of crashing", async () => {
    const root = await fixture(async (r) => {
      await writeFile(
        join(r, "plugins/socialneuron/.cursor-plugin/plugin.json"),
        "null",
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("must be a JSON object"))).toBe(true);
  });

  it("rejects non-string array bypasses on length/regex checks", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "plugins/socialneuron/.codex-plugin/plugin.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.interface.shortDescription = new Array(25).fill("x");
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("interface.shortDescription")),
    ).toBe(true);
  });

  it("rejects .codex-plugin shortDescription exceeding 30 characters", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "plugins/socialneuron/.codex-plugin/plugin.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.interface.shortDescription =
        "This short description is definitely longer than thirty characters";
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("interface.shortDescription")),
    ).toBe(true);
  });

  it("rejects unicode-escaped Gmail addresses inside JSON manifests", async () => {
    const gmailDomain = ["gmail", "com"].join(".");
    const escaped = `"team\\u0040${gmailDomain}"`;
    const root = await fixture(async (r) => {
      const file = join(r, ".cursor-plugin/marketplace.json");
      const raw = await readFile(file, "utf8");
      await writeFile(
        file,
        raw.replace('"hello@socialneuron.com"', escaped),
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some(
        (e) =>
          e.includes("marketplace.json") && e.includes("forbidden content"),
      ),
    ).toBe(true);
  });

  it("rejects entry.source traversal", async () => {
    const root = await fixture(async (r) => {
      const mpFile = join(r, ".cursor-plugin/marketplace.json");
      const mp = JSON.parse(await readFile(mpFile, "utf8"));
      mp.plugins[0].source = "./plugins/../plugins/socialneuron";
      await writeFile(mpFile, JSON.stringify(mp));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("source must be a normalized"))).toBe(
      true,
    );
  });

  it("rejects realpath logo symlink escape and walk-time symlinks when source is valid", async () => {
    const root = await fixture(async (r) => {
      await symlink(
        join(r, "tools.lock.json"),
        join(r, "plugins/socialneuron/assets/escape.png"),
      );
      const pluginFile = join(r, "plugins/socialneuron/.cursor-plugin/plugin.json");
      const p = JSON.parse(await readFile(pluginFile, "utf8"));
      p.logo = "assets/escape.png";
      await writeFile(pluginFile, JSON.stringify(p));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("inside the plugin"))).toBe(true);
    expect(
      errors.some((e) => e.includes("symlinks are disallowed inside the plugin")),
    ).toBe(true);
  });

  it("fails closed when src/lib/tool-catalog.ts is missing", async () => {
    const root = await fixture(async (r) => {
      await rm(join(r, "src/lib/tool-catalog.ts"), { force: true });
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("src/lib/tool-catalog.ts is missing")),
    ).toBe(true);
  });

  it("detects localOnly/internal tools in tool-catalog.ts even after nested annotation objects", async () => {
    const root = await fixture(async (r) => {
      await writeFile(
        join(r, "src/lib/tool-catalog.ts"),
        `export const TOOL_CATALOG = [\n  {\n    name: 'nested_local_tool',\n    annotations: { readOnlyHint: true },\n    localOnly: true,\n  },\n];\n`,
      );
      const lock = JSON.parse(await readFile(join(r, "tools.lock.json"), "utf8"));
      if (Array.isArray(lock.tools)) lock.tools.push("nested_local_tool");
      else lock.tools.nested_local_tool = "deadbeef";
      await writeFile(join(r, "tools.lock.json"), JSON.stringify(lock));

      const dir = join(r, "plugins/socialneuron/skills/sn-nested-local");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: sn-nested-local\ndescription: Proves balanced-brace catalog parsing catches localOnly after nested objects.\n---\n\nCall `nested_local_tool` first.\n",
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some(
        (e) =>
          e.includes("nested_local_tool") && e.includes("localOnly/internal"),
      ),
    ).toBe(true);
  });

  it("rejects unicode-escaped Gmail addresses inside walked plugin JSON files", async () => {
    const gmailDomain = ["gmail", "com"].join(".");
    const root = await fixture(async (r) => {
      await writeFile(
        join(r, "plugins/socialneuron/skills/sn-x/extra.json"),
        `{"contact":"team\\u0040${gmailDomain}"}\n`,
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some(
        (e) =>
          e.includes("extra.json") && e.includes("forbidden content"),
      ),
    ).toBe(true);
  });

  it("enforces binary image byte cap without UTF-8 mojibake scanning", async () => {
    const root = await fixture(async (r) => {
      const oversized = Buffer.alloc(600_000, 0x80);
      await writeFile(
        join(r, "plugins/socialneuron/assets/huge.png"),
        oversized,
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("huge.png") && e.includes("512000"))).toBe(
      true,
    );
    expect(errors.some((e) => e.includes("huge.png") && e.includes("forbidden"))).toBe(
      false,
    );
  });

  it("runs validation when invoked through a symlinked script path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sn-cli-link-"));
    roots.push(dir);
    const linkPath = join(dir, "validate-link.mjs");
    await symlink(join(REPO_ROOT, "scripts/validate-plugin.mjs"), linkPath);
    const out = execFileSync(process.execPath, [linkPath, REPO_ROOT], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(out).toContain("plugin OK");
  });

  it("rejects logo paths and component dirs escaping plugin directory", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "plugins/socialneuron/.cursor-plugin/plugin.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.logo = "../../tools.lock.json";
      m.skills = "../../src";
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("logo"))).toBe(true);
    expect(errors.some((e) => e.includes("skills"))).toBe(true);
  });

  it("rejects hooks fields, hooks directories, and script executables inside the plugin", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "plugins/socialneuron/.claude-plugin/plugin.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.hooks = "./hooks.json";
      await writeFile(file, JSON.stringify(m));
      await mkdir(join(r, "plugins/socialneuron/hooks"), { recursive: true });
      await writeFile(join(r, "plugins/socialneuron/hooks/run.sh"), "echo hi\n");
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("hooks are disallowed"))).toBe(true);
    expect(errors.some((e) => e.includes("hooks/ directory is disallowed"))).toBe(
      true,
    );
    expect(
      errors.some((e) => e.includes("executable/script files are disallowed")),
    ).toBe(true);
  });

  it("rejects an empty skills directory", async () => {
    const root = await fixture(async (r) => {
      await rm(join(r, "plugins/socialneuron/skills"), {
        recursive: true,
        force: true,
      });
      await mkdir(join(r, "plugins/socialneuron/skills"), { recursive: true });
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("at least one skill directory")),
    ).toBe(true);
  });

  it("rejects a second poisoned remote in registry/server.json", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "registry/server.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.remotes.push({
        type: "streamable-http",
        url: "https://evil.example.com/mcp",
      });
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("remotes[1]"))).toBe(true);
  });

  it("rejects extra unrelated packages in registry/server.json", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "registry/server.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.packages.push({
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: "@evil/unrelated-pkg",
        version: m.version,
        transport: { type: "stdio" },
      });
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("packages must contain exactly one")),
    ).toBe(true);
  });

  it("rejects unreviewed extra plugins appended to .claude-plugin/marketplace.json", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, ".claude-plugin/marketplace.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.plugins.push({
        name: "rogue-plugin",
        source: "https://evil.example.com/rogue.git",
        description: "Unreviewed remote plugin",
      });
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some((e) => e.includes("unreviewed or mismatched plugin")),
    ).toBe(true);
  });

  it("rejects disallowed oauth scopes in .mcp.json", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "plugins/socialneuron/.mcp.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.mcpServers["socialneuron-hosted"].oauth.scopes.push("mcp:internal");
      await writeFile(file, JSON.stringify(m));
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("mcp:internal"))).toBe(true);
  });

  it("rejects a root .cursor-plugin/plugin.json next to marketplace.json", async () => {
    const root = await fixture(async (r) => {
      await writeFile(
        join(r, ".cursor-plugin/plugin.json"),
        JSON.stringify({ name: "stale" }),
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(errors.some((e) => e.includes("root plugin.json"))).toBe(true);
  });

  it("rejects an unknown tool name inside rules/*.mdc", async () => {
    const root = await fixture(async (r) => {
      const file = join(r, "plugins/socialneuron/rules/socialneuron.mdc");
      await writeFile(
        file,
        (await readFile(file, "utf8")) + "\n- Call `publish_everything_now`.\n",
      );
    });
    roots.push(root);
    const { errors } = await validate(root);
    expect(
      errors.some(
        (e) =>
          e.includes("socialneuron.mdc") &&
          e.includes("publish_everything_now"),
      ),
    ).toBe(true);
  });

  it("write-version.mjs syncs registry, marketplace, and plugin versions from package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "sn-write-version-"));
    roots.push(root);
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(
      join(REPO_ROOT, "scripts/write-version.mjs"),
      join(root, "scripts/write-version.mjs"),
    );
    for (const f of [
      "server.json",
      "registry",
      ".cursor-plugin",
      ".claude-plugin",
      "plugins",
    ]) {
      await cp(join(REPO_ROOT, f), join(root, f), { recursive: true });
    }
    const pkg = JSON.parse(
      await readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { version: string; name: string };
    const bumped = `${pkg.version}-registry-sync-test`;
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ ...pkg, version: bumped }, null, 2),
    );

    execFileSync(process.execPath, [join(root, "scripts/write-version.mjs")]);

    const registry = JSON.parse(
      await readFile(join(root, "registry/server.json"), "utf8"),
    ) as {
      version: string;
      packages: { identifier: string; version: string }[];
    };
    expect(registry.version).toBe(bumped);
    expect(
      registry.packages.find((p) => p.identifier === pkg.name)?.version,
    ).toBe(bumped);

    const cursorPlugin = JSON.parse(
      await readFile(
        join(root, "plugins/socialneuron/.cursor-plugin/plugin.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(cursorPlugin.version).toBe(bumped);

    const claudeMp = JSON.parse(
      await readFile(join(root, ".claude-plugin/marketplace.json"), "utf8"),
    ) as { metadata: { version: string } };
    expect(claudeMp.metadata.version).toBe(bumped);
  });
});
