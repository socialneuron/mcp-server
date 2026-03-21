#!/usr/bin/env bash
# Example CI/CD pipeline using the Social Neuron CLI.
# Useful for automated content workflows in GitHub Actions, etc.

set -euo pipefail

API_KEY="${SOCIALNEURON_API_KEY:?Set SOCIALNEURON_API_KEY}"

# Pre-flight check
echo "Running pre-flight checks..."
socialneuron-mcp sn preflight --check-urls

# Check OAuth health for connected platforms
echo "Checking OAuth tokens..."
OAUTH_STATUS=$(socialneuron-mcp sn oauth-health --json)
echo "$OAUTH_STATUS"

# Refresh expired tokens
socialneuron-mcp sn oauth-refresh --platform instagram

# Check credits before proceeding
CREDITS=$(socialneuron-mcp sn credits --json)
REMAINING=$(echo "$CREDITS" | jq '.remaining // .credits_remaining')
echo "Credits remaining: $REMAINING"

if [ "$REMAINING" -lt 10 ]; then
  echo "Warning: Low credits. Skipping content generation."
  exit 0
fi

# Publish content
socialneuron-mcp sn publish \
  --media-url "$VIDEO_URL" \
  --caption "$CAPTION" \
  --platforms youtube,tiktok \
  --confirm

echo "Content published successfully."
