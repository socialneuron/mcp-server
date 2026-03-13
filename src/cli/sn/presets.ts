import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SnArgs } from './types.js';
import { emitSnResult } from './parse.js';

export interface ContentPreset {
  name: string;
  platform: string;
  maxLength: number;
  aspectRatio?: string;
  builtin: boolean;
}

export const BUILTIN_PRESETS: ContentPreset[] = [
  {
    name: 'instagram-reel',
    platform: 'Instagram',
    maxLength: 2200,
    aspectRatio: '9:16',
    builtin: true,
  },
  {
    name: 'instagram-post',
    platform: 'Instagram',
    maxLength: 2200,
    aspectRatio: '1:1',
    builtin: true,
  },
  { name: 'tiktok', platform: 'TikTok', maxLength: 4000, aspectRatio: '9:16', builtin: true },
  {
    name: 'youtube-short',
    platform: 'YouTube',
    maxLength: 5000,
    aspectRatio: '9:16',
    builtin: true,
  },
  { name: 'linkedin-post', platform: 'LinkedIn', maxLength: 3000, builtin: true },
  { name: 'twitter-post', platform: 'Twitter', maxLength: 280, builtin: true },
];

const PRESETS_DIR = join(homedir(), '.config', 'socialneuron');
const PRESETS_FILE = join(PRESETS_DIR, 'presets.json');

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadUserPresets(): ContentPreset[] {
  if (!existsSync(PRESETS_FILE)) return [];
  try {
    const raw = readFileSync(PRESETS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ContentPreset[];
  } catch {
    return [];
  }
}

function saveUserPresets(presets: ContentPreset[]): void {
  if (!existsSync(PRESETS_DIR)) {
    mkdirSync(PRESETS_DIR, { recursive: true });
  }
  writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Public resolver (for use by content.ts, quality-check, etc.)
// ---------------------------------------------------------------------------

export function resolvePreset(name: string): ContentPreset | null {
  const lower = name.toLowerCase();
  const builtin = BUILTIN_PRESETS.find(p => p.name === lower);
  if (builtin) return builtin;
  const userPresets = loadUserPresets();
  return userPresets.find(p => p.name === lower) ?? null;
}

// ---------------------------------------------------------------------------
// Sub-command handlers
// ---------------------------------------------------------------------------

function handlePresetList(asJson: boolean): void {
  const all = [...BUILTIN_PRESETS, ...loadUserPresets()];
  if (asJson) {
    emitSnResult({ ok: true, command: 'preset', presets: all, count: all.length }, asJson);
    return;
  }
  const header = 'NAME                 PLATFORM     MAX-LEN  RATIO    SOURCE';
  const lines = all.map(p => {
    const name = p.name.padEnd(20);
    const plat = p.platform.padEnd(12);
    const len = String(p.maxLength).padEnd(8);
    const ratio = (p.aspectRatio ?? '-').padEnd(8);
    const src = p.builtin ? 'builtin' : 'user';
    return `${name} ${plat} ${len} ${ratio} ${src}`;
  });
  process.stdout.write(header + '\n' + lines.join('\n') + '\n');
}

function handlePresetShow(args: SnArgs, asJson: boolean): void {
  const name = args['name'];
  if (!name || typeof name !== 'string') {
    throw new Error('--name is required for "preset show"');
  }
  const preset = resolvePreset(name);
  if (!preset) {
    throw new Error(`Preset "${name}" not found`);
  }
  if (asJson) {
    emitSnResult({ ok: true, command: 'preset', preset }, asJson);
    return;
  }
  process.stdout.write(
    `name:       ${preset.name}\n` +
      `platform:   ${preset.platform}\n` +
      `maxLength:  ${preset.maxLength}\n` +
      `aspectRatio: ${preset.aspectRatio ?? '-'}\n` +
      `source:     ${preset.builtin ? 'builtin' : 'user'}\n`
  );
}

function handlePresetSave(args: SnArgs, asJson: boolean): void {
  const name = args['name'];
  if (!name || typeof name !== 'string') {
    throw new Error('--name is required for "preset save"');
  }
  const platform = args['platform'];
  if (!platform || typeof platform !== 'string') {
    throw new Error('--platform is required for "preset save"');
  }
  const maxLengthRaw = args['max-length'];
  if (!maxLengthRaw) {
    throw new Error('--max-length is required for "preset save"');
  }
  const maxLength = Number(maxLengthRaw);
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    throw new Error('--max-length must be a positive number');
  }

  const lowerName = name.toLowerCase();
  if (BUILTIN_PRESETS.some(p => p.name === lowerName)) {
    throw new Error(`Cannot overwrite builtin preset "${lowerName}"`);
  }

  const aspectRatio = typeof args['aspect-ratio'] === 'string' ? args['aspect-ratio'] : undefined;

  const preset: ContentPreset = {
    name: lowerName,
    platform,
    maxLength,
    aspectRatio,
    builtin: false,
  };

  const userPresets = loadUserPresets();
  const idx = userPresets.findIndex(p => p.name === lowerName);
  if (idx >= 0) {
    userPresets[idx] = preset;
  } else {
    userPresets.push(preset);
  }
  saveUserPresets(userPresets);

  if (asJson) {
    emitSnResult({ ok: true, command: 'preset', saved: preset }, asJson);
    return;
  }
  process.stdout.write(`Preset "${lowerName}" saved.\n`);
}

function handlePresetDelete(args: SnArgs, asJson: boolean): void {
  const name = args['name'];
  if (!name || typeof name !== 'string') {
    throw new Error('--name is required for "preset delete"');
  }

  const lowerName = name.toLowerCase();
  if (BUILTIN_PRESETS.some(p => p.name === lowerName)) {
    throw new Error(`Cannot delete builtin preset "${lowerName}"`);
  }

  const userPresets = loadUserPresets();
  const idx = userPresets.findIndex(p => p.name === lowerName);
  if (idx < 0) {
    throw new Error(`User preset "${lowerName}" not found`);
  }
  userPresets.splice(idx, 1);
  saveUserPresets(userPresets);

  if (asJson) {
    emitSnResult({ ok: true, command: 'preset', deleted: lowerName }, asJson);
    return;
  }
  process.stdout.write(`Preset "${lowerName}" deleted.\n`);
}

const USAGE = `Usage: sn preset <sub-command> [options]

Sub-commands:
  list                          List all presets (builtin + user)
  show   --name <preset>        Show a single preset
  save   --name <n> --platform <p> --max-length <len> [--aspect-ratio <r>]
  delete --name <preset>        Delete a user preset
`;

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handlePreset(args: SnArgs, asJson: boolean): Promise<void> {
  const sub = args._[0];

  if (!sub || sub === '--help' || args['help'] === true) {
    process.stdout.write(USAGE);
    return;
  }

  switch (sub) {
    case 'list':
      return handlePresetList(asJson);
    case 'show':
      return handlePresetShow(args, asJson);
    case 'save':
      return handlePresetSave(args, asJson);
    case 'delete':
      return handlePresetDelete(args, asJson);
    default:
      throw new Error(`Unknown preset sub-command: "${sub}". Run "sn preset --help" for usage.`);
  }
}
