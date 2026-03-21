#!/usr/bin/env bash
# Social Neuron REST API — List and search tools
# Requires: SN_API_KEY environment variable
set -euo pipefail

BASE_URL="https://mcp.socialneuron.com/v1"
AUTH="Authorization: Bearer ${SN_API_KEY:?Set SN_API_KEY environment variable}"

echo "=== List all tools ==="
curl -s -H "$AUTH" "$BASE_URL/tools" | jq '.data.total, .data.modules'

echo -e "\n=== Filter by module (analytics) ==="
curl -s -H "$AUTH" "$BASE_URL/tools?module=analytics" | jq '.data.tools[] | .name'

echo -e "\n=== Search by keyword ==="
curl -s -H "$AUTH" "$BASE_URL/tools?q=brand" | jq '.data.tools[] | {name, description}'
