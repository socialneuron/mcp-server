#!/usr/bin/env bash
# Quick analytics and health checks via CLI.
# All commands support --json for machine-readable output.

# Check system health and connectivity
socialneuron-mcp health

# View recent posts
socialneuron-mcp sn posts --days 7 --platform youtube

# Refresh analytics data
socialneuron-mcp sn refresh-analytics

# Check credit balance
socialneuron-mcp sn credits

# View API usage
socialneuron-mcp sn usage --json

# Run quality check on content
socialneuron-mcp sn quality-check --content "Check out our new AI tool! #ai #tech"
