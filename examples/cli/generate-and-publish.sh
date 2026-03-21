#!/usr/bin/env bash
# Social Neuron CLI — Generate, quality check, and publish content
set -euo pipefail

CLI="npx @socialneuron/mcp-server"

echo "=== Step 1: Check credits ==="
$CLI sn system credits --json

echo -e "\n=== Step 2: Quality check ==="
$CLI sn content quality-check \
  --content "5 ways AI is changing fashion #sustainable #AI" \
  --platform instagram

echo -e "\n=== Step 3: Publish (dry run) ==="
$CLI sn content e2e \
  --media-url "https://example.com/image.jpg" \
  --caption "5 ways AI is changing fashion #sustainable #AI" \
  --platforms instagram,tiktok \
  --dry-run

echo -e "\n=== Step 4: Publish (for real) ==="
# Uncomment to actually publish:
# $CLI sn content e2e \
#   --media-url "https://example.com/image.jpg" \
#   --caption "5 ways AI is changing fashion #sustainable #AI" \
#   --platforms instagram,tiktok \
#   --confirm
