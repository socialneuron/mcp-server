#!/usr/bin/env bash
# Extract brand identity from a URL and save it.
# Requires: curl, jq
# Scope: mcp:read, mcp:write

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# 1. Extract brand from website
echo "=== Extracting brand identity ==="
BRAND=$(curl -s "$BASE/brand/extract" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}')

echo "$BRAND" | jq '.data'

# 2. Get current brand profile
echo ""
echo "=== Current brand profile ==="
curl -s "$BASE/brand" \
  -H "Authorization: Bearer $API_KEY" | jq '.data'
