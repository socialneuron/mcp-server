#!/usr/bin/env node
/**
 * Build the reviewable MCP tool-surface security matrix from the same runtime
 * registry and catalog used by tools.lock.json.
 *
 * This is intentionally deterministic. It records schema-level controls and
 * flags tools that still rely on account-wide or opaque-ID ownership checks;
 * it does not claim to replace backend authorization tests.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateLockedTools } from './lib/enumerate-runtime-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'docs/audits/2026-07-14-tool-surface-audit.md');

const idBoundTools = new Set([
  'auto_approve_plan',
  'check_status',
  'delete_comment',
  'get_content_plan',
  'get_media_url',
  'get_pipeline_status',
  'get_recipe_run_status',
  'list_comments',
  'list_plan_approvals',
  'moderate_comment',
  'post_comment',
  'reply_to_comment',
  'reschedule_post',
  'respond_plan_approval',
  'submit_content_plan_for_approval',
  'update_autopilot_config',
  'update_content_plan',
]);

const projectGapTools = new Set([
  'auto_approve_plan',
  'delete_comment',
  'execute_recipe',
  'fetch_youtube_analytics',
  'get_active_campaigns',
  'get_autopilot_status',
  'get_content_plan',
  'get_loop_pulse',
  'get_media_url',
  'get_pipeline_status',
  'get_recipe_run_status',
  'list_autopilot_configs',
  'list_comments',
  'moderate_comment',
  'post_comment',
  'read_agent_reflection',
  'record_campaign_spend',
  'record_intel_signal',
  'record_observation',
  'record_outcome',
  'render_demo_video',
  'render_template_video',
  'reply_to_comment',
  'respond_plan_approval',
  'run_skill',
  'schedule_content_plan',
  'submit_content_plan_for_approval',
  'update_autopilot_config',
  'update_content_plan',
  'write_agent_reflection',
]);

const intentionallyGlobalModules = new Set([
  'credits',
  'discovery',
  'quality',
  'screenshot',
  'usage',
]);

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function visibility(catalog) {
  if (catalog?.internal) return 'internal';
  if (catalog?.local_only) return 'local only';
  if (catalog?.hidden_from_public_count) return 'authenticated hidden';
  if (catalog?.module === 'apps') return 'public app';
  return 'public';
}

function projectBinding(name, info) {
  const properties = info.runtime?.input_schema?.properties ?? {};
  if ('project_id' in properties) return 'explicit project';
  if (idBoundTools.has(name)) return 'opaque ID/key';
  if (projectGapTools.has(name)) return 'account/implicit';
  if (intentionallyGlobalModules.has(info.catalog?.module)) return 'not applicable';
  if (['fetch_trends', 'extract_url_content', 'extract_brand'].includes(name)) {
    return 'external/global';
  }
  return 'account/global';
}

function riskFor(module, annotations) {
  const byModule = {
    analytics: 'cross-brand metrics disclosure or refresh amplification',
    apps: 'host-message trust, stale UI data, or project confusion',
    autopilot: 'unbounded spend, schedule mutation, or approval bypass',
    brand: 'SSRF, prompt injection, or cross-brand profile overwrite',
    brandRuntime: 'brand IP disclosure or false consistency assurance',
    carousel: 'paid generation, prompt injection, or brand drift',
    comments: 'external speech/moderation under the wrong account',
    content: 'paid generation, unsafe media URL, or wrong-brand output',
    credits: 'account usage disclosure or misleading budget state',
    digest: 'cross-brand aggregation or misleading anomaly claims',
    discovery: 'tool-description supply-chain or metadata injection',
    distribution: 'wrong-account publication, duplicate post, or OAuth abuse',
    extraction: 'SSRF and untrusted-page prompt injection',
    harness: 'learning-loop poisoning or cross-brand provenance loss',
    hermes: 'internal record poisoning, spend fraud, or provenance loss',
    hyperframes: 'active HTML execution, render abuse, or paid compute exhaustion',
    ideation: 'prompt injection, model spend, or wrong-brand generation',
    'ideation-context': 'cross-brand strategy/analytics disclosure',
    insights: 'cross-brand analytics disclosure or unsupported recommendation',
    loop: 'cross-brand learning-state disclosure or poisoning',
    'loop-summary': 'cross-brand learning-state disclosure',
    media: 'SSRF, malicious file upload, storage abuse, or signed-URL leakage',
    pipeline: 'multi-stage spend, approval bypass, or unintended publish',
    planning: 'cross-brand plan mutation, duplicate scheduling, or publish error',
    'plan-approvals': 'approval spoofing or cross-brand plan mutation',
    quality: 'false assurance; advisory checks mistaken for enforcement',
    recipes: 'opaque multi-step spend and unintended external side effects',
    remotion: 'untrusted props, render abuse, or paid compute exhaustion',
    research: 'cross-brand performance disclosure',
    screenshot: 'SSRF, browser compromise, or local-path disclosure',
    skills: 'opaque workflow side effects or unbounded generation',
    suggest: 'cross-brand insight disclosure',
    usage: 'account activity and consumption disclosure',
    'youtube-analytics': 'cross-brand/channel analytics disclosure',
  };
  const base = byModule[module] ?? 'authorization, input validation, and output leakage';
  return annotations?.destructiveHint ? `${base}; destructive operation` : base;
}

function controlFor(name, info, binding) {
  const scope = info.runtime?.scope ?? info.catalog?.scope ?? 'unknown scope';
  const parts = [scope];
  if (binding === 'explicit project') parts.push('project_id schema');
  if (binding === 'opaque ID/key') parts.push('backend ownership required');
  if (info.runtime?.annotations?.destructiveHint) parts.push('destructive annotation');
  if (info.runtime?.annotations?.readOnlyHint) parts.push('read-only annotation');
  if (info.catalog?.internal) parts.push('hidden from public discovery');
  if (info.catalog?.hidden_from_public_count) parts.push('authenticated-only discovery');
  if (info.catalog?.local_only) parts.push('not hosted');
  if (name === 'schedule_post') parts.push('quality gate + idempotency key');
  if (name === 'reschedule_post') parts.push('optimistic timestamp precondition');
  return parts.join('; ');
}

function recommendationFor(name, info, binding) {
  if (projectGapTools.has(name)) {
    return 'Add project_id (and account_id where relevant), then assert compound ownership server-side.';
  }
  if (info.catalog?.module === 'hyperframes') {
    return 'Keep sandboxed rendering, URL allowlists, byte/time caps, and separate reliability SLOs.';
  }
  if (info.catalog?.module === 'apps') {
    return 'Validate host messages and re-authorize every backing tool call; never trust widget state.';
  }
  if (info.runtime?.annotations?.destructiveHint) {
    return 'Retain explicit confirmation, audit event, rate limit, and idempotency/precondition where possible.';
  }
  if (info.runtime?.annotations?.openWorldHint) {
    return 'Keep external-side-effect logging, bounded retries, and provider-specific rate limits.';
  }
  if (binding === 'explicit project') {
    return 'Maintain gateway membership tests and backend compound-key ownership checks.';
  }
  return 'Retain least-privilege scope, bounded outputs, sanitized errors, and regression coverage.';
}

const locked = await enumerateLockedTools();
const entries = Object.entries(locked).sort(([a], [b]) => a.localeCompare(b));
const scopeCounts = {};
const visibilityCounts = {};
let explicitProject = 0;
let gaps = 0;

const rows = entries.map(([name, info]) => {
  const scope = info.runtime?.scope ?? info.catalog?.scope ?? 'unknown';
  const vis = visibility(info.catalog);
  const binding = projectBinding(name, info);
  scopeCounts[scope] = (scopeCounts[scope] ?? 0) + 1;
  visibilityCounts[vis] = (visibilityCounts[vis] ?? 0) + 1;
  if (binding === 'explicit project') explicitProject += 1;
  if (projectGapTools.has(name)) gaps += 1;
  return [
    `\`${name}\``,
    info.catalog?.module ?? 'uncatalogued',
    vis,
    scope,
    binding,
    riskFor(info.catalog?.module, info.runtime?.annotations),
    controlFor(name, info, binding),
    recommendationFor(name, info, binding),
  ];
});

const lines = [
  '# MCP Tool Surface Security and Usability Audit',
  '',
  '**Date:** 2026-07-14',
  '**Generated from:** runtime `tools/list` registration plus `TOOL_CATALOG`',
  `**Inventory:** ${entries.length} sealed tools (${Object.entries(visibilityCounts)
    .map(([key, count]) => `${count} ${key}`)
    .join(', ')})`,
  '',
  '## Executive findings',
  '',
  `- All ${entries.length} runtime and catalog entries are integrity-sealed. The seal now includes exposure flags and agent-selection guidance, closing the prior unsealed metadata gap.`,
  `- ${explicitProject} tools expose an explicit \`project_id\`. ${gaps} project-relevant tools still rely on account defaults or opaque IDs and should gain explicit compound project/account binding.`,
  '- Generation tools now accept `project_id`; `generate_video` is no longer account-cap blocked on paid plans. HyperFrames remains a separate renderer and keeps a separate reliability verdict.',
  '- Destructive and open-world annotations are agent hints, not authorization. The gateway and backend must re-check scope, membership, ownership, budget, approval, and idempotency on every call.',
  '- MCP Apps are presentation layers only. Widget state cannot authorize rescheduling, publishing, or analytics reads; backing tool calls remain authoritative.',
  '',
  '## Scope totals',
  '',
  '| Scope | Tools |',
  '|---|---:|',
  ...Object.entries(scopeCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, count]) => `| \`${scope}\` | ${count} |`),
  '',
  '## Review method and limitations',
  '',
  'This matrix checks the exposed schemas, scopes, annotations, visibility flags, and known gateway contracts. It flags implicit tenancy even where the current backend may correctly validate an opaque ID. “Backend ownership required” is therefore a required invariant, not an unqualified claim that every downstream implementation was dynamically proven. Live destructive tests are limited to controlled assets/accounts and are reported separately in the release audit.',
  '',
  '## Per-tool matrix',
  '',
  '| Tool | Module | Visibility | Scope | Tenant binding | Primary risk | Current schema/control | Required posture |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  '',
  '## Priority remediation order',
  '',
  '1. Add explicit project/account binding to YouTube analytics/comments, recipe execution, autopilot list/status/update, plan/status-by-ID, media signing, and internal learning/provenance tools.',
  '2. Preserve the signed ownership check for every media preview/download and keep all arbitrary URLs behind SSRF validation.',
  '3. Add distributed rate limiting before horizontal hosted-MCP scaling; current in-process limits remain single-replica controls.',
  '4. Treat quality checks as advisory unless the server-side publish gate independently enforces them.',
  '5. Re-run this generator, `lint:tools`, `verify:lock`, contract tests, and live read-only probes on every tool-surface release.',
];

writeFileSync(OUTPUT, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`Wrote ${entries.length}-tool audit matrix to ${OUTPUT}\n`);
