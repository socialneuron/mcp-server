#!/usr/bin/env bash
# Generate a video (async) and poll until complete.
# Demonstrates the 202 Accepted → job polling pattern.
# Requires: curl, jq
# Scope: mcp:write

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"
BASE="https://mcp.socialneuron.com/v1"

# 1. Start video generation — returns 202 with job ID
echo "Starting video generation..."
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE/content/video" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A timelapse of a sunrise over mountains with fog rolling through valleys",
    "model": "veo3-fast",
    "aspect_ratio": "16:9",
    "duration": 5
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "202" ]; then
  echo "Error: $BODY"
  exit 1
fi

JOB_ID=$(echo "$BODY" | jq -r '.data.taskId // .data.asyncJobId')
echo "Job started: $JOB_ID"

# 2. Poll for completion
while true; do
  echo "Checking status..."
  STATUS_RESPONSE=$(curl -s "$BASE/jobs/$JOB_ID" \
    -H "Authorization: Bearer $API_KEY")

  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.data.status')
  echo "  Status: $STATUS"

  if [ "$STATUS" = "completed" ]; then
    echo "$STATUS_RESPONSE" | jq '.data.resultUrl'
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "Job failed:"
    echo "$STATUS_RESPONSE" | jq '.data.error'
    exit 1
  fi

  sleep 5
done
