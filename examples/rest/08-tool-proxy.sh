#!/usr/bin/env bash
# Use the universal tool proxy to call any of the 74 MCP tools via REST.
# Useful when there's no dedicated REST endpoint for a tool.
# Requires: curl, jq

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# 1. List available tools
echo "=== Available tools ==="
curl -s "$BASE/tools" \
  -H "Authorization: Bearer $API_KEY" | jq '.data.tools | length'
echo " tools available"

# 2. Filter tools by module
echo ""
echo "=== Content tools ==="
curl -s "$BASE/tools?module=content" \
  -H "Authorization: Bearer $API_KEY" | jq '.data.tools[] | .name'

# 3. Execute a tool via the proxy
echo ""
echo "=== Running quality_check via tool proxy ==="
curl -s "$BASE/tools/quality_check" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Check out our new AI tool! #ai #tech",
    "platform": "instagram",
    "content_type": "caption"
  }' | jq .

# 4. Check credit balance
echo ""
echo "=== Credits ==="
curl -s "$BASE/credits" \
  -H "Authorization: Bearer $API_KEY" | jq '.data'
