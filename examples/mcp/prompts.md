# MCP Tool Usage — Example Prompts for Claude

These prompts show how to use Social Neuron's 73 MCP tools directly in Claude Code, Claude Desktop, VS Code, or Cursor.

## Content Ideation

> "What are the trending topics in tech on YouTube right now?"

> "Generate 5 content ideas about sustainable fashion for Gen Z on TikTok"

> "Look at my recent analytics and suggest content topics that would perform well"

## Content Creation

> "Create a 30-second video of a product demo for my latest launch using veo3"

> "Generate a carousel post about remote work tips for LinkedIn with 5 slides"

> "Write a YouTube script about why AI content tools are essential in 2026"

> "Create an image for my Instagram post about morning routines using midjourney"

## Content Planning

> "Plan my content for next week across YouTube, TikTok, and Instagram"

> "Show me my current content plan and suggest improvements"

> "Schedule all approved posts in my plan using the best time slots"

## Cross-Platform

> "Take my latest YouTube script and adapt it for TikTok, LinkedIn, and Twitter"

> "Schedule this video to all my connected platforms at optimal times"

## Analytics & Optimization

> "Show me my best-performing content this month"

> "What are the best times to post on TikTok based on my audience?"

> "Refresh my analytics and give me insights on what to improve"

> "Compare my YouTube and TikTok performance over the last 30 days"

## Brand Management

> "Extract my brand identity from my website at example.com"

> "Show me my current brand profile and voice guidelines"

## Comment Engagement

> "Show me the latest comments on my YouTube videos"

> "Reply to the top 5 comments with personalized responses"

> "Moderate pending comments — approve genuine ones, flag spam"

## Automation

> "Set up autopilot to post 3 times per week on TikTok and Instagram"

> "Check my autopilot status and upcoming scheduled posts"

## Full Workflow (Autonomous Loop)

> "Run a complete content cycle: check my analytics, generate a content plan based on what's working, create the media, quality check everything, and schedule it all"

This prompt triggers the E2E automation loop:
1. `get_loop_summary` → assess current state
2. `plan_content_week` → generate plan from insights
3. `generate_video` / `generate_image` → create assets
4. `quality_check` → validate before publishing
5. `schedule_post` → distribute to platforms
