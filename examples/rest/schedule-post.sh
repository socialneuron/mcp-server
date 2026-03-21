#!/usr/bin/env bash
# Social Neuron REST API — Schedule a post
set -euo pipefail

BASE_URL="https://mcp.socialneuron.com/v1"
AUTH="Authorization: Bearer ${SN_API_KEY:?Set SN_API_KEY environment variable}"

echo "=== List connected accounts ==="
curl -s -H "$AUTH" "$BASE_URL/accounts" | jq '.data'

echo -e "\n=== Schedule a post ==="
curl -s -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "media_url": "https://example.com/image.jpg",
    "caption": "Check out our latest collection! #sustainable #fashion",
    "platforms": ["instagram"],
    "schedule_at": "2026-03-25T14:00:00Z"
  }' \
  "$BASE_URL/distribution/schedule" | jq '.'

echo -e "\n=== List recent posts ==="
curl -s -H "$AUTH" "$BASE_URL/posts?limit=5" | jq '.data'
