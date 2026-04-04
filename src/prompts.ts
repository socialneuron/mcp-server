/**
 * MCP Prompts — pre-built workflow templates for AI agents.
 *
 * These prompts appear in the client's prompt list and provide
 * structured starting points for common Social Neuron workflows.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  // ── 1. Weekly Content Plan ──────────────────────────────────────────
  server.prompt(
    'create_weekly_content_plan',
    'Generate a full week of social media content (7 days, multiple platforms). Returns a structured plan with topics, formats, and posting times.',
    {
      niche: z
        .string()
        .describe('Your content niche or industry (e.g., "fitness coaching", "SaaS marketing")'),
      platforms: z
        .string()
        .optional()
        .describe(
          'Comma-separated platforms to target (default: "YouTube, Instagram, TikTok, LinkedIn")'
        ),
      tone: z
        .string()
        .optional()
        .describe('Brand tone of voice (e.g., "professional", "casual", "bold and edgy")'),
    },
    ({ niche, platforms, tone }) => {
      const targetPlatforms = platforms || 'YouTube, Instagram, TikTok, LinkedIn';
      const brandTone = tone || 'professional yet approachable';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Create a 7-day social media content plan for a ${niche} brand.

Target platforms: ${targetPlatforms}
Brand tone: ${brandTone}

For each day, provide:
1. **Topic/Theme** — what the content is about
2. **Platform** — which platform this piece is for
3. **Format** — (short video, carousel, story, text post, long-form video, etc.)
4. **Hook** — the opening line or thumbnail concept
5. **Key talking points** — 3-4 bullet points
6. **Call to action** — what the audience should do
7. **Best posting time** — optimal time based on platform norms

Use Social Neuron tools:
- Call \`generate_content\` for fresh topic suggestions
- Call \`get_brand_profile\` to align with brand guidelines
- Call \`get_performance_insights\` to learn what's worked before
- Call \`get_best_posting_times\` for optimal scheduling

After building the plan, use \`save_content_plan\` to save it.`,
            },
          },
        ],
      };
    }
  );

  // ── 2. Analyze Top Performing Content ───────────────────────────────
  server.prompt(
    'analyze_top_content',
    'Analyze your best-performing posts to identify patterns and replicate success. Returns insights on hooks, formats, timing, and topics that resonate.',
    {
      timeframe: z
        .string()
        .optional()
        .describe('Analysis period (default: "30 days"). E.g., "7 days", "90 days"'),
      platform: z
        .string()
        .optional()
        .describe('Filter to a specific platform (e.g., "youtube", "instagram")'),
    },
    ({ timeframe, platform }) => {
      const period = timeframe || '30 days';
      const platformFilter = platform ? `\nFocus specifically on ${platform} content.` : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze my top-performing content from the last ${period}.${platformFilter}

Steps:
1. Call \`fetch_analytics\` for overall performance metrics
2. Call \`get_performance_insights\` for AI-generated patterns
3. Call \`get_best_posting_times\` for timing insights

Then provide:
- **Top 5 posts** by engagement with analysis of why they worked
- **Common patterns** in successful hooks, formats, and topics
- **Optimal posting times** by platform
- **Content gaps** — what topics or formats are underrepresented
- **Actionable recommendations** — 5 specific things to do next week

Format as a clear, actionable performance report.`,
            },
          },
        ],
      };
    }
  );

  // ── 3. Repurpose Content ────────────────────────────────────────────
  server.prompt(
    'repurpose_content',
    'Take one piece of content and transform it into 8-10 pieces across multiple platforms and formats.',
    {
      source: z
        .string()
        .describe(
          'The source content to repurpose — a URL, transcript, or the content text itself'
        ),
      target_platforms: z
        .string()
        .optional()
        .describe(
          'Comma-separated target platforms (default: "Twitter, LinkedIn, Instagram, TikTok, YouTube")'
        ),
    },
    ({ source, target_platforms }) => {
      const platforms = target_platforms || 'Twitter, LinkedIn, Instagram, TikTok, YouTube';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Repurpose this content into 8-10 pieces across multiple platforms.

Source content:
${source}

Target platforms: ${platforms}

Generate these variations:
1. **5 standalone tweets** — each a different angle or quote from the source
2. **2 LinkedIn posts** — one thought-leadership, one story-driven
3. **1 Instagram caption** — with relevant hashtags
4. **1 TikTok script** — 30-60 second hook-driven format
5. **1 newsletter section** — key takeaways with a CTA

Use Social Neuron tools:
- Call \`generate_content\` for each platform variation
- Call \`get_brand_profile\` to maintain brand voice consistency
- Call \`quality_check\` to ensure each piece scores 70+

For each piece, include the platform, format, character count, and suggested posting time.`,
            },
          },
        ],
      };
    }
  );

  // ── 4. Brand Voice Setup ────────────────────────────────────────────
  server.prompt(
    'setup_brand_voice',
    'Define or refine your brand voice profile so all generated content stays on-brand. Walks through tone, audience, values, and style.',
    {
      brand_name: z.string().describe('Your brand or business name'),
      industry: z
        .string()
        .optional()
        .describe('Your industry or niche (e.g., "B2B SaaS", "fitness coaching")'),
      website: z.string().optional().describe('Your website URL for context'),
    },
    ({ brand_name, industry, website }) => {
      const industryContext = industry ? ` in the ${industry} space` : '';
      const websiteContext = website ? `\nWebsite: ${website}` : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Help me set up a comprehensive brand voice profile for ${brand_name}${industryContext}.${websiteContext}

I need to define:
1. **Brand personality** — 3-5 adjectives that describe our voice
2. **Target audience** — who we're speaking to (demographics, psychographics)
3. **Tone spectrum** — where we fall on formal↔casual, serious↔playful, technical↔simple
4. **Key messages** — 3 core messages we always communicate
5. **Words we use** — vocabulary that's on-brand
6. **Words we avoid** — vocabulary that's off-brand
7. **Content pillars** — 3-5 recurring content themes

After we define these, use \`save_brand_profile\` to save the profile.
Then use \`generate_content\` to create a sample post to verify the voice sounds right.`,
            },
          },
        ],
      };
    }
  );

  // ── 5. Content Audit ────────────────────────────────────────────────
  server.prompt(
    'run_content_audit',
    'Audit your recent content performance and get a prioritized action plan for improvement.',
    {},
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Run a comprehensive content audit on my Social Neuron account.

Steps:
1. Call \`get_credit_balance\` to check account status
2. Call \`fetch_analytics\` for performance overview
3. Call \`get_performance_insights\` for AI-generated analysis
4. Call \`get_brand_profile\` to check brand alignment
5. Call \`get_best_posting_times\` for scheduling optimization

Deliver a report covering:
- **Account health** — credits remaining, plan tier, usage patterns
- **Performance summary** — posts published, total engagement, trends
- **Top performers** — what's working and why
- **Underperformers** — what's not working and why
- **Consistency score** — posting frequency vs. recommended cadence
- **Brand alignment** — how well content matches brand profile
- **Prioritized action items** — top 5 things to do this week, ranked by impact`,
          },
        },
      ],
    })
  );
}
