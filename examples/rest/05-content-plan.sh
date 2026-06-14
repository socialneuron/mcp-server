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

PLAN_ID=$(echo "$PLAN" | jq -r '.data.plan_id')
echo "Plan created: $PLAN_ID"
echo "$PLAN" | jq '.data.posts | length'
echo " posts generated"

# 2. Review the plan
echo ""
echo "=== Plan details ==="
curl -s "$BASE/plans/$PLAN_ID" \
  -H "Authorization: Bearer $API_KEY" | jq '.data.plan.posts[] | {day: .day, platform: .platform, title: .title}'

# 3. Submit approvals, approve each item, and schedule
echo ""
echo "=== Submitting plan for approval ==="
curl -s "$BASE/plans/$PLAN_ID/approval" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

echo ""
echo "=== Approving plan items ==="
APPROVALS=$(curl -s "$BASE/plans/$PLAN_ID/approvals" \
  -H "Authorization: Bearer $API_KEY")
echo "$APPROVALS" | jq -r '.data.items[].id' | while read -r APPROVAL_ID; do
  curl -s "$BASE/plans/approvals/$APPROVAL_ID/respond" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"decision": "approved"}' | jq .
done

echo ""
echo "=== Scheduling all posts ==="
curl -s "$BASE/plans/$PLAN_ID/schedule" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"auto_slot": true}' | jq .
