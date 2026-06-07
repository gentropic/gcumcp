// smoke-fs-watch.mjs — multi-surface watch mode: ONE bridge (`--transport fs --watch
// <dir>`) serves EVERY surface folder under <dir>. Spawns the real bridge, pre-creates
// two surface folders (alpha, beta), runs a mock page per surface (each with its own
// per-app key), and drives MCP: listClients shows BOTH, and a tool call routes to each
// via the `client` param. The Claude-Desktop model. Run: node tools/smoke-fs-watch.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { FsChannel } from '../fs-channel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'numen-bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-watch-home-'));
const watch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-watch-'));
fs.mkdirSync(path.join(watch, 'alpha'), { recursive: true });   // pre-create so the first scan finds them
fs.mkdirSync(path.join(watch, 'beta'), { recursive: true });
const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
const proc = spawn('node', [bridgePath, '--transport', 'fs', '--watch', watch], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let outBuf = ''; const waiters = new Map(); let nid = 1;
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (c) => { outBuf += c; let i; while ((i = outBuf.indexOf('\n')) !== -1) { const ln = outBuf.slice(0, i).trim(); outBuf = outBuf.slice(i + 1); if (!ln) continue; const m = JSON.parse(ln); if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
const mcp = (method, params) => new Promise((res) => { const id = nid++; waiters.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

let surfaces = 0;
proc.stderr.setEncoding('utf8');
const ready = new Promise((res) => proc.stderr.on('data', (d) => { const m = String(d).match(/fs surface/g); if (m) surfaces += m.length; if (surfaces >= 2) res(); }));
const fail = (e) => { console.error(e); cleanup(); process.exit(1); };
proc.on('error', fail);
function cleanup() { try { proc.kill(); } catch {} for (const d of [tmpHome, watch]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }

await Promise.race([ready, sleep(6000).then(() => { throw new Error('bridge did not announce 2 surfaces'); })]).catch(fail);

const token = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gcu', 'numen.json'), 'utf8')).token;
const keyFor = (app) => Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.alloc(0), Buffer.from('numen-fs|' + app, 'utf8'), 32));
function makeDir(root) {
  const P = (n) => path.join(root, n);
  return {
    async read(n) { try { return await readFile(P(n), 'utf8'); } catch { return null; } },
    async write(n, s) { const f = P(n); await writeFile(f + '.tmp', s); await rename(f + '.tmp', f); },
    async list(d) { try { return await readdir(P(d)); } catch { return []; } },
    async remove(n) { try { await rm(P(n)); } catch {} },
    async mkdirp(d) { await mkdir(P(d), { recursive: true }); },
    async rmrf(d) { try { await rm(P(d), { recursive: true, force: true }); } catch {} },
  };
}
function makePage(app) {
  const dir = makeDir(path.join(watch, app));
  const hmac = (s) => createHmac('sha256', keyFor(app)).update(s).digest('hex');
  const p = new FsChannel({
    role: 'page', dir, hmac, now: Date.now, randomId: () => randomBytes(8).toString('hex'),
    onMessage(m) {
      if (m.type === 'welcome') p.send({ type: 'tools_changed', tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
      else if (m.type === 'tool_invoke' && m.name === 'echo') p.send({ type: 'tool_result', callId: m.callId, result: { by: app, text: m.input.text } });
    },
  });
  p.send({ type: 'hello', name: app, title: app, path: 'fs://' + app });
  return p;
}

const pages = [makePage('alpha'), makePage('beta')];
await Promise.all(pages.map((p) => p.start()));
const tick = setInterval(() => pages.forEach((p) => p.tick().catch(() => {})), 40);

try {
  await mcp('initialize', {});
  // wait for BOTH surfaces to become ready clients
  let clients = [];
  for (let i = 0; i < 80; i++) {
    clients = JSON.parse((await mcp('tools/call', { name: 'numen_listClients', arguments: {} })).result.content[0].text);
    if (clients.length >= 2) break;
    await sleep(120);
  }
  assert.equal(clients.length, 2, 'ONE bridge serves TWO surfaces simultaneously');
  assert.ok(clients.every((c) => c.transport === 'fs'), 'both over fs');
  assert.ok(clients.find((c) => c.id === 'alpha') && clients.find((c) => c.id === 'beta'), 'both surfaces present');

  const ra = JSON.parse((await mcp('tools/call', { name: 'echo', arguments: { text: 'hi', client: 'alpha' } })).result.content[0].text);
  assert.equal(ra.by, 'alpha', 'tool call routed to the alpha surface');
  const rb = JSON.parse((await mcp('tools/call', { name: 'echo', arguments: { text: 'hi', client: 'beta' } })).result.content[0].text);
  assert.equal(rb.by, 'beta', 'tool call routed to the beta surface');

  console.log('fs-watch (multi-surface) smoke ok:', JSON.stringify({ surfaces: clients.map((c) => c.id) }));
} catch (e) { fail(e); } finally { clearInterval(tick); cleanup(); }
process.exit(0);
