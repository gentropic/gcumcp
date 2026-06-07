// e2e-fs.mjs — real-browser proof of the shim's `fs` transport. Loads the actual
// shim.js + fs-channel.js in Chromium, mounts an OPFS directory as the exchange
// folder, and runs a round-trip between the SHIM (page-role, via its FSA dir-adapter
// + crypto.subtle HMAC) and an in-page BRIDGE-role FsChannel over the same folder.
// Proves the browser-side glue (FSA adapter, subtle HKDF/HMAC, transport selection)
// that the node smokes can't reach. The real bridge process is covered by
// tools/smoke-fs-bridge.mjs.
//
// Uses the sibling Playwright (../../bridge/node_modules) → LOCAL test, not part of
// the zero-dep `npm run smoke`.  Run: node tools/e2e-fs.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '../../bridge/node_modules/playwright/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const shimCode = fs.readFileSync(path.join(here, '..', 'shim.js'), 'utf8');
const channelCode = fs.readFileSync(path.join(here, '..', 'fs-channel.js'), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.WEBMCP_DEBUG) console.error(`[page:${m.type()}]`, m.text()); });
  // Serve from an https origin so it's a secure context (crypto.subtle is gated off
  // about:blank in headless). Fulfill every request with an empty page.
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
  await page.goto('https://webmcp.test/');
  // Inline fs-channel the way an app build does — weir strips the `export ` keyword and
  // flat-concats — leaving the plain IIFE + the `globalThis.GcuFsChannel` the shim reads.
  await page.addScriptTag({ content: channelCode.replace(/^export /gm, '') });
  await page.addScriptTag({ content: shimCode });        // navigator.modelContext + gcuWebMCP

  // sanity: secure context + the FsChannel global + subtle present
  const env = await page.evaluate(() => ({ secure: window.isSecureContext, channel: !!(window.GcuFsChannel && window.GcuFsChannel.FsChannel), subtle: !!(window.crypto && window.crypto.subtle), opfs: !!(navigator.storage && navigator.storage.getDirectory) }));
  assert.ok(env.channel, 'GcuFsChannel global present');
  assert.ok(env.subtle, 'crypto.subtle present (secure context)');
  assert.ok(env.opfs, 'OPFS available');

  const out = await page.evaluate(async (TOKEN) => {
    const FsChannel = window.GcuFsChannel.FsChannel;

    // a fresh OPFS exchange dir, shared by both ends
    const opfs = await navigator.storage.getDirectory();
    const exch = await opfs.getDirectoryHandle('exch-' + Math.random().toString(16).slice(2), { create: true });

    // FSA dir-adapter (test copy, for the BRIDGE side — the shim has its own internal one)
    function fsaDir(root) {
      const parts = (p) => String(p).split('/').filter(Boolean);
      async function dirOf(segs, create) { let h = root; for (const s of segs) h = await h.getDirectoryHandle(s, { create: !!create }); return h; }
      return {
        async read(name) { const p = parts(name), fn = p.pop(); try { const d = await dirOf(p, false); const fh = await d.getFileHandle(fn); return await (await fh.getFile()).text(); } catch { return null; } },
        async write(name, str) { const p = parts(name), fn = p.pop(); const d = await dirOf(p, true); const fh = await d.getFileHandle(fn, { create: true }); const w = await fh.createWritable(); try { await w.write(str); } finally { await w.close(); } },
        async list(dp) { try { const d = await dirOf(parts(dp), false); const out = []; for await (const k of d.keys()) out.push(k); return out; } catch { return []; } },
        async remove(name) { const p = parts(name), fn = p.pop(); try { const d = await dirOf(p, false); await d.removeEntry(fn); } catch {} },
        async mkdirp(dp) { await dirOf(parts(dp), true); },
        async rmrf(dp) { const p = parts(dp), last = p.pop(); try { const d = await dirOf(p, false); await d.removeEntry(last, { recursive: true }); } catch {} },
      };
    }
    async function fsHmac(token, id) {
      const enc = new TextEncoder();
      const ikm = await crypto.subtle.importKey('raw', enc.encode(token), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('numen-fs|' + id) }, ikm, 256);
      const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return async (str) => { const s = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(str))); let h = ''; for (const b of s) h += b.toString(16).padStart(2, '0'); return h; };
    }

    // ── BRIDGE side (simulates the node bridge / Claude): welcome, then invoke echo ──
    let echoed = null;
    const bridge = new FsChannel({
      role: 'bridge', dir: fsaDir(exch), hmac: await fsHmac(TOKEN, 'weir'),
      now: () => Date.now(), randomId: () => Math.random().toString(16).slice(2, 18),
      onMessage(m) {
        if (m.type === 'hello') bridge.send({ type: 'welcome', id: 'weir', protocol: 1 });
        else if (m.type === 'tools_changed') bridge.send({ type: 'tool_invoke', callId: 'c1', name: 'echo', input: { text: 'hello over opfs' } });
        else if (m.type === 'tool_result') echoed = m.result;
      },
    });
    await bridge.start();
    let bb = false;
    const bt = setInterval(() => { if (bb) return; bb = true; Promise.resolve().then(() => bridge.tick()).catch(() => {}).then(() => { bb = false; }); }, 60);

    // ── PAGE side (the SHIM under test): inject the folder, register echo, connect ──
    const m = window.gcuWebMCP;
    m.name = 'weir';
    m.folder = exch;                       // ⇒ forces the fs transport
    navigator.modelContext.registerTool({
      name: 'echo', description: 'Echo text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async ({ text }) => ({ echoed: text, by: m.clientId }),
    });
    m.connect(TOKEN);                       // bare token (no port) — fs branch

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !echoed) await new Promise((r) => setTimeout(r, 50));
    clearInterval(bt);
    return { state: m.state, clientId: m.clientId, echoed };
  }, 'machine-token-abc123');

  assert.equal(out.state, 'connected', 'shim reached state=connected over the fs transport');
  assert.equal(out.clientId, 'weir', 'welcome assigned the client id');
  assert.ok(out.echoed, 'a tool_result came back to the bridge');
  assert.equal(out.echoed.echoed, 'hello over opfs', 'tool payload round-tripped through OPFS');
  assert.equal(out.echoed.by, 'weir', 'tool ran in the page with the right client id');
  assert.equal(errors.length, 0, `no page errors (${errors.join('; ')})`);

  console.log('browser fs e2e ok:', JSON.stringify(out));
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error(e);
  try { await browser.close(); } catch {}
  process.exit(1);
}
