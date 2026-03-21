#!/usr/bin/env bash
# Social Neuron CLI — Content planning workflow
set -euo pipefail

CLI="npx @socialneuron/mcp-server"

echo "=== Step 1: Check credits ==="
$CLI sn system credits --json

echo -e "\n=== Step 2: List available tools ==="
$CLI sn discovery tools --module planning

echo -e "\n=== Step 3: Check platform connections ==="
$CLI sn account preflight

echo -e "\n=== Step 4: View autopilot config ==="
$CLI sn system autopilot --json
