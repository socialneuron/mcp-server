#!/usr/bin/env bash
# Manage content plans via CLI.

# List all content plans
socialneuron-mcp sn plan list

# View a specific plan
socialneuron-mcp sn plan view --id "plan_abc123"

# Approve a plan
socialneuron-mcp sn plan approve --id "plan_abc123"

# List and filter tools
socialneuron-mcp sn tools --module content
socialneuron-mcp sn tools --scope mcp:write

# View account info
socialneuron-mcp sn info
