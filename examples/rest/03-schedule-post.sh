#!/usr/bin/env bash
# Schedule a post to multiple platforms.
# Requires: curl, jq
# Scope: mcp:distribute

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# Schedule a video to YouTube, TikTok, and Instagram
curl -s "$BASE/posts" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "media_url": "https://example.com/my-video.mp4",
    "media_type": "video",
    "caption": "5 productivity tips that changed my life #productivity #remotework",
    "title": "5 Game-Changing Productivity Tips",
    "platforms": ["youtube", "tiktok", "instagram"],
    "scheduled_at": "2026-03-22T14:00:00Z"
  }' | jq .
