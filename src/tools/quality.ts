import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { evaluateQuality } from '../lib/quality.js';
import { logMcpToolInvocation } from '../lib/supabase.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: '0.2.0', timestamp: new Date().toISOString() }, data };
}

export function registerQualityTools(server: McpServer): void {
  server.tool(
    'quality_check',
    "Score a single post's content quality across 7 categories (Hook Strength, Message Clarity, Platform Fit, Brand Alignment, Novelty, CTA Strength, Safety/Claims). Returns pass/fail with per-category scores.",
    {
      caption: z.string().describe('Post caption/body text'),
      title: z.string().optional().describe('Post title (important for YouTube)'),
      platforms: z
        .array(
          z.enum([
            'youtube',
            'tiktok',
            'instagram',
            'twitter',
            'linkedin',
            'facebook',
            'threads',
            'bluesky',
          ])
        )
        .min(1)
        .describe('Target platforms'),
      threshold: z.number().min(0).max(35).default(26).describe('Minimum total score to pass'),
      brand_keyword: z.string().optional().describe('Brand keyword for alignment check'),
      brand_avoid_patterns: z.array(z.string()).optional(),
      custom_banned_terms: z.array(z.string()).optional(),
      response_format: z.enum(['text', 'json']).default('text'),
    },
    async ({
      caption,
      title,
      platforms,
      threshold,
      brand_keyword,
      brand_avoid_patterns,
      custom_banned_terms,
      response_format,
    }) => {
      const startedAt = Date.now();

      const result = evaluateQuality({
        caption,
        title,
        platforms,
        threshold,
        brandKeyword: brand_keyword,
        brandAvoidPatterns: brand_avoid_patterns,
        customBannedTerms: custom_banned_terms,
      });

      const durationMs = Date.now() - startedAt;
      logMcpToolInvocation({
        toolName: 'quality_check',
        status: 'success',
        durationMs,
        details: { score: result.total, passed: result.passed },
      });

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(result), null, 2) }],
          isError: false,
        };
      }

      const lines: string[] = [];
      lines.push(
        `QUALITY SCORE: ${result.total}/${result.maxTotal} ${result.passed ? '[PASS]' : '[FAIL]'}`
      );
      lines.push('');
      for (const cat of result.categories) {
        lines.push(`  ${cat.name}: ${cat.score}/${cat.maxScore} — ${cat.detail}`);
      }
      if (result.blockers.length > 0) {
        lines.push('');
        lines.push('BLOCKERS:');
        for (const b of result.blockers) {
          lines.push(`  - ${b}`);
        }
      }
      lines.push('');
      lines.push(`Threshold: ${result.threshold}/${result.maxTotal}`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
    }
  );

  server.tool(
    'quality_check_plan',
    'Run quality checks on all posts in a content plan. Returns per-post scores and aggregate summary.',
    {
      plan: z
        .object({
          posts: z.array(
            z.object({
              id: z.string(),
              caption: z.string(),
              title: z.string().optional(),
              platform: z.string(),
            })
          ),
        })
        .passthrough()
        .describe('Content plan with posts array'),
      threshold: z.number().min(0).max(35).default(26).describe('Minimum total score to pass'),
      response_format: z.enum(['text', 'json']).default('text'),
    },
    async ({ plan, threshold, response_format }) => {
      const startedAt = Date.now();

      const postsWithQuality = plan.posts.map(post => {
        const result = evaluateQuality({
          caption: post.caption,
          title: post.title,
          platforms: [post.platform],
          threshold,
        });
        return {
          ...post,
          quality: {
            score: result.total,
            max_score: result.maxTotal,
            passed: result.passed,
            blockers: result.blockers,
          },
        };
      });

      const scores = postsWithQuality.map(p => p.quality.score);
      const passed = postsWithQuality.filter(p => p.quality.passed).length;
      const avgScore =
        scores.length > 0
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : 0;

      const summary = {
        total_posts: plan.posts.length,
        passed,
        failed: plan.posts.length - passed,
        avg_score: avgScore,
      };

      const durationMs = Date.now() - startedAt;
      logMcpToolInvocation({
        toolName: 'quality_check_plan',
        status: 'success',
        durationMs,
        details: { postCount: plan.posts.length, passed },
      });

      if (response_format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope({ posts: postsWithQuality, summary }), null, 2),
            },
          ],
          isError: false,
        };
      }

      const lines: string[] = [];
      lines.push(`PLAN QUALITY: ${passed}/${plan.posts.length} passed (avg: ${avgScore}/35)`);
      lines.push('');
      for (const post of postsWithQuality) {
        const icon = post.quality.passed ? '[PASS]' : '[FAIL]';
        lines.push(`${icon} ${post.id} | ${post.platform} | ${post.quality.score}/35`);
        if (post.quality.blockers.length > 0) {
          for (const b of post.quality.blockers) {
            lines.push(`       - ${b}`);
          }
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
    }
  );
}
