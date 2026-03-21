#!/usr/bin/env bash
# Social Neuron CLI — Analytics report workflow
set -euo pipefail

CLI="npx @socialneuron/mcp-server"

echo "=== Credit balance ==="
$CLI sn system credits --json

echo -e "\n=== Top posts ==="
$CLI sn analytics posts --limit 5 --json

echo -e "\n=== Refresh analytics ==="
$CLI sn analytics refresh

echo -e "\n=== Growth loop summary ==="
$CLI sn analytics loop --json
