// smoke-fs-bridge.mjs — end-to-end proof of the `fs` transport through the REAL
// bridge process. The spec's named v1 proof (TRANSPORTS §9): Claude Code → a shared
// folder → a (mock) page, with NO port and NO extension.
//
// Spawns gcumcp-bridge.js with `--transport fs --folder <tmp> --app test` in an
// isolated $HOME, reads the machine token it creates, derives the same HMAC key,
// runs a mock PAGE (an FsChannel peer) over the folder, and drives the bridge over
// MCP stdio: initialize, tools/list, listClients, a round-trip tools/call. Zero deps.
//
// Run: node tools/smoke-fs-bridge.mjs   (exit 0 = pass)

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { FsChannel } from '../fs-channel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'gcumcp-bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gcumcp-fs-'));
const exchange = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-fs-exch-'));
const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };

// Launch runtime is configurable so the same e2e exercises node, bun, deno, or a
// COMPILED BINARY. WEBMCP_BRIDGE_RUN is a command template (default `node {script}`);
// `{script}` is replaced with the bridge path, or omitted entirely for a self-contained
// binary (e.g. WEBMCP_BRIDGE_RUN=/path/to/gcumcp-bridge.exe).
const runTmpl = (process.env.WEBMCP_BRIDGE_RUN || 'node {script}').split(' ').filter(Boolean);
const runParts = runTmpl.map((p) => (p === '{script}' ? bridgePath : p));
const bridgeArgs = ['--app', 'test', '--transport', 'fs', '--folder', exchange];
const proc = spawn(runParts[0], [...runParts.slice(1), ...bridgeArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });

// ── MCP stdio plumbing (mirrors smoke.mjs) ──
let outBuf = '';
const mcpWaiters = new Map();
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  outBuf += chunk;
  let i;
  while ((i = outBuf.indexOf('\n')) !== -1) {
    const line = outBuf.slice(0, i).trim();
    outBuf = outBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && mcpWaiters.has(msg.id)) { mcpWaiters.get(msg.id)(msg); mcpWaiters.delete(msg.id); }
  }
});
let nextId = 1;
function mcp(method, params) {
  const id = nextId++;
  return new Promise((resolve) => { mcpWaiters.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}

// Wait for the fs bridge to announce ready on stderr.
proc.stderr.setEncoding('utf8');
const ready = new Promise((resolve) => {
  proc.stderr.on('data', (d) => { if (/fs surface .* on /.test(String(d))) resolve(); });
});
const fail = (e) => { console.error(e); cleanup(); process.exit(1); };
proc.on('error', fail);
function cleanup() {
  try { proc.kill(); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(exchange, { recursive: true, force: true }); } catch {}
}

await Promise.race([ready, sleep(5000).then(() => { throw new Error('fs bridge did not start in 5s'); })]).catch(fail);

// ── mock page: an FsChannel peer over the same folder, with the same derived key ──
const token = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gcu', 'webmcp.json'), 'utf8')).token;
const fsKey = Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.alloc(0), Buffer.from('webmcp-fs|test', 'utf8'), 32));
const hmac = (s) => createHmac('sha256', fsKey).update(s).digest('hex');

const fsp = fs.promises;
const P = (name) => path.join(exchange, name);
const dir = {
  async read(name) { try { return await fsp.readFile(P(name), 'utf8'); } catch { return null; } },
  async write(name, str) { const f = P(name); await fsp.writeFile(f + '.tmp', str); await fsp.rename(f + '.tmp', f); },
  async list(d) { try { return await fsp.readdir(P(d)); } catch { return []; } },
  async remove(name) { try { await fsp.rm(P(name)); } catch {} },
  async mkdirp(d) { await fsp.mkdir(P(d), { recursive: true }); },
  async rmrf(d) { try { await fsp.rm(P(d), { recursive: true, force: true }); } catch {} },
};

const page = new FsChannel({
  role: 'page', dir, hmac, now: Date.now, randomId: () => randomBytes(8).toString('hex'),
  onMessage(m) {
    if (m.type === 'welcome') {
      page.send({ type: 'tools_changed', tools: [
        { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      ] });
    } else if (m.type === 'tool_invoke' && m.name === 'echo') {
      page.send({ type: 'tool_result', callId: m.callId, result: { echoed: m.input.text, by: page.epoch } });
    }
  },
});
page.send({ type: 'hello', name: 'test', title: 'Test Surface', path: 'fs://test' });
await page.start();
let pageBusy = false;
const pageTimer = setInterval(async () => { if (pageBusy) return; pageBusy = true; try { await page.tick(); } catch {} finally { pageBusy = false; } }, 40);

async function waitForTool(name, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const list = await mcp('tools/list', {});
    if (list.result.tools.some((t) => t.name === name)) return list;
    await sleep(120);
  }
  throw new Error(`tool '${name}' did not appear within ${ms}ms`);
}

try {
  // ── 1. initialize ──
  const init = await mcp('initialize', {});
  assert.equal(init.result.serverInfo.name, 'gcumcp-test', 'serverInfo carries --app');

  // ── 2. the page handshakes over the folder; its tool reaches MCP ──
  const list = await waitForTool('echo');
  const echo = list.result.tools.find((t) => t.name === 'echo');
  assert.ok(echo, 'surface tool appeared in the MCP tool list (via the fs folder)');
  assert.deepEqual(echo.inputSchema.required, ['text'], 'surface tool schema preserved across the fs transport');

  // ── 3. listClients shows the fs client ──
  const clientsCall = await mcp('tools/call', { name: 'gcumcp_listClients', arguments: {} });
  const list2 = JSON.parse(clientsCall.result.content[0].text);
  assert.equal(list2.length, 1, 'one connected surface');
  assert.equal(list2[0].transport, 'fs', 'client transport is fs');

  // ── 4. getConnectionInfo reports fs mode (no port) ──
  const info = JSON.parse((await mcp('tools/call', { name: 'gcumcp_getConnectionInfo', arguments: {} })).result.content[0].text);
  assert.equal(info.transport, 'fs', 'getConnectionInfo reports the fs transport');
  assert.equal(info.id, 'test', 'getConnectionInfo reports the fs id');

  // ── 5. round-trip tool call over the folder ──
  const call = await mcp('tools/call', { name: 'echo', arguments: { text: 'hello over a folder' } });
  assert.ok(!call.result.isError, 'tool call succeeded');
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.echoed, 'hello over a folder', 'payload round-tripped through the fs transport');

  console.log('webmcp fs-bridge smoke ok:', JSON.stringify({ transport: 'fs', client: 'test', echoed: payload.echoed }));
} catch (e) {
  fail(e);
} finally {
  clearInterval(pageTimer);
  cleanup();
}
process.exit(0);
