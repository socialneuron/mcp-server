#!/usr/bin/env node
/**
 * Validates the multi-client Social Neuron plugin suite in this repository.
 *
 * Enforces:
 * - No root `.cursor-plugin/plugin.json` alongside `.cursor-plugin/marketplace.json`
 * - Both `.cursor-plugin/marketplace.json` and `.claude-plugin/marketplace.json` agree on plugins
 * - Root `mcp.json` is url-only pointing at `https://mcp.socialneuron.com/mcp`
 * - `registry/server.json` matches `package.json` (`mcpName`, `version`), validates ALL `remotes[]`
 *   and ALL `packages[]` entries
 * - Every `plugins/*` directory is listed in the marketplaces and includes `.cursor-plugin/plugin.json`,
 *   `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.grok-plugin/plugin.json`,
 *   url-only `mcp.json`, and http `.mcp.json` (with optional least-privilege `oauth.scopes`)
 * - Strict realpath containment on plugin source and all referenced assets/components (no `..` / symlinks)
 * - No hooks directories/fields and no executable script extensions inside `plugins/<name>/`
 * - Non-empty `skills/` directory; every `SKILL.md` validates frontmatter name, string description (30-1024), <=200 body lines
 * - Every backticked snake_case token in skills/rules/README exists in `tools.lock.json` and is NOT `localOnly`/`internal`
 * - Decoded-JSON + raw-text secret/privacy/mailbox/pricing scans (`hello@socialneuron.com` only, no Gmail)
 * - Works from any working directory via `import.meta.url` root resolution when `repoRoot` is omitted
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOSTED_MCP_URL = "https://mcp.socialneuron.com/mcp";
const ALLOWED_EMAIL = "hello@socialneuron.com";
const MAX_TEXT_BYTES = 40_000;
const MAX_IMAGE_BYTES = 512_000;
const MAX_SKILL_BODY_LINES = 200;
const PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MARKETPLACE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HTTPS_URL_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/i;
const IMAGE_EXT_RE = /\.(png|svg|jpe?g|webp)$/i;
const BINARY_IMAGE_EXT_RE = /\.(png|jpe?g|webp|ico)$/i;
const EXECUTABLE_EXT_RE = /\.(?:sh|bash|zsh|js|mjs|cjs|ts|mts|cts|py|rb|pl|php|ps1|bat|cmd|exe|bin|so|dylib)$/i;
const TOOL_TOKEN_RE = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
const ALLOWED_PLUGIN_SCOPES = new Set([
  "mcp:read",
  "mcp:write",
  "mcp:analytics",
  "mcp:distribute",
  "mcp:comments",
]);
const KNOWN_NON_HOSTED_TOOLS = new Set([
  "capture_screenshot",
  "capture_app_page",
]);
// Documented parameter/field/enum names legitimately backticked inside SKILL.md / rules / README.md.
const KNOWN_SKILL_PARAM_TOKENS = new Set([
  "account_id",
  "account_ids",
  "ai_disclosure_delegated",
  "aspect_ratio",
  "auto_slot",
  "brand_context",
  "brand_voice",
  "change_summary",
  "connected_account_id",
  "contains_synthetic_media",
  "content_type",
  "data_driven",
  "dry_run",
  "end_date",
  "expected_scheduled_at",
  "extraction_method",
  "force_refresh",
  "google_trends",
  "hook_family",
  "idempotency_key",
  "image_model",
  "include_preview",
  "is_ai_generated",
  "job_id",
  "job_ids",
  "max_credits",
  "media_type",
  "media_urls",
  "pain_point",
  "parent_id",
  "plan_id",
  "platform_metadata",
  "post_id",
  "posts_per_day",
  "privacy_status",
  "project_id",
  "r2_key",
  "response_format",
  "schedule_at",
  "scheduled_at",
  "slide_count",
  "source_platform",
  "source_url",
  "start_date",
  "target_platform",
  "template_id",
  "url_extract",
  "use_inbox",
  "video_id",
]);

const FORBIDDEN = [
  { re: /\bsnk_(?:live|test)_[A-Za-z0-9]{8,}/g, label: "API key" },
  {
    re: /\bsno_(?:access|refresh)_[A-Za-z0-9_-]{6,}/g,
    label: "connector token",
  },
  {
    re: /\bBearer\s+[A-Za-z0-9._-]{12,}/g,
    label: "bearer token",
  },
  {
    re: /\b(?:sk|pk|rk)-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
    label: "provider key",
  },
  {
    re: /@gmail\.com\b/gi,
    label: "personal webmail address (use hello@socialneuron.com)",
  },
  {
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    label: "mailbox other than hello@socialneuron.com",
    allow: (m) => m.toLowerCase() === ALLOWED_EMAIL,
  },
  {
    re: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)/gm,
    label: "local filesystem path",
  },
  { re: /\$\{env:/g, label: "env placeholder" },
  {
    re: /(?:Starter \(\$29|Starter or above|100 credits\/mo)/gi,
    label: "stale pricing claim",
  },
];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v, min = 1, max = Infinity) {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

function collectJsonStrings(val, out = []) {
  if (typeof val === "string") {
    out.push(val);
  } else if (Array.isArray(val)) {
    for (const item of val) collectJsonStrings(item, out);
  } else if (isPlainObject(val)) {
    for (const k of Object.keys(val)) {
      out.push(k);
      collectJsonStrings(val[k], out);
    }
  }
  return out;
}

async function readJsonObject(file, ctx, errors) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    errors.push(`${ctx} is missing: ${file}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push(`${ctx} is not valid JSON (${file}): ${err.message}`);
    return null;
  }
  if (!isPlainObject(parsed)) {
    errors.push(`${ctx} must be a JSON object`);
    return null;
  }
  return { raw, data: parsed };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function parseFrontmatter(text) {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return null;
  const end = norm.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const fields = {};
  for (const line of norm.slice(4, end).split("\n")) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { fields, body: norm.slice(end + 5) };
}

async function walk(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push({ path: p, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      out.push({ path: p, dir: true });
      await walk(p, out);
    } else {
      out.push({ path: p, dir: false });
    }
  }
  return out;
}

async function containedPath(root, target, { kind }) {
  if (!isNonEmptyString(target) || path.isAbsolute(target)) return null;
  const rootResolved = path.resolve(root);
  const rootReal = await fs.realpath(rootResolved).catch(() => null);
  if (!rootReal) return null;
  const abs = path.resolve(rootResolved, target);
  if (!abs.startsWith(rootResolved + path.sep)) return null;
  try {
    const real = await fs.realpath(abs);
    if (!real.startsWith(rootReal + path.sep)) return null;
    const st = await fs.stat(real);
    if (kind === "file" && !st.isFile()) return null;
    if (kind === "dir" && !st.isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

async function checkAsset(root, value, ctx, errors) {
  if (!isNonEmptyString(value) || path.isAbsolute(value)) {
    errors.push(`${ctx}: must be a relative path inside the plugin`);
    return;
  }
  if (!IMAGE_EXT_RE.test(value)) {
    errors.push(`${ctx}: must be a png/svg/jpg/webp file`);
  }
  if (!(await containedPath(root, value, { kind: "file" }))) {
    errors.push(`${ctx}: must be a regular file inside the plugin (got ${value})`);
  }
}

async function checkContainedComponent(root, value, kind, ctx, errors) {
  if (typeof value === "string") {
    if (!(await containedPath(root, value, { kind }))) {
      errors.push(`${ctx}: path must stay strictly inside plugin (${value})`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      await checkContainedComponent(root, item, kind, ctx, errors);
    }
    return;
  }
  errors.push(`${ctx}: component path must be a relative string or string array`);
}

function scanStringForForbidden(rel, text, errors, seen = new Set()) {
  for (const rule of FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (rule.allow?.(m[0])) continue;
      const key = `${rel}:${rule.label}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push(`${rel}: forbidden content (${rule.label})`);
      }
      break;
    }
  }
}

function scanJsonOrText(rel, raw, parsedData, errors) {
  const seen = new Set();
  scanStringForForbidden(rel, raw, errors, seen);
  if (parsedData !== null) {
    for (const str of collectJsonStrings(parsedData)) {
      scanStringForForbidden(rel, str, errors, seen);
    }
  }
}

async function loadDisallowedCatalogTools(repoRoot, errors) {
  const disallowed = new Set(KNOWN_NON_HOSTED_TOOLS);
  const catalogFile = path.join(repoRoot, "src", "lib", "tool-catalog.ts");
  const text = await fs.readFile(catalogFile, "utf8").catch(() => null);
  if (text === null) {
    errors.push(
      "src/lib/tool-catalog.ts is missing or unreadable — cannot verify localOnly/internal tools",
    );
    return disallowed;
  }
  // Scan top-level TOOL_CATALOG array entries with balanced-brace tracking so
  // nested objects (e.g., annotations: { ... }) cannot truncate an entry early.
  const startMatch = /TOOL_CATALOG\b[^=]*=\s*\[/.exec(text);
  const scanStart = startMatch ? startMatch.index + startMatch[0].length : 0;
  let depth = 0;
  let entryStart = -1;
  let inString = null;
  for (let i = scanStart; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const endComment = text.indexOf("*/", i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) entryStart = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && entryStart !== -1) {
          const block = text.slice(entryStart, i + 1);
          const nameMatch = /\bname:\s*['"]([a-z0-9_]+)['"]/.exec(block);
          if (nameMatch && /\b(?:localOnly|internal):\s*true\b/.test(block)) {
            disallowed.add(nameMatch[1]);
          }
          entryStart = -1;
        }
      }
    } else if (ch === "]" && depth === 0 && startMatch) {
      break;
    }
  }
  return disallowed;
}

