/**
 * MCP Resources — readable data sources for AI agents.
 *
 * Resources expose structured data that agents can read to inform
 * their work without needing to call individual tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callEdgeFunction } from './lib/edge-function.js';
import { MCP_VERSION } from './lib/version.js';

export function registerResources(server: McpServer): void {
  // ── 1. Brand Profile ────────────────────────────────────────────────
  server.resource(
    'brand-profile',
    'socialneuron://brand/profile',
    {
      description:
        'Your brand voice profile including personality traits, target audience, tone, key messages, and content pillars. Read this before generating any content to stay on-brand.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const { data, error } = await callEdgeFunction<{
          success: boolean;
          profile: Record<string, unknown>;
        }>('mcp-data', { action: 'brand-profile' });

        if (error || !data?.success) {
          return {
            contents: [
              {
                uri: 'socialneuron://brand/profile',
                mimeType: 'application/json',
                text: JSON.stringify(
                  {
                    _meta: { version: MCP_VERSION, status: 'no_profile' },
                    message:
                      'No brand profile set up yet. Use the setup_brand_voice prompt or save_brand_profile tool to create one.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri: 'socialneuron://brand/profile',
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
                  ...data.profile,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: 'socialneuron://brand/profile',
              mimeType: 'application/json',
              text: JSON.stringify({
                _meta: { version: MCP_VERSION, status: 'error' },
                message: 'Failed to load brand profile. Check your connection and try again.',
              }),
            },
          ],
        };
      }
    }
  );

  // ── 2. Account Overview ─────────────────────────────────────────────
  server.resource(
    'account-overview',
    'socialneuron://account/overview',
    {
      description:
        'Current account status including plan tier, credit balance, monthly usage, connected platforms, and feature access. A quick snapshot of your Social Neuron account.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const { data, error } = await callEdgeFunction<{
          success: boolean;
          balance: number;
          monthlyUsed: number;
          monthlyLimit: number;
          plan: string;
        }>('mcp-data', { action: 'credit-balance' });

        const overview = {
          _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
          plan: data?.plan || 'unknown',
          credits: {
            balance: data?.balance ?? 0,
            monthlyUsed: data?.monthlyUsed ?? 0,
            monthlyLimit: data?.monthlyLimit ?? 0,
            percentUsed: data?.monthlyLimit
              ? Math.round(((data?.monthlyUsed ?? 0) / data.monthlyLimit) * 100)
              : 0,
          },
          status: error ? 'error' : 'ok',
          docs: 'https://socialneuron.com/for-developers',
          pricing: 'https://socialneuron.com/pricing',
        };

        return {
          contents: [
            {
              uri: 'socialneuron://account/overview',
              mimeType: 'application/json',
              text: JSON.stringify(overview, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: 'socialneuron://account/overview',
              mimeType: 'application/json',
              text: JSON.stringify({
                _meta: { version: MCP_VERSION, status: 'error' },
                message: 'Failed to load account overview.',
              }),
            },
          ],
        };
      }
    }
  );

  // ── 3. Platform Capabilities ────────────────────────────────────────
  server.resource(
    'platform-capabilities',
    'socialneuron://docs/capabilities',
    {
      description:
        'Complete reference of all Social Neuron capabilities: supported platforms, content formats, AI models, credit costs, and feature availability by plan tier.',
      mimeType: 'application/json',
    },
    async () => {
      const capabilities = {
        _meta: { version: MCP_VERSION, generated: new Date().toISOString() },
        platforms: {
          available: ['YouTube', 'Instagram', 'TikTok'],
          coming_soon: ['LinkedIn', 'X/Twitter', 'Facebook', 'Pinterest'],
        },
        content_formats: {
          text: ['Social post', 'Thread', 'Caption', 'Newsletter', 'Blog draft', 'Script'],
          image: ['AI-generated image', 'Quote graphic', 'Carousel slide', 'Thumbnail', 'Story'],
          video: [
            'Short-form (< 60s)',
            'Long-form',
            'Storyboard',
            'Captioned clip',
            'YouTube optimized',
          ],
          audio: ['Background music', 'Voiceover'],
        },
        ai_models: {
          text: ['Gemini 2.5 Flash', 'Gemini 2.5 Pro'],
          image: [
            'Flux 1.1 Pro',
            'DALL-E 3',
            'Stable Diffusion XL',
            'Ideogram',
            'Recraft V3',
            'Mystic V2',
          ],
          video: ['Veo 3', 'Sora 2', 'Runway Gen-4', 'Kling 2.0', 'Minimax', 'Wan 2.1'],
        },
        credit_costs: {
          text_generation: '1-3 credits',
          image_generation: '2-10 credits',
          video_generation: '15-80 credits',
          analytics_query: '0 credits',
          distribution: '1 credit per platform',
        },
        tiers: {
          free: {
            price: '$0/mo',
            credits: 100,
            mcp_access: false,
            features: ['5 free tools', 'Basic content generation'],
          },
          starter: {
            price: '$29/mo',
            credits: 800,
            mcp_access: 'Read + Analytics',
            features: ['All free features', 'MCP read access', 'Analytics', '3 platforms'],
          },
          pro: {
            price: '$79/mo',
            credits: 2000,
            mcp_access: 'Full',
            features: [
              'All Starter features',
              'Full MCP access',
              'Video generation',
              'Autopilot',
              'Priority support',
            ],
          },
          team: {
            price: '$199/mo',
            credits: 6500,
            mcp_access: 'Full + Multi-user',
            features: [
              'All Pro features',
              'Team collaboration',
              'Up to 10 members',
              '50 projects',
              'Advanced analytics',
            ],
          },
        },
      };

      return {
        contents: [
          {
            uri: 'socialneuron://docs/capabilities',
            mimeType: 'application/json',
            text: JSON.stringify(capabilities, null, 2),
          },
        ],
      };
    }
  );

  // ── 4. Getting Started Guide ────────────────────────────────────────
  server.resource(
    'getting-started',
    'socialneuron://docs/getting-started',
    {
      description:
        'Quick start guide for using Social Neuron with AI agents. Covers authentication, first content creation, and common workflows.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [
        {
          uri: 'socialneuron://docs/getting-started',
          mimeType: 'text/plain',
          text: `# Getting Started with Social Neuron MCP Server

## Quick Start

1. Check your account: Read the \`socialneuron://account/overview\` resource
2. Set up your brand: Use the \`setup_brand_voice\` prompt
3. Generate content: Call \`generate_content\` with a topic
4. Review & publish: Call \`schedule_post\` to distribute

## Common Workflows

### Create & Publish a Post
1. \`generate_content\` → get topic suggestions
2. \`generate_content\` → create the post
3. \`quality_check\` → check quality (aim for 70+)
4. \`schedule_post\` → distribute to platforms

### Analyze Performance
1. \`fetch_analytics\` → see overall metrics
2. \`get_performance_insights\` → AI analysis of patterns
3. \`get_best_posting_times\` → optimize scheduling

### Repurpose Content
1. Use the \`repurpose_content\` prompt with your source material
2. Review each generated variation
3. Schedule across platforms using \`save_content_plan\`

### Set Up Autopilot
1. \`get_brand_profile\` → verify brand settings
2. \`update_autopilot_config\` → set schedule and preferences
3. \`update_autopilot_config\` → start automated posting

## Credit Tips
- Text generation: 1-3 credits
- Image generation: 2-10 credits
- Video generation: 15-80 credits
- Check balance anytime: \`get_credit_balance\`

## Need Help?
- Docs: https://socialneuron.com/for-developers
- Support: socialneuronteam@gmail.com
`,
        },
      ],
    })
  );
}
