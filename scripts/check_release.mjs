#!/usr/bin/env node
// Release gate: every place that carries the version must agree, and
// CHANGELOG.md must have a section for it.
//
//   node scripts/check_release.mjs [vX.Y.Z] [--notes <file>]
//
// The tag defaults to GITHUB_REF_NAME on tag pushes in Actions (on branch
// pushes it is the branch name, so it is ignored); without one, only the
// files are compared with each other. --notes writes that
// version's CHANGELOG section to <file> for the GitHub Release body.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const json = (p) => JSON.parse(read(p));

const args = process.argv.slice(2);
const notesIdx = args.indexOf('--notes');
const notesFile = notesIdx >= 0 ? args.splice(notesIdx, 2)[1] : null;
const tag = args[0] || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null) || null;

const pkg = json('package.json');
const lock = json('package-lock.json');
const server = json('server.json');
const serverSrc = read('src/server.js').match(/version:\s*'([^']+)'/)?.[1];

const version = pkg.version;
const sources = {
  'package.json': version,
  'package-lock.json': lock.version,
  'package-lock.json packages[""]': lock.packages?.['']?.version,
  'server.json': server.version,
  ...Object.fromEntries((server.packages || []).map((p, i) => [`server.json packages[${i}] (${p.identifier})`, p.version])),
  'src/server.js': serverSrc,
};
if (tag) sources[`tag ${tag}`] = tag.replace(/^v/, '');

const errors = [];
for (const [where, v] of Object.entries(sources)) {
  if (v !== version) errors.push(`${where} is ${v ?? '(missing)'}, expected ${version}`);
}
if (tag && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) errors.push(`tag ${tag} is not vX.Y.Z`);
if (server.name !== pkg.mcpName) errors.push(`server.json name ${server.name} != package.json mcpName ${pkg.mcpName}`);
if (server.packages?.some(p => p.registryType === 'npm' && p.identifier !== pkg.name)) {
  errors.push(`server.json npm identifier != package.json name ${pkg.name}`);
}

const changelog = read('CHANGELOG.md');
const esc = version.replace(/[.+-]/g, '\\$&');
const section = changelog.match(new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm'));
if (!section) errors.push(`CHANGELOG.md has no "## [${version}]" section`);
else if (!section[1].trim()) errors.push(`CHANGELOG.md section for ${version} is empty`);

if (errors.length) {
  console.error(`release check failed for ${version}:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
if (notesFile) writeFileSync(notesFile, section[1].trim() + '\n');
console.log(`release check ok: ${version}${tag ? ` (tag ${tag})` : ''}`);