function validateUrlOnlyMcp(data, ctx, errors) {
  if (!isPlainObject(data.mcpServers)) {
    errors.push(`${ctx}: mcpServers must be an object`);
    return;
  }
  const servers = Object.entries(data.mcpServers);
  if (servers.length !== 1) {
    errors.push(`${ctx}: exactly one server is allowed`);
  }
  for (const [id, server] of servers) {
    if (!isPlainObject(server)) {
      errors.push(`${ctx}: server "${id}" must be an object`);
      continue;
    }
    for (const k of Object.keys(server)) {
      if (k !== "url") {
        errors.push(`${ctx}: server "${id}" must be url-only — remove "${k}"`);
      }
    }
    if (server.url !== HOSTED_MCP_URL) {
      errors.push(`${ctx}: server "${id}" url must be ${HOSTED_MCP_URL}`);
    }
  }
}

function validateHttpDotMcp(data, ctx, errors) {
  if (!isPlainObject(data.mcpServers)) {
    errors.push(`${ctx}: mcpServers must be an object`);
    return;
  }
  const servers = Object.entries(data.mcpServers);
  if (servers.length !== 1) {
    errors.push(`${ctx}: exactly one server is allowed`);
  }
  for (const [id, server] of servers) {
    if (!isPlainObject(server)) {
      errors.push(`${ctx}: server "${id}" must be an object`);
      continue;
    }
    for (const k of Object.keys(server)) {
      if (!["type", "url", "oauth_resource", "oauth"].includes(k)) {
        errors.push(
          `${ctx}: server "${id}" may only set type, url, oauth_resource, oauth — remove "${k}"`,
        );
      }
    }
    if (server.type !== "http") {
      errors.push(`${ctx}: server "${id}" type must be "http"`);
    }
    if (server.url !== HOSTED_MCP_URL) {
      errors.push(`${ctx}: server "${id}" url must be ${HOSTED_MCP_URL}`);
    }
    if (
      server.oauth_resource !== undefined &&
      server.oauth_resource !== HOSTED_MCP_URL
    ) {
      errors.push(
        `${ctx}: oauth_resource must be the exact protected resource ${HOSTED_MCP_URL}`,
      );
    }
    if (server.oauth !== undefined) {
      if (!isPlainObject(server.oauth)) {
        errors.push(`${ctx}: oauth must be an object`);
      } else {
        for (const k of Object.keys(server.oauth)) {
          if (k !== "scopes") {
            errors.push(`${ctx}: oauth only allows "scopes" — remove "${k}"`);
          }
        }
        if (
          !Array.isArray(server.oauth.scopes) ||
          server.oauth.scopes.length === 0
        ) {
          errors.push(`${ctx}: oauth.scopes must be a non-empty array`);
        } else {
          for (const scope of server.oauth.scopes) {
            if (!isNonEmptyString(scope) || !ALLOWED_PLUGIN_SCOPES.has(scope)) {
              errors.push(
                `${ctx}: disallowed oauth scope "${String(scope)}" (allowed: ${[...ALLOWED_PLUGIN_SCOPES].join(", ")})`,
              );
            }
          }
        }
      }
    }
  }
}

