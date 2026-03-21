#!/usr/bin/env bash
# Manage comments: list, reply, moderate.
# Requires: curl, jq
# Scope: mcp:comments

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# 1. List recent comments
echo "=== Recent comments ==="
curl -s "$BASE/comments?sort=time&limit=10" \
  -H "Authorization: Bearer $API_KEY" | jq '.data'

# 2. Reply to a comment
echo ""
echo "=== Replying to comment ==="
curl -s "$BASE/comments/COMMENT_ID/reply" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Thanks for watching! Glad you found it helpful."}' | jq .

# 3. Moderate a comment (approve, hide, or flag)
echo ""
echo "=== Moderating comment ==="
curl -s "$BASE/comments/COMMENT_ID/moderate" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "approve"}' | jq .
