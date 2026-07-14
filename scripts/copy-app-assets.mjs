import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['content-calendar', 'analytics-pulse'];

for (const app of apps) {
  const source = path.join(root, `apps/${app}/dist/mcp-app.html`);
  const destination = path.join(root, `dist/apps/${app}/mcp-app.html`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
console.log(`Copied ${apps.length} MCP App bundles into the publishable dist artifact.`);
