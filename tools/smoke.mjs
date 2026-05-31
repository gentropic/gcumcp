// End-to-end smoke test for @gcu/webmcp: spin the bridge in an isolated $HOME,
// then drive the full path — MCP initialize/tools/list over stdio, a fake page
// connecting over HTTP, tool registration, a round-trip tool call, token
// rejection, and listClients. Zero deps. Run: node tools/smoke.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'webmcp-bridge.js');

// Isolated HOME so we don't touch the real ~/.gcu/webmcp.json.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-webmcp-'));
const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };

const proc = spawn('node', [bridgePath, '--app', 'test', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] });

// ── MCP stdio plumbing ──
let outBuf = '';
const mcpWaiters = new Map();   // id → resolve
let notifyCount = 0;
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
    else if (msg.method && msg.method.startsWith('notifications/')) notifyCount++;
  }
});

let nextId = 1;
function mcp(method, params) {
  const id = nextId++;
  return new Promise((resolve) => { mcpWaiters.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}

// Parse the bridge's chosen port + token from stderr.
let port = null, token = null;
proc.stderr.setEncoding('utf8');
const ready = new Promise((resolve) => {
  proc.stderr.on('data', (d) => {
    const m = String(d).match(/connect a surface with:\s*(\d+):([0-9a-f]+)/);
    if (m) { port = parseInt(m[1], 10); token = m[2]; resolve(); }
  });
});

const fail = (e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); };
proc.on('error', fail);

await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error('bridge did not start in 5s')), 5000))]).catch(fail);

try {
  // ── 1. MCP initialize + tools/list (no surface yet) ──
  const init = await mcp('initialize', {});
  assert.equal(init.result.serverInfo.name, 'gcu-webmcp-test', 'serverInfo carries --app');
  assert.equal(init.result.capabilities.tools.listChanged, true);

  let list = await mcp('tools/list', {});
  let names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('listClients') && names.includes('getConnectionInfo'), 'built-in tools present');
  assert.ok(!names.includes('echo'), 'no surface tools before a page connects');

  // ── 2. Token rejection ──
  const badConnect = await fetch(`http://localhost:${port}/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 1, token: 'wrong', title: 'X', name: 'evil', path: 'http://x/' }),
  });
  assert.equal(badConnect.status, 403, 'bad token rejected');

  // ── 3. A fake page connects over HTTP + registers a tool ──
  const conn = await (await fetch(`http://localhost:${port}/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 1, token, title: 'Test Surface', name: 'test', path: 'http://x/test' }),
  })).json();
  assert.equal(conn.type, 'welcome'); assert.equal(conn.id, 'test', 'client id derives from name');
  const pageId = conn.id;

  // Page poll loop: answer any tool_invoke for `echo`.
  let pollAbort = false;
  (async function pollLoop() {
    while (!pollAbort) {
      let msgs;
      try { msgs = await (await fetch(`http://localhost:${port}/poll?token=${token}&id=${pageId}`)).json(); }
      catch { break; }
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (m.type === 'tool_invoke' && m.name === 'echo') {
          await fetch(`http://localhost:${port}/send`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, id: pageId, message: { type: 'tool_result', callId: m.callId, result: { echoed: m.input.text, by: pageId } } }),
          });
        }
      }
    }
  })();

  await fetch(`http://localhost:${port}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, id: pageId, message: { type: 'tools_changed', tools: [
      { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    ] } }),
  });

  // Give the bridge a moment to remerge + emit list_changed.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(notifyCount >= 1, 'tools/list_changed emitted on registration');

  // ── 4. tools/list now includes the surface tool (single client → no `client` param) ──
  list = await mcp('tools/list', {});
  const echo = list.result.tools.find((t) => t.name === 'echo');
  assert.ok(echo, 'surface tool appears in MCP tool list');
  assert.ok(!echo.inputSchema.properties.client, 'no client param injected for a single surface');
  assert.deepEqual(echo.inputSchema.required, ['text'], 'surface tool schema preserved');

  // ── 5. listClients ──
  const clientsCall = await mcp('tools/call', { name: 'listClients', arguments: {} });
  const clientsList = JSON.parse(clientsCall.result.content[0].text);
  assert.equal(clientsList.length, 1); assert.equal(clientsList[0].id, 'test'); assert.equal(clientsList[0].transport, 'http');

  // ── 6. Round-trip tool call through the page ──
  const call = await mcp('tools/call', { name: 'echo', arguments: { text: 'hello bridge' } });
  assert.ok(!call.result.isError, 'tool call succeeded');
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.echoed, 'hello bridge'); assert.equal(payload.by, 'test');

  // ── 7. Token file was created in the isolated HOME ──
  const tokFile = path.join(tmpHome, '.gcu', 'webmcp.json');
  assert.ok(fs.existsSync(tokFile), 'machine token persisted');
  assert.equal(JSON.parse(fs.readFileSync(tokFile, 'utf8')).token, token, 'persisted token matches advertised');

  pollAbort = true;
  console.log('webmcp smoke ok:', JSON.stringify({ port, client: 'test', notifies: notifyCount }));
} catch (e) {
  fail(e);
} finally {
  try { proc.kill(); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}
process.exit(0);
