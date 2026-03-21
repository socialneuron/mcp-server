#!/usr/bin/env bash
# Social Neuron REST API — Analytics and insights
set -euo pipefail

BASE_URL="https://mcp.socialneuron.com/v1"
AUTH="Authorization: Bearer ${SN_API_KEY:?Set SN_API_KEY environment variable}"

echo "=== Fetch analytics ==="
curl -s -H "$AUTH" "$BASE_URL/analytics" | jq '.data'

echo -e "\n=== AI performance insights ==="
curl -s -H "$AUTH" "$BASE_URL/analytics/insights" | jq '.data'

echo -e "\n=== Best posting times ==="
curl -s -H "$AUTH" "$BASE_URL/analytics/best-times" | jq '.data'

echo -e "\n=== Growth loop summary ==="
curl -s -H "$AUTH" "$BASE_URL/loop" | jq '.data'
