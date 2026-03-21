#!/usr/bin/env bash
# Create a content plan, review it, and schedule.
# Requires: curl, jq
# Scope: mcp:write, mcp:distribute

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# 1. Generate a 7-day content plan
echo "=== Creating content plan ==="
PLAN=$(curl -s "$BASE/plans" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "AI productivity tools for solopreneurs",
    "platforms": ["youtube", "tiktok", "instagram"],
    "days": 7
  }')

PLAN_ID=$(echo "$PLAN" | jq -r '.data.id // .data.planId')
echo "Plan created: $PLAN_ID"
echo "$PLAN" | jq '.data.posts | length'
echo " posts generated"

# 2. Review the plan
echo ""
echo "=== Plan details ==="
curl -s "$BASE/plans/$PLAN_ID" \
  -H "Authorization: Bearer $API_KEY" | jq '.data.posts[] | {day: .day, platform: .platform, title: .title}'

# 3. Approve and schedule
echo ""
echo "=== Approving plan ==="
curl -s "$BASE/plans/$PLAN_ID/approve" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "approve"}' | jq .

echo ""
echo "=== Scheduling all posts ==="
curl -s "$BASE/plans/$PLAN_ID/schedule" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"auto_slot": true}' | jq .
