/**
 * Per-request video budget estimates. Expected values are the platform's
 * dynamic video pricing (credits/second x dispatched duration, floored at the
 * model minimum); generate_video budget-checks every call against these.
 */
import { describe, it, expect } from 'vitest';
import { estimateVideoCredits, VIDEO_CREDIT_ESTIMATES } from './creditEstimates.js';

describe('VIDEO_CREDIT_ESTIMATES', () => {
  it('lists seedance-2.5 at its 8s/720p reference cost (provisional)', () => {
    expect(VIDEO_CREDIT_ESTIMATES['seedance-2.5']).toBe(504);
  });
});

describe('estimateVideoCredits', () => {
  it('prices the Seedance family by resolution and clamped duration', () => {
    expect(estimateVideoCredits('seedance-2', 15, '720p')).toBe(615);
    expect(estimateVideoCredits('seedance-2-fast', 8, '720p')).toBe(264);
    expect(estimateVideoCredits('seedance-2.5', 30, '720p')).toBe(1890);
    expect(estimateVideoCredits('seedance-2.5', 8, '720p')).toBe(504);
    expect(estimateVideoCredits('seedance-2.5', 8, '480p')).toBe(240);
    expect(estimateVideoCredits('seedance-2.5', 8, '1080P')).toBe(1256);
    // 4s minimum dispatch and an 80-credit floor
    expect(estimateVideoCredits('seedance-2.5', 2, '480p')).toBe(120);
    expect(estimateVideoCredits('seedance-2', 4, '480p')).toBe(80);
    // seedance-2 caps at 15s; seedance-2.5 at 30s
    expect(estimateVideoCredits('seedance-2', 30, '720p')).toBe(615);
    expect(estimateVideoCredits('seedance-2.5', 45, '720p')).toBe(1890);
  });

  it('defaults to a 5s 720p request', () => {
    expect(estimateVideoCredits('seedance-2.5')).toBe(315);
  });

  it('prices kling by snapped duration and audio', () => {
    expect(estimateVideoCredits('kling-3', 5, undefined, false)).toBe(100);
    expect(estimateVideoCredits('kling-3', 10, undefined, true)).toBe(300);
    expect(estimateVideoCredits('kling-3-pro', 15, undefined, true)).toBe(600);
    expect(estimateVideoCredits('kling', 10, undefined, false)).toBe(170);
  });

  it('prices step models by duration', () => {
    expect(estimateVideoCredits('grok-imagine', 10)).toBe(50);
    expect(estimateVideoCredits('hailuo-02-standard', 6)).toBe(180);
    expect(estimateVideoCredits('wan-2.6', 15)).toBe(315);
    expect(estimateVideoCredits('seedance-1.5-pro', 12)).toBe(225);
  });

  it('falls back to the reference table for flat models', () => {
    expect(estimateVideoCredits('veo3-quality')).toBe(1000);
    expect(estimateVideoCredits('veo3-fast')).toBe(65);
  });
});
