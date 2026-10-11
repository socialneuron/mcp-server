import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['content-calendar', 'analytics-pulse'];
const requiredPackages = ['@modelcontextprotocol/client', '@modelcontextprotocol/core'];
const separator = '\n-----\n';
const closingHead = Buffer.from('</head>');

function decodeUtf8(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Non-round-tripping UTF-8 input');
  return text;
}

async function readLicenseRecord(app, name, lock) {
  const entry = lock.packages['node_modules/' + name];
  if (!entry || typeof entry.version !== 'string') {
    throw new Error(app + ': missing exact lock version for ' + name);
  }
  const directory = path.join(root, 'apps', app, 'node_modules', name);
  const installed = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (installed.name !== name || installed.version !== entry.version) {
    throw new Error(app + ': installed package does not match lock: ' + name);
  }
  const license = await readFile(path.join(directory, 'LICENSE'));
  if (!decodeUtf8(license).trim()) throw new Error(app + ': empty LICENSE for ' + name);
  let notice;
  try {
    notice = await readFile(path.join(directory, 'NOTICE'));
    decodeUtf8(notice);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { label: name + '@' + entry.version, license, notice };
}

function licenseBundle(records) {
  const groups = [];
  for (const record of records) {
    const group = groups.find((candidate) => candidate.license.equals(record.license));
    if (group) group.labels.push(record.label);
    else groups.push({ labels: [record.label], license: record.license });
  }
  const chunks = [Buffer.from('Third-party license texts for the explicitly listed packages only.\n')];
  for (const group of groups) {
    chunks.push(Buffer.from(separator + 'Packages: ' + group.labels.join(', ') + '\nLICENSE:\n'), group.license);
  }
  for (const record of records) {
    if (record.notice !== undefined) {
      chunks.push(Buffer.from(separator + 'NOTICE for ' + record.label + ':\n'), record.notice);
    }
  }
  return Buffer.concat(chunks);
}

async function prepareApp(app) {
  const lock = JSON.parse(await readFile(path.join(root, 'apps', app, 'package-lock.json'), 'utf8'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages ||
      typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error(app + ': expected a v2/v3 lock with a packages map');
  }
  const records = [];
  for (const name of requiredPackages) records.push(await readLicenseRecord(app, name, lock));
  const licenses = licenseBundle(records);
  const source = await readFile(path.join(root, 'apps', app, 'dist', 'mcp-app.html'));
  const sourceText = decodeUtf8(source);
  const index = source.indexOf(closingHead);
  if (index < 0 || source.indexOf(closingHead, index + closingHead.length) !== -1 ||
      sourceText.includes('sn-third-party-licenses')) {
    throw new Error(app + ': expected one exact closing head and no existing attribution marker');
  }
  const escaped = decodeUtf8(licenses).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const block = Buffer.from('<template id="sn-third-party-licenses"><pre>' + escaped + '</pre></template>');
  const html = Buffer.concat([source.subarray(0, index), block, source.subarray(index)]);
  return { directory: path.join(root, 'dist', 'apps', app), html, licenses };
}

// Validate every app before changing any published output.
const prepared = [];
for (const app of apps) prepared.push(await prepareApp(app));
for (const output of prepared) {
  await mkdir(output.directory, { recursive: true });
  await writeFile(path.join(output.directory, 'mcp-app.html'), output.html);
  await writeFile(path.join(output.directory, 'THIRD-PARTY-LICENSES.txt'), output.licenses);
}
console.log('Copied ' + apps.length + ' MCP App bundles with third-party license texts into the publishable dist artifact.');
