import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerCreditsTools } from './credits.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('credits tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCreditsTools(server as any);
  });

  // =========================================================================
  // get_credit_balance
  // =========================================================================
  describe('get_credit_balance', () => {
    it('returns active subscription credits via mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, balance: 1234, monthlyUsed: 50, monthlyLimit: 2000, plan: 'pro' },
        error: null,
      });

      const handler = server.getHandler('get_credit_balance')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('Plan: pro');
      expect(result.content[0].text).toContain('Balance: 1234');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'credit-balance' })
      );
    });

    it('returns plan free and balance 0 when no data found', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, balance: 0, monthlyUsed: 0, monthlyLimit: 0, plan: 'free' },
        error: null,
      });

      const handler = server.getHandler('get_credit_balance')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('Plan: free');
      expect(result.content[0].text).toContain('Balance: 0');
      expect(result.isError).toBeUndefined();
    });

    it('returns isError with message on EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'column "credits" does not exist',
      });

      const handler = server.getHandler('get_credit_balance')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch credit balance');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, balance: 500, monthlyUsed: 100, monthlyLimit: 800, plan: 'starter' },
        error: null,
      });

      const handler = server.getHandler('get_credit_balance')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.5');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data.plan).toBe('starter');
      expect(parsed.data.balance).toBe(500);
      expect(parsed.data.monthlyUsed).toBe(100);
      expect(parsed.data.monthlyLimit).toBe(800);
    });

    it('returns correct text format with monthly usage', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          balance: 9999,
          monthlyUsed: 200,
          monthlyLimit: 5000,
          plan: 'business',
        },
        error: null,
      });

      const handler = server.getHandler('get_credit_balance')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toMatch(/^Credit Balance\n/);
      expect(text).toContain('Plan: business');
      expect(text).toContain('Balance: 9999');
      expect(text).toContain('Monthly used: 200 / 5000');
      expect(result.isError).toBeUndefined();
    });
  });

  // =========================================================================
  // get_budget_status
  // =========================================================================
  describe('get_budget_status', () => {
    it('returns JSON envelope for budget status', async () => {
      const handler = server.getHandler('get_budget_status')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.5');
      expect(parsed.data).toHaveProperty('creditsUsedThisRun');
    });

    it('returns text format with all budget fields', async () => {
      const handler = server.getHandler('get_budget_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toMatch(/^Budget Status\n/);
      expect(text).toContain('Credits used this run:');
      expect(text).toContain('Credits limit:');
      expect(text).toContain('Credits remaining:');
      expect(text).toContain('Assets generated this run:');
      expect(text).toContain('Asset limit:');
      expect(text).toContain('Assets remaining:');
    });

    it('shows unlimited for limits when max is 0', async () => {
      const handler = server.getHandler('get_budget_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Credits limit: unlimited');
      expect(text).toContain('Credits remaining: unlimited');
      expect(text).toContain('Asset limit: unlimited');
      expect(text).toContain('Assets remaining: unlimited');
    });

    it('returns correct JSON structure with all budget properties', async () => {
      const handler = server.getHandler('get_budget_status')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      const data = parsed.data;
      expect(data).toHaveProperty('creditsUsedThisRun');
      expect(data).toHaveProperty('maxCreditsPerRun');
      expect(data).toHaveProperty('remaining');
      expect(data).toHaveProperty('assetsGeneratedThisRun');
      expect(data).toHaveProperty('maxAssetsPerRun');
      expect(data).toHaveProperty('remainingAssets');
      expect(typeof data.creditsUsedThisRun).toBe('number');
      expect(typeof data.maxCreditsPerRun).toBe('number');
    });
  });
});
