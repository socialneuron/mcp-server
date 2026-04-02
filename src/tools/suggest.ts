import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { logMcpToolInvocation } from '../lib/supabase.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope, ContentSuggestion } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

export function registerSuggestTools(server: McpServer): void {
  server.tool(
    'suggest_next_content',
    'Suggest next content topics based on performance insights, past content, and competitor patterns. ' +
      'No AI call, no credit cost — purely data-driven recommendations.',
    {
      project_id: z.string().uuid().optional().describe('Project ID (auto-detected if omitted)'),
      count: z.number().min(1).max(10).default(3).describe('Number of suggestions to return'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ project_id, count, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();

      try {
        const { data: result, error: efError } = await callEdgeFunction<{
          success: boolean;
          insights: Array<{
            insight_type: string;
            insight_data: Record<string, unknown>;
            confidence_score: number;
            generated_at: string;
          }>;
          recentContent: Array<{
            topic?: string;
            platform?: string;
            content_type?: string;
            created_at?: string;
          }>;
          swipeItems: Array<{
            title?: string;
            hook?: string;
            platform?: string;
            engagement_score?: number;
            saved_at?: string;
          }>;
        }>('mcp-data', {
          action: 'suggest-content',
          projectId: project_id,
        });

        if (efError) throw new Error(efError);

        const insights = result?.insights ?? [];
        const recentContent = result?.recentContent ?? [];
        const swipeItems = result?.swipeItems ?? [];

        // Extract patterns from insights
        const hookInsights = insights.filter(
          i => i.insight_type === 'top_hooks' || i.insight_type === 'winning_hooks'
        );

        // Build topic exclusion set (recently covered)
        const recentTopics = new Set(
          recentContent.map(c => c.topic?.toLowerCase()).filter(Boolean)
        );

        // Determine data quality
        const dataQuality: 'strong' | 'moderate' | 'weak' =
          insights.length >= 10 ? 'strong' : insights.length >= 3 ? 'moderate' : 'weak';

        const latestInsightDate = insights[0]?.generated_at ?? null;

        // Generate suggestions
        const suggestions: ContentSuggestion[] = [];

        // Suggestion source 1: Top-performing hooks
        for (const insight of hookInsights.slice(0, Math.ceil(count / 2))) {
          const data = insight.insight_data as Record<string, unknown>;
          const hooks = Array.isArray(data.hooks)
            ? data.hooks
            : Array.isArray(data.top_hooks)
              ? data.top_hooks
              : [];

          for (const hook of hooks.slice(0, 2)) {
            const hookStr =
              typeof hook === 'string'
                ? hook
                : String((hook as Record<string, unknown>).text ?? hook);
            if (suggestions.length >= count) break;

            suggestions.push({
              topic: `Content inspired by winning hook: "${hookStr.slice(0, 80)}"`,
              platform: String(data.platform ?? 'tiktok'),
              content_type: 'caption',
              rationale: 'This hook pattern performed well in your past content.',
              confidence: insight.confidence_score ?? 0.7,
              based_on: ['performance_insights', 'hook_analysis'],
              suggested_hook: hookStr.slice(0, 120),
              suggested_angle: 'Apply this hook style to a fresh topic in your niche.',
            });
          }
        }

        // Suggestion source 2: Swipe file patterns
        for (const swipe of swipeItems.slice(0, Math.ceil(count / 3))) {
          if (suggestions.length >= count) break;
          const title = swipe.title ?? '';
          if (recentTopics.has(title.toLowerCase())) continue;

          suggestions.push({
            topic: `Competitor-inspired: "${title.slice(0, 80)}"`,
            platform: swipe.platform ?? 'instagram',
            content_type: 'caption',
            rationale: `High-performing competitor content (score: ${swipe.engagement_score ?? 'N/A'}).`,
            confidence: 0.6,
            based_on: ['niche_swipe_file', 'competitor_analysis'],
            suggested_hook: swipe.hook ?? `Your take on: ${title.slice(0, 60)}`,
            suggested_angle: 'Put your unique spin on this trending topic.',
          });
        }

        // Suggestion source 3: Format diversification
        if (suggestions.length < count) {
          const recentFormats = recentContent.map(c => c.content_type).filter(Boolean) as string[];
          const formatCounts: Record<string, number> = {};
          for (const f of recentFormats) {
            formatCounts[f] = (formatCounts[f] ?? 0) + 1;
          }

          const allFormats = ['script', 'caption', 'blog', 'hook'];
          const underusedFormats = allFormats.filter(
            f => (formatCounts[f] ?? 0) < (recentFormats.length / allFormats.length) * 0.5
          );

          for (const fmt of underusedFormats.slice(0, count - suggestions.length)) {
            suggestions.push({
              topic: `Try a ${fmt} format — you haven\'t used it recently`,
              platform: 'linkedin',
              content_type: fmt,
              rationale: `You've posted ${formatCounts[fmt] ?? 0} ${fmt}(s) recently vs ${recentFormats.length} total posts. Diversifying formats can reach new audiences.`,
              confidence: 0.5,
              based_on: ['content_history', 'format_analysis'],
              suggested_hook: `Experiment with ${fmt} content for your audience.`,
              suggested_angle: 'Format diversification to increase reach.',
            });
          }
        }

        // Pad with generic suggestion if needed
        if (suggestions.length < count) {
          suggestions.push({
            topic: 'Share a behind-the-scenes look at your process',
            platform: 'instagram',
            content_type: 'caption',
            rationale: 'Behind-the-scenes content consistently drives engagement across platforms.',
            confidence: 0.4,
            based_on: ['general_best_practices'],
            suggested_hook: "Here's what it actually takes to...",
            suggested_angle: 'Authenticity and transparency.',
          });
        }

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'suggest_next_content',
          status: 'success',
          durationMs,
          details: {
            suggestions: suggestions.length,
            data_quality: dataQuality,
            insights_count: insights.length,
          },
        });

        const resultPayload = {
          suggestions: suggestions.slice(0, count),
          data_quality: dataQuality,
          last_analysis_at: latestInsightDate,
        };

        if (format === 'json') {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(asEnvelope(resultPayload), null, 2) },
            ],
          };
        }

        // Text format
        const lines: string[] = [];
        lines.push(`Content Suggestions (${suggestions.length})`);
        lines.push(`Data Quality: ${dataQuality} | Last analysis: ${latestInsightDate ?? 'never'}`);
        lines.push('='.repeat(40));
        for (let i = 0; i < suggestions.length; i++) {
          const s = suggestions[i];
          lines.push(`\n${i + 1}. ${s.topic}`);
          lines.push(`   Platform: ${s.platform} | Type: ${s.content_type}`);
          lines.push(`   Hook: "${s.suggested_hook}"`);
          lines.push(`   Angle: ${s.suggested_angle}`);
          lines.push(`   Rationale: ${s.rationale}`);
          lines.push(`   Confidence: ${Math.round(s.confidence * 100)}%`);
          lines.push(`   Based on: ${s.based_on.join(', ')}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        logMcpToolInvocation({
          toolName: 'suggest_next_content',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Suggestion failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
