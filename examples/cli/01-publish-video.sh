#!/usr/bin/env bash
# Publish a video using the deterministic CLI (no AI involved).
# Useful for CI/CD pipelines and scripts.

# Authenticate first (one-time)
# npx @socialneuron/mcp-server login --device

# Publish a video to multiple platforms
socialneuron-mcp sn publish \
  --media-url "https://example.com/my-video.mp4" \
  --caption "New video! Check out these productivity tips #productivity" \
  --platforms youtube,tiktok,instagram \
  --confirm

# Check the status of the scheduling job
socialneuron-mcp sn status --job-id "job_abc123"
