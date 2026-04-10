# Verifying `tools.lock.json` (Downstream Consumers)

`@socialneuron/mcp-server` ships a sealed manifest, [`tools.lock.json`](../tools.lock.json), containing a SHA-256 hash of every tool's identity-relevant fields (`name`, `description`, `module`, `scope`). Pin a hash in your agent's configuration and verify at runtime to detect rug-pull attacks.

## Why this matters

Per [CVE-2025-6514](https://nvd.nist.gov/vuln/detail/CVE-2025-6514), a compromised MCP server can silently change tool descriptions to inject prompt-injection payloads into your LLM after you've already approved the connection. Hash pinning detects that drift before the model ever sees the modified description.

## How the manifest is built

At build time, `scripts/build-tools-lock.mjs`:

1. Reads `src/lib/tool-catalog.ts` (the single static source of every tool definition in this package).
2. For each entry, canonicalizes `{ name, description, module, scope }` as `JSON.stringify(...)`.
3. SHA-256 hashes the UTF-8 bytes.
4. Writes `tools.lock.json` with one hex hash per tool.

The full lockfile is included in every published tarball (`package.json#files`).

## Pin a known-good hash

After auditing a version you trust, record the lockfile's overall hash:

```bash
shasum -a 256 node_modules/@socialneuron/mcp-server/tools.lock.json
```

Save the resulting hex string as your pinned value.

## Verify at runtime

```typescript
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PINNED_HASH = '<your audited hash>';

const lockfilePath = require.resolve('@socialneuron/mcp-server/tools.lock.json');
const contents = readFileSync(lockfilePath, 'utf8');
const actual = createHash('sha256').update(contents, 'utf8').digest('hex');

if (actual !== PINNED_HASH) {
  throw new Error(
    `Tools manifest drift detected: ${actual} != ${PINNED_HASH}. ` +
    `Re-audit @socialneuron/mcp-server before continuing.`
  );
}
```

## Per-tool verification

If you only care about specific high-risk tools (e.g. `schedule_post`, `send_email`, anything with egress capability), pin individual entries instead:

```typescript
const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));

const PINNED_TOOLS = {
  schedule_post: '<sha256>',
  // add more here
};

for (const [name, hash] of Object.entries(PINNED_TOOLS)) {
  const current = lockfile.tools?.[name];
  if (current !== hash) {
    throw new Error(
      `Tool "${name}" hash drifted: ${current} != ${hash}`
    );
  }
}
```

## Belt-and-braces: also verify npm provenance

`@socialneuron/mcp-server` is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) (SLSA Build L2 via OIDC + Sigstore). Verify the publish chain came from our actual GitHub Actions workflow:

```bash
npm audit signatures
```

Combined with the tools-lock hash pinning, this gives you:

1. **Supply-chain integrity**: npm provenance proves the tarball was built from `socialneuron/mcp-server@main` via `release.yml`.
2. **Content integrity**: the lockfile hash proves no tool's identity has drifted since you audited it.

## When to re-audit

Re-audit (recompute your pinned hash) whenever:

- You bump `@socialneuron/mcp-server` to a new version
- You see a PR in the public repo that touches `src/lib/tool-catalog.ts`
- Your CI flags a lockfile diff you didn't expect

## Upstream enforcement

The publisher side (this repo) enforces the same invariant in CI via `scripts/verify-tools-lock.mjs` and `scripts/lint-tool-descriptions.mjs`:

- Any PR that changes `src/lib/tool-catalog.ts` without also bumping `tools.lock.json` fails CI
- Any PR whose descriptions contain prompt-injection patterns (3+ newlines, zero-width chars, role-play markers, off-allowlist URLs, email addresses) fails CI

This means the lockfile is a full dual-signed gate: source → lock at publish time, lock → runtime at consume time.
