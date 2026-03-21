#!/usr/bin/env bash
# Social Neuron REST API — Generate content
set -euo pipefail

BASE_URL="https://mcp.socialneuron.com/v1"
AUTH="Authorization: Bearer ${SN_API_KEY:?Set SN_API_KEY environment variable}"

echo "=== Generate content (convenience endpoint) ==="
curl -s -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "sustainable fashion trends for Gen Z",
    "platforms": ["instagram", "tiktok"],
    "tone": "casual and engaging",
    "content_type": "hook"
  }' \
  "$BASE_URL/content/generate" | jq '.data'

echo -e "\n=== Generate content (tool proxy) ==="
curl -s -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "AI productivity tips",
    "platforms": ["linkedin"],
    "response_format": "json"
  }' \
  "$BASE_URL/tools/generate_content" | jq '.data'
