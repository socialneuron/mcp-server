import { describe, it, expect, vi } from 'vitest';
import { BUILTIN_PRESETS, resolvePreset } from './presets.js';

// Mock fs to avoid real filesystem reads/writes
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('presets', () => {
  it('has 6 builtin presets', () => {
    expect(BUILTIN_PRESETS.length).toBe(6);
  });

  it('all builtins are marked as builtin', () => {
    expect(BUILTIN_PRESETS.every(p => p.builtin)).toBe(true);
  });

  it('resolvePreset finds builtin by name', () => {
    const preset = resolvePreset('instagram-reel');
    expect(preset).not.toBeNull();
    expect(preset!.platform).toBe('Instagram');
    expect(preset!.aspectRatio).toBe('9:16');
  });

  it('resolvePreset returns null for unknown name', () => {
    expect(resolvePreset('nonexistent')).toBeNull();
  });

  it('twitter-post has 280 max length', () => {
    const preset = resolvePreset('twitter-post');
    expect(preset!.maxLength).toBe(280);
  });

  it('builtin presets cover expected platforms', () => {
    const platforms = new Set(BUILTIN_PRESETS.map(p => p.platform));
    expect(platforms.has('Instagram')).toBe(true);
    expect(platforms.has('TikTok')).toBe(true);
    expect(platforms.has('YouTube')).toBe(true);
    expect(platforms.has('LinkedIn')).toBe(true);
    expect(platforms.has('Twitter')).toBe(true);
  });
});
