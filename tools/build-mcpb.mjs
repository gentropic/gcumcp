// Build the Claude Desktop bundle → dist/gcu-webmcp.mcpb. Assembles the zero-dep
// server (webmcp-bridge.js + fs-channel.js + a type:module package.json so node runs
// the ESM bridge) with manifest.json, then `mcpb pack`. Claude Desktop's bundled Node
// runs it — users install nothing. Run: npm run mcpb  (needs network the first time to
// fetch @anthropic-ai/mcpb via npx). Install: double-click dist/gcu-webmcp.mcpb.
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const stage = path.join(dist, '.mcpb-stage');
const out = path.join(dist, 'gcu-webmcp.mcpb');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['webmcp-bridge.js', 'fs-channel.js', 'manifest.json', 'LICENSE']) copyFileSync(path.join(root, f), path.join(stage, f));
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'gcu-webmcp', version: '0.1.0', type: 'module', private: true }, null, 2) + '\n');

execSync(`npx -y @anthropic-ai/mcpb pack "${stage}" "${out}"`, { stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log('\n→ ' + out + '  (double-click to install in Claude Desktop)');
