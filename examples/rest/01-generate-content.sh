#!/usr/bin/env bash
# Generate text content (script, caption, hook) via the REST API.
# Requires: curl, jq
# Scope: mcp:write

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# Generate a TikTok script
curl -s "$BASE/content/generate" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "5 productivity tips for remote workers",
    "platform": "tiktok",
    "content_type": "script",
    "tone": "energetic"
  }' | jq .