export async function validatePlugin(repoRoot = SCRIPT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const errors = [];
  const warnings = [];
  const rel = (p) => path.relative(resolvedRoot, p);

  const mpRes = await readJsonObject(
    path.join(resolvedRoot, ".cursor-plugin", "marketplace.json"),
    "marketplace.json",
    errors,
  );
  if (await exists(path.join(resolvedRoot, ".cursor-plugin", "plugin.json"))) {
    errors.push(
      "root plugin.json conflicts with the marketplace layout — delete .cursor-plugin/plugin.json",
    );
  }
  const marketplace = mpRes?.data;
  if (!marketplace) return { errors, warnings };

  scanJsonOrText(".cursor-plugin/marketplace.json", mpRes.raw, marketplace, errors);

  if (!isNonEmptyString(marketplace.name) || !MARKETPLACE_NAME_RE.test(marketplace.name)) {
    errors.push("marketplace.json: name must be lowercase kebab-case");
  }
  if (!isPlainObject(marketplace.owner) || !isNonEmptyString(marketplace.owner.name)) {
    errors.push("marketplace.json: owner.name is required");
  }
  if (!isNonEmptyString(marketplace.owner?.email) || marketplace.owner.email !== ALLOWED_EMAIL) {
    errors.push(`marketplace.json: owner.email must be ${ALLOWED_EMAIL}`);
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push("marketplace.json: plugins must be a non-empty array");
    return { errors, warnings };
  }

  const rootMcpRes = await readJsonObject(
    path.join(resolvedRoot, "mcp.json"),
    "mcp.json",
    errors,
  );
  if (rootMcpRes) {
    validateUrlOnlyMcp(rootMcpRes.data, "mcp.json", errors);
    scanJsonOrText("mcp.json", rootMcpRes.raw, rootMcpRes.data, errors);
  }

  const pkgRes = await readJsonObject(
    path.join(resolvedRoot, "package.json"),
    "package.json",
    errors,
  );
  const pkg = pkgRes?.data;

  const regRes = await readJsonObject(
    path.join(resolvedRoot, "registry", "server.json"),
    "registry/server.json",
    errors,
  );
  if (regRes) {
    const registry = regRes.data;
    scanJsonOrText("registry/server.json", regRes.raw, registry, errors);
    if (!isNonEmptyString(registry.name) || registry.name !== pkg?.mcpName) {
      errors.push(
        `registry/server.json: name must equal package.json mcpName (${pkg?.mcpName})`,
      );
    }
    if (!isNonEmptyString(registry.version) || registry.version !== pkg?.version) {
      errors.push(
        `registry/server.json: version must equal package.json version (${pkg?.version})`,
      );
    }
    if (!Array.isArray(registry.remotes) || registry.remotes.length === 0) {
      errors.push(
        `registry/server.json: remotes must be a non-empty array pointing to ${HOSTED_MCP_URL}`,
      );
    } else {
      registry.remotes.forEach((remote, idx) => {
        if (
          !isPlainObject(remote) ||
          remote.type !== "streamable-http" ||
          remote.url !== HOSTED_MCP_URL
        ) {
          errors.push(
            `registry/server.json: remotes[${idx}] must be streamable-http at ${HOSTED_MCP_URL}`,
          );
        }
      });
    }
    if (!Array.isArray(registry.packages) || registry.packages.length !== 1) {
      errors.push("registry/server.json: packages must contain exactly one npm package entry");
    } else {
      const p = registry.packages[0];
      if (!isPlainObject(p)) {
        errors.push("registry/server.json: packages[0] must be an object");
      } else {
        if (p.registryType !== "npm") {
          errors.push(`registry/server.json: packages[0] unsupported registryType ${String(p.registryType)}`);
        }
        if (p.registryBaseUrl !== "https://registry.npmjs.org") {
          errors.push("registry/server.json: packages[0] registryBaseUrl must be https://registry.npmjs.org");
        }
        if (
          p.identifier !== pkg?.name ||
          !isNonEmptyString(p.version) ||
          !SEMVER_RE.test(p.version) ||
          p.version !== pkg?.version
        ) {
          errors.push(
            "registry/server.json: packages[0] npm package identifier/version must match package.json",
          );
        }
        if (!isPlainObject(p.transport) || p.transport.type !== "stdio") {
          errors.push('registry/server.json: packages[0] transport.type must be "stdio"');
        }
      }
    }
  }

  const claudeMpRes = await readJsonObject(
    path.join(resolvedRoot, ".claude-plugin", "marketplace.json"),
    ".claude-plugin/marketplace.json",
    errors,
  );
  const claudeMp = claudeMpRes?.data;
  if (claudeMpRes) {
    scanJsonOrText(".claude-plugin/marketplace.json", claudeMpRes.raw, claudeMpRes.data, errors);
  }

  const codexMpFile = path.join(resolvedRoot, ".agents", "plugins", "marketplace.json");
  const codexMpRes = (await exists(codexMpFile))
    ? await readJsonObject(codexMpFile, ".agents/plugins/marketplace.json", errors)
    : null;
  const codexMp = codexMpRes?.data ?? null;

  const listedSources = new Set();
  const cursorPluginNames = new Set();
  const cursorPluginPairs = new Set();
  for (const entry of marketplace.plugins) {
    if (isPlainObject(entry) && isNonEmptyString(entry.name)) {
      if (cursorPluginNames.has(entry.name)) {
        errors.push(`.cursor-plugin/marketplace.json: duplicate plugin "${entry.name}"`);
      }
      cursorPluginNames.add(entry.name);
      if (isNonEmptyString(entry.source)) {
        listedSources.add(entry.source);
        cursorPluginPairs.add(`${entry.name}\0${entry.source}`);
      }
    }
  }
  for (const [mp, file] of [
    [claudeMp, ".claude-plugin/marketplace.json"],
    ...(codexMp ? [[codexMp, ".agents/plugins/marketplace.json"]] : []),
  ]) {
    if (!mp) continue;
    if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
      errors.push(`${file}: plugins must be a non-empty array`);
      continue;
    }
    const seen = new Set();
    for (const p of mp.plugins) {
      if (!isPlainObject(p) || !isNonEmptyString(p.name)) {
        errors.push(`${file}: every plugin entry must be an object with name`);
        continue;
      }
      if (seen.has(p.name)) {
        errors.push(`${file}: duplicate plugin "${p.name}"`);
      }
      seen.add(p.name);
      const src = typeof p.source === "string" ? p.source : p.source?.path;
      if (!isNonEmptyString(src) || !cursorPluginPairs.has(`${p.name}\0${src}`)) {
        errors.push(`${file}: unreviewed or mismatched plugin "${p.name}" (${String(src)})`);
      }
    }
  }
  const pluginsRoot = path.join(resolvedRoot, "plugins");
  for (const dirent of await fs
    .readdir(pluginsRoot, { withFileTypes: true })
    .catch(() => [])) {
    if (!dirent.isDirectory()) continue;
    if (!listedSources.has(`./plugins/${dirent.name}`)) {
      errors.push(
        `plugins/${dirent.name} is not listed in .cursor-plugin/marketplace.json`,
      );
    }
  }

  const lockRes = await readJsonObject(
    path.join(resolvedRoot, "tools.lock.json"),
    "tools.lock.json",
    errors,
  );
  const lock = lockRes?.data;
  const lockTools = Array.isArray(lock?.tools)
    ? lock.tools
    : Object.keys(isPlainObject(lock?.tools) ? lock.tools : {});
  const toolNames = new Set(
    lockTools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean),
  );
  const disallowedTools = await loadDisallowedCatalogTools(resolvedRoot, errors);

  for (const entry of marketplace.plugins) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.name) || !PLUGIN_NAME_RE.test(entry.name)) {
      errors.push(`marketplace.json: invalid plugin entry name`);
      continue;
    }
    if (
      !isNonEmptyString(entry.source) ||
      !entry.source.startsWith("./plugins/") ||
      entry.source.includes("..")
    ) {
      errors.push(
        `marketplace.json: plugin "${entry.name}" source must be a normalized ./plugins/<name> path`,
      );
      continue;
    }
    const pluginDir = await containedPath(resolvedRoot, entry.source, { kind: "dir" });
    if (!pluginDir || path.dirname(pluginDir) !== (await fs.realpath(pluginsRoot).catch(() => pluginsRoot))) {
      errors.push(
        `marketplace.json: source directory invalid or escapes plugins/ for "${entry.name}": ${entry.source}`,
      );
      continue;
    }

    const manifests = [
      {
        ctx: `plugin.json (${entry.name})`,
        relFile: ".cursor-plugin/plugin.json",
        descMin: 20,
        descMax: 300,
        requireLogo: "assets/logo.png",
        forbidMcpServers: true,
        requireGrok: false,
        requireCodex: false,
        requireClaude: false,
      },
      {
        ctx: `claude plugin.json (${entry.name})`,
        relFile: ".claude-plugin/plugin.json",
        descMin: 20,
        descMax: 300,
        requireMcpServers: "./.mcp.json",
        requireClaude: true,
      },
      {
        ctx: `codex plugin.json (${entry.name})`,
        relFile: ".codex-plugin/plugin.json",
        descMin: 20,
        descMax: 300,
        requireMcpServers: "./.mcp.json",
        requireSkillsDir: "./skills/",
        requireCodex: true,
      },
      {
        ctx: `grok plugin.json (${entry.name})`,
        relFile: ".grok-plugin/plugin.json",
        descMin: 20,
        descMax: 500,
        forbidMcpServers: true,
        requireLogo: true,
        requireGrok: true,
      },
    ];

    for (const spec of manifests) {
      const mRes = await readJsonObject(
        path.join(pluginDir, spec.relFile),
        spec.ctx,
        errors,
      );
      if (!mRes) continue;
      const m = mRes.data;
      scanJsonOrText(`${entry.name}/${spec.relFile}`, mRes.raw, m, errors);

      if (!isNonEmptyString(m.name) || !PLUGIN_NAME_RE.test(m.name)) {
        errors.push(`${spec.ctx}: name must be lowercase kebab-case`);
      } else if (m.name !== entry.name) {
        errors.push(`${spec.ctx}: name "${m.name}" must equal "${entry.name}"`);
      }

      if (!isNonEmptyString(m.version) || !SEMVER_RE.test(m.version)) {
        errors.push(`${spec.ctx}: version must be MAJOR.MINOR.PATCH`);
      } else if (isNonEmptyString(pkg?.version) && m.version !== pkg.version) {
        errors.push(`${spec.ctx}: version "${m.version}" must equal package.json version "${pkg.version}"`);
      }

      if (!isNonEmptyString(m.description, spec.descMin, spec.descMax)) {
        errors.push(
          `${spec.ctx}: description must be a string of ${spec.descMin}-${spec.descMax} characters`,
        );
      }
      if (!isPlainObject(m.author) || !isNonEmptyString(m.author.name)) {
        errors.push(`${spec.ctx}: author.name is required`);
      }
      if (m.license !== "MIT") {
        errors.push(`${spec.ctx}: license must be MIT`);
      }
      if (!isNonEmptyString(m.repository) || !/^https:\/\/github\.com\/socialneuron\//.test(m.repository)) {
        errors.push(`${spec.ctx}: repository must point at https://github.com/socialneuron/...`);
      }
      if ("hooks" in m) {
        errors.push(`${spec.ctx}: hooks are disallowed in this plugin`);
      }
      if (spec.forbidMcpServers && "mcpServers" in m) {
        errors.push(`${spec.ctx}: declare the connector in mcp.json, not in the manifest`);
      }
      if (spec.requireMcpServers && m.mcpServers !== spec.requireMcpServers) {
        errors.push(`${spec.ctx}: mcpServers must be "${spec.requireMcpServers}"`);
      }
      if (spec.requireLogo) {
        await checkAsset(pluginDir, m.logo, `${spec.ctx}: logo`, errors);
      }
      for (const compKey of ["skills", "rules", "commands", "agents"]) {
        if (m[compKey] !== undefined) {
          await checkContainedComponent(
            pluginDir,
            m[compKey],
            "dir",
            `${spec.ctx}: ${compKey}`,
            errors,
          );
        }
      }
      if (spec.requireSkillsDir && m.skills !== spec.requireSkillsDir) {
        errors.push(`${spec.ctx}: skills must be "${spec.requireSkillsDir}"`);
      }
      if (spec.requireCodex) {
        if (!isPlainObject(m.interface)) {
          errors.push(`${spec.ctx}: interface object is required`);
        } else {
          const iface = m.interface;
          if (!isNonEmptyString(iface.displayName)) {
            errors.push(`${spec.ctx}: interface.displayName is required`);
          }
          if (!isNonEmptyString(iface.developerName)) {
            errors.push(`${spec.ctx}: interface.developerName is required`);
          }
          if (!isNonEmptyString(iface.shortDescription, 1, 30)) {
            errors.push(`${spec.ctx}: interface.shortDescription must be a 1-30 char string`);
          }
          if (!isNonEmptyString(iface.longDescription, 20, 500)) {
            errors.push(`${spec.ctx}: interface.longDescription must be a 20-500 char string`);
          }
          for (const urlKey of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
            if (!isNonEmptyString(iface[urlKey]) || !HTTPS_URL_RE.test(iface[urlKey])) {
              errors.push(`${spec.ctx}: interface.${urlKey} must be a valid https URL`);
            }
          }
          await checkAsset(pluginDir, iface.logo, `${spec.ctx}: interface.logo`, errors);
          await checkAsset(pluginDir, iface.composerIcon, `${spec.ctx}: interface.composerIcon`, errors);
        }
      }
    }

    const mcpRes = await readJsonObject(
      path.join(pluginDir, "mcp.json"),
      `mcp.json (${entry.name})`,
      errors,
    );
    if (mcpRes) {
      validateUrlOnlyMcp(mcpRes.data, `mcp.json (${entry.name})`, errors);
      scanJsonOrText(`${entry.name}/mcp.json`, mcpRes.raw, mcpRes.data, errors);
    }

    const dotMcpRes = await readJsonObject(
      path.join(pluginDir, ".mcp.json"),
      `.mcp.json (${entry.name})`,
      errors,
    );
    if (dotMcpRes) {
      validateHttpDotMcp(dotMcpRes.data, `.mcp.json (${entry.name})`, errors);
      scanJsonOrText(`${entry.name}/.mcp.json`, dotMcpRes.raw, dotMcpRes.data, errors);
    }

    for (const [mp, file] of [
      [claudeMp, ".claude-plugin/marketplace.json"],
      ...(codexMp ? [[codexMp, ".agents/plugins/marketplace.json"]] : []),
    ]) {
      const listed = Array.isArray(mp?.plugins)
        ? mp.plugins.find((p) => isPlainObject(p) && p.name === entry.name)
        : null;
      const src =
        typeof listed?.source === "string"
          ? listed.source
          : listed?.source?.path;
      if (!listed || src !== entry.source) {
        errors.push(`${file}: must list "${entry.name}" with source ${entry.source}`);
      }
    }

    const skillsDir = path.join(pluginDir, "skills");
    if (!(await containedPath(pluginDir, "skills", { kind: "dir" }))) {
      errors.push(`SKILL.md (${entry.name}): skills/ directory is missing`);
    } else {
      let validSkillCount = 0;
      for (const dirent of await fs.readdir(skillsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const skillFile = path.join(skillsDir, dirent.name, "SKILL.md");
        if (!(await exists(skillFile))) {
          errors.push(`SKILL.md missing in skills/${dirent.name}`);
          continue;
        }
        const text = await fs.readFile(skillFile, "utf8");
        const fm = parseFrontmatter(text);
        if (!fm) {
          errors.push(`SKILL.md (${dirent.name}): frontmatter block is missing`);
          continue;
        }
        if (fm.fields.name !== dirent.name) {
          errors.push(
            `SKILL.md (${dirent.name}): frontmatter name "${fm.fields.name}" must equal ${dirent.name}`,
          );
        }
        const d = fm.fields.description;
        if (!isNonEmptyString(d, 30, 1024)) {
          errors.push(
            `SKILL.md (${dirent.name}): description must be 30-1024 characters`,
          );
        }
        if (fm.body.split("\n").length > MAX_SKILL_BODY_LINES) {
          errors.push(
            `SKILL.md (${dirent.name}): body exceeds ${MAX_SKILL_BODY_LINES} lines`,
          );
        }
        validSkillCount += 1;
      }
      if (validSkillCount === 0) {
        errors.push(`SKILL.md (${entry.name}): skills/ must contain at least one skill directory`);
      }
    }

    const rulesDir = path.join(pluginDir, "rules");
    if (await exists(rulesDir)) {
      for (const f of await fs.readdir(rulesDir)) {
        if (!f.endsWith(".mdc")) continue;
        const fm = parseFrontmatter(await fs.readFile(path.join(rulesDir, f), "utf8"));
        if (!fm || !isNonEmptyString(fm.fields.description)) {
          errors.push(`rules/${f}: frontmatter description is required`);
        }
        if (!fm || !/^(true|false)$/.test(fm.fields.alwaysApply ?? "")) {
          errors.push(`rules/${f}: frontmatter alwaysApply must be true or false`);
        }
      }
    }

    for (const walked of await walk(pluginDir)) {
      const r = rel(walked.path);
      if (walked.symlink) {
        errors.push(`${r}: symlinks are disallowed inside the plugin`);
        continue;
      }
      if (walked.dir) {
        if (path.basename(walked.path) === "hooks") {
          errors.push(`${r}: hooks/ directory is disallowed in this plugin`);
        }
        continue;
      }
      if (EXECUTABLE_EXT_RE.test(walked.path)) {
        errors.push(`${r}: executable/script files are disallowed inside the plugin`);
      }
      if (BINARY_IMAGE_EXT_RE.test(walked.path)) {
        const st = await fs.stat(walked.path).catch(() => null);
        if (st && st.size > MAX_IMAGE_BYTES) {
          errors.push(`${r} exceeds ${MAX_IMAGE_BYTES} bytes`);
        }
        continue;
      }
      const text = await fs.readFile(walked.path, "utf8").catch(() => "");
      if (walked.path.endsWith(".json")) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          errors.push(`${r} is not valid JSON: ${err.message}`);
        }
        scanJsonOrText(r, text, parsed, errors);
      } else {
        scanStringForForbidden(r, text, errors);
      }
      if (/\/(?:rules\/[^/]+\.mdc|README\.md|skills\/[^/]+\/SKILL\.md)$/.test(walked.path)) {
        for (const [, tool] of text.matchAll(TOOL_TOKEN_RE)) {
          if (!toolNames.has(tool) && !KNOWN_SKILL_PARAM_TOKENS.has(tool)) {
            errors.push(`${r}: unknown tool \`${tool}\``);
          } else if (disallowedTools.has(tool)) {
            errors.push(`${r}: localOnly/internal tool \`${tool}\` is disallowed in hosted plugin docs/skills`);
          }
        }
      }
      if (/\.(md|mdc|json)$/.test(walked.path) && Buffer.byteLength(text) > MAX_TEXT_BYTES) {
        errors.push(`${r} exceeds ${MAX_TEXT_BYTES} bytes`);
      }
      if (walked.path.endsWith(".svg")) {
        const bytes = Buffer.byteLength(text);
        if (bytes > MAX_IMAGE_BYTES) {
          errors.push(`${r} exceeds ${MAX_IMAGE_BYTES} bytes`);
        } else if (bytes > 60_000) {
          warnings.push(`${r} is large for a marketplace logo`);
        }
      }
    }
  }

  return { errors, warnings };
}

const isMain =
  Boolean(process.argv[1]) &&
  (await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))) ===
    (await fs.realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url)));
if (isMain) {
  const root = path.resolve(process.argv[2] ?? SCRIPT_REPO_ROOT);
  const { errors, warnings } = await validatePlugin(root);
  for (const w of warnings) console.warn(`warn: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  console.log(
    errors.length === 0
      ? `plugin OK (${warnings.length} warnings)`
      : `${errors.length} error(s)`,
  );
  process.exit(errors.length === 0 ? 0 : 1);
}
