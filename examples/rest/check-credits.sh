#!/usr/bin/env bash
# Social Neuron REST API — Check credits and budget
set -euo pipefail

BASE_URL="https://mcp.socialneuron.com/v1"
AUTH="Authorization: Bearer ${SN_API_KEY:?Set SN_API_KEY environment variable}"

echo "=== Credit balance ==="
curl -s -H "$AUTH" "$BASE_URL/credits" | jq '.data'

echo -e "\n=== Budget status ==="
curl -s -H "$AUTH" "$BASE_URL/credits/budget" | jq '.data'
