// smoke-fs.mjs — proves the `fs` transport core (fs-channel.js) end to end, zero
// deps, no browser, no port. Two FsChannel peers share one temp dir: a BRIDGE peer
// and a PAGE peer. Drives the full handshake + a tool round-trip, then attacks the
// signed-sentinel framing (tamper, replay, partial sync) and asserts each fails
// closed. See TRANSPORTS.md §3–4.
//
// Run: node tools/smoke-fs.mjs   (exit 0 = pass)

import { mkdtemp, readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FsChannel, FS_VERSION } = require('../fs-channel.js');

let failed = 0;
function ok(cond, msg) { if (cond) { console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } }

// ── node adapters (the bridge/shim provide their own; the smoke provides these) ──

const SECRET = Buffer.from('shared-cluster-secret-for-the-smoke');
const hmac = async (str) => createHmac('sha256', SECRET).update(str).digest('hex');
const randomId = () => randomBytes(8).toString('hex');

function makeNodeDir(root) {
  const P = (name) => join(root, name);
  return {
    async read(name) { try { return await readFile(P(name), 'utf8'); } catch { return null; } },
    // atomic on a single fs: write a temp then rename (so a reader never sees a partial file)
    async write(name, str) { const f = P(name); await writeFile(f + '.tmp', str); await rename(f + '.tmp', f); },
    async list(dir) { try { return await readdir(P(dir)); } catch { return []; } },
    async remove(name) { try { await rm(P(name)); } catch { /* missing */ } },
    async mkdirp(dir) { await mkdir(P(dir), { recursive: true }); },
  };
}

// pump both peers until `done()` or a tick cap
async function pump(a, b, done, max = 40) {
  for (let i = 0; i < max; i++) {
    await a.tick(); await b.tick();
    if (done()) return true;
  }
  return done();
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'webmcp-fs-'));
  const dir = makeNodeDir(root);

  // ── 1. full round-trip: hello → welcome → tools_changed → tool_invoke → tool_result ──
  console.log('round-trip:');
  const seen = { welcome: false, invoke: false, result: null, page: [] };

  const bridge = new FsChannel({
    role: 'bridge', dir, hmac, randomId,
    onMessage(m) {
      if (m.type === 'hello') bridge.send({ type: 'welcome', id: 'page-1', protocol: FS_VERSION });
      else if (m.type === 'tools_changed') bridge.send({ type: 'tool_invoke', callId: 'c1', name: 'ping', input: { n: 7 } });
      else if (m.type === 'tool_result') seen.result = m;
    },
  });
  const page = new FsChannel({
    role: 'page', dir, hmac, randomId,
    onMessage(m) {
      seen.page.push(m.type);
      if (m.type === 'welcome') { seen.welcome = true; page.send({ type: 'tools_changed', tools: [{ name: 'ping' }] }); }
      else if (m.type === 'tool_invoke') { seen.invoke = true; page.send({ type: 'tool_result', callId: m.callId, result: { pong: m.input.n * 2 } }); }
    },
  });

  await bridge.start();
  page.send({ type: 'hello', name: 'weir', path: 'test' });   // queued before session exists
  await page.start();

  await pump(bridge, page, () => seen.result);
  ok(seen.welcome, 'page received welcome');
  ok(seen.invoke, 'page received tool_invoke');
  ok(seen.result && seen.result.callId === 'c1', 'bridge received tool_result for the right callId');
  ok(seen.result && seen.result.result && seen.result.result.pong === 14, 'payload round-tripped intact (7 → 14)');
  ok(JSON.stringify(seen.page) === JSON.stringify(['welcome', 'tool_invoke']), 'page delivered in order, exactly once');
  ok(page.state === 'open' && bridge.state === 'open', 'both peers reached state=open');

  // ── 2. tamper: a frame with a bad signature is NOT delivered ──
  console.log('tamper rejection:');
  const sess = bridge.session;
  const tdir = `sessions/${sess}/to-page`;          // bridge's outbox → page reads it
  const badSeq = 99, ts = Date.now(), payload = JSON.stringify({ type: 'tool_invoke', callId: 'evil', name: 'ping', input: {} });
  await dir.write(`${tdir}/${badSeq}.json`, payload);
  await dir.write(`${tdir}/${badSeq}.ready`, JSON.stringify({ v: FS_VERSION, session: sess, dir: 'to-page', seq: badSeq, ts, len: payload.length, sig: 'deadbeef' }));
  const before = seen.page.length;
  await page.tick(); await page.tick();
  ok(seen.page.length === before, 'forged frame (bad HMAC) was not delivered');

  // ── 3. partial sync: sentinel present, payload short → wait, then complete → deliver ──
  console.log('partial-sync tolerance:');
  const pseq = bridge._outSeq;                       // next legit bridge seq
  const good = JSON.stringify({ type: 'ping' });
  const sig = await hmac(`${FS_VERSION}|${sess}|to-page|${pseq}|${ts}|${good.length}|${good}`);
  // write the sentinel + a TRUNCATED payload first (simulates payload not fully synced)
  await dir.write(`${tdir}/${pseq}.json`, good.slice(0, good.length - 2));
  await dir.write(`${tdir}/${pseq}.ready`, JSON.stringify({ v: FS_VERSION, session: sess, dir: 'to-page', seq: pseq, ts, len: good.length, sig }));
  const pingsBefore = seen.page.filter((t) => t === 'ping').length;
  await page.tick();
  ok(seen.page.filter((t) => t === 'ping').length === pingsBefore, 'short payload held back (len mismatch)');
  await dir.write(`${tdir}/${pseq}.json`, good);      // payload finishes syncing
  page._outSeq = pseq + 1;                            // keep the real bridge from colliding on this seq
  await page.tick();
  ok(seen.page.filter((t) => t === 'ping').length === pingsBefore + 1, 'frame delivered once the payload completed');

  // ── 4. replay: re-materialize a consumed frame → NOT re-delivered ──
  console.log('replay rejection:');
  const rseq = pseq;                                 // the seq we just consumed (now <= lastIn)
  await dir.write(`${tdir}/${rseq}.json`, good);
  await dir.write(`${tdir}/${rseq}.ready`, JSON.stringify({ v: FS_VERSION, session: sess, dir: 'to-page', seq: rseq, ts: Date.now(), len: good.length, sig }));
  const pingsNow = seen.page.filter((t) => t === 'ping').length;
  await page.tick();
  ok(seen.page.filter((t) => t === 'ping').length === pingsNow, 'replayed (already-consumed seq) frame was not re-delivered');
  const left = await dir.list(`${tdir}`);
  ok(!left.some((n) => n === `${rseq}.ready`), 'replayed frame was swept');

  await rm(root, { recursive: true, force: true });
}

main().then(() => {
  console.log(failed ? `\nFAIL (${failed})` : '\nPASS');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
