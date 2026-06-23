#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

if (!pkg.version || typeof pkg.version !== 'string') {
  throw new Error('package.json version must be a string');
}

const output = `/** Single source of truth for the MCP server version. */\nexport const MCP_VERSION = ${JSON.stringify(pkg.version)};\n`;
writeFileSync(resolve(root, 'src/lib/version.ts'), output, 'utf8');
