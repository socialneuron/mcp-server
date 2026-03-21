#!/usr/bin/env bash
# Fetch analytics, insights, and best posting times.
# Requires: curl, jq
# Scope: mcp:read

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

echo "=== Post Performance (last 30 days) ==="
curl -s "$BASE/analytics?days=30&platform=youtube" \
  -H "Authorization: Bearer $API_KEY" | jq .

echo ""
echo "=== AI Insights ==="
curl -s "$BASE/analytics/insights?days=30" \
  -H "Authorization: Bearer $API_KEY" | jq .

echo ""
echo "=== Best Posting Times ==="
curl -s "$BASE/analytics/posting-times?platform=tiktok" \
  -H "Authorization: Bearer $API_KEY" | jq .
