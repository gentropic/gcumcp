#!/usr/bin/env node
// @gcu/webmcp bridge — MCP stdio server + WebSocket/HTTP relay for GCU browser
// surfaces (weir, auditable notebooks, anything that loads the shim). Zero deps.
// Speaks MCP JSON-RPC on stdin/stdout; WebSocket + HTTP long-poll on localhost.
//
// Topology (see SPEC.md §2): ONE bridge per app, on a stable per-app PORT, with a
// machine-global TOKEN. A page configured with the same port/token connects, and
// only that app's surfaces ever reach this bridge — no cross-app crosstalk.
//
//   webmcp-bridge.js --app weir --port 7801
//
// The token is read from / created in ~/.gcu/webmcp.json so it survives restarts
// and every bridge on the machine shares it. The port is NOT a secret; the token
// is. (Ports are app identity; the token gates who may attach to localhost.)

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FsChannel } from './fs-channel.js';

// ── Configuration ──

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const TOOL_CALL_TIMEOUT = 120000;
const STALE_TIMEOUT = 10000;
const HTTP_POLL_TIMEOUT = 25000;
const HTTP_STALE_TIMEOUT = 60000;

// ── CLI args ──

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

// Expand a leading ~ to the home dir (node does NOT do shell tilde expansion, and
// .mcp.json args aren't shell-interpreted) — so a portable, committable, username-free
// `--folder ~/webmcp/weir` works on every machine.
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const APP_NAME = argVal('--app', '') || process.env.GCU_WEBMCP_APP || '';
const PREFERRED_PORT = parseInt(argVal('--port', process.env.GCU_WEBMCP_PORT || '0'), 10) || 0;

// Transport: 'socket' (ws/http on a localhost port, the default) or 'fs' (a shared
// folder, TRANSPORTS.md). FS_ID keys the shared secret per app (the page derives the
// same key from the same token + its gcuWebMCP.name). ALLOW is the capability gate.
const TRANSPORT = (argVal('--transport', '') || 'socket').toLowerCase();
const FS_ID = argVal('--fs-id', '') || APP_NAME;
// Exchange folder. Convention (the standard, like the per-app port): ~/webmcp/<app>,
// the default when --folder is omitted in fs mode. ~ is expanded; the dir is created
// on start if missing.
const FOLDER = expandHome(argVal('--folder', '') || process.env.GCU_WEBMCP_FOLDER
  || (TRANSPORT === 'fs' ? '~/webmcp/' + (FS_ID || 'surface') : ''));
const FS_POLL_MS = parseInt(argVal('--poll', ''), 10) || 200;
const ALLOW = (argVal('--allow', '') || '*').split(',').map((s) => s.trim()).filter(Boolean);

// ── Machine-global token (~/.gcu/webmcp.json) ──

function configPath() {
  const dir = path.join(os.homedir(), '.gcu');
  return { dir, file: path.join(dir, 'webmcp.json') };
}

function loadOrCreateToken() {
  const { dir, file } = configPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg && typeof cfg.token === 'string' && cfg.token.length >= 16) return cfg.token;
  } catch { /* missing / unreadable → create below */ }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token, created: new Date().toISOString() }, null, 2) + '\n');
    // Best-effort tighten perms (no-op on Windows).
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  } catch (e) { stderr(`could not persist token to ${file}: ${e.message} (using ephemeral)`); }
  return token;
}

const sessionToken = loadOrCreateToken();

// fs transport: per-app HMAC key = HKDF-SHA256 of the machine token with an EMPTY
// salt and info='webmcp-fs|<FS_ID>' (32 bytes). The info (not the salt) carries the
// app id, so the same machine token yields a distinct key per app and the page
// derives the identical key from the same token + its app id via crypto.subtle. The
// key never travels — only the machine token does (provisioned out-of-band, §4.1).
const fsKey = TRANSPORT === 'fs'
  ? Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sessionToken, 'utf8'), Buffer.alloc(0), Buffer.from('webmcp-fs|' + FS_ID, 'utf8'), 32))
  : null;

// Capability gate (SPEC: TRANSPORTS §4) — a launch-time allow-list of tool-name
// globs; built-ins always allowed. Applies to every transport. `*`→`.*`, anchored;
// all other regex metachars (incl. `?`) are escaped so a glob can't over-match.
const allowRes = ALLOW.map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$'));
function toolAllowed(name) {
  if (name === 'listClients' || name === 'getConnectionInfo') return true;
  return allowRes.some((re) => re.test(name));
}

// ── State ──

const clients = new Map();             // id → { send, title, path, tools, state, transport, ... }
const canonicalTools = new Map();      // toolName → { clientId, schema, providers: Set }
const pendingCalls = new Map();        // callId → { resolve, reject, timer }
let clientCounter = 0;
let mcpInitialized = false;

function resolveClientId(name, path) {
  // Use provided name, or fall back to client-N.
  const base = name || `client-${++clientCounter}`;
  if (!clients.has(base)) return base;
  // Same path → reconnect, reuse the id.
  const existing = clients.get(base);
  if (existing && existing.path === path) return base;
  // Name collision with a different surface → append a number.
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!clients.has(candidate)) return candidate;
    const ex = clients.get(candidate);
    if (ex && ex.path === path) return candidate;
  }
}

// ── Minimal WebSocket server (RFC 6455, text frames, localhost) ──

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB5DC85B11';

function computeAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function sendWs(ws, obj) {
  try { ws.write(encodeFrame(1, JSON.stringify(obj))); } catch (e) { /* dead socket */ }
}

function sendPing(ws) {
  try { ws.write(encodeFrame(9, '')); } catch (e) { /* dead socket */ }
}

// ── Send to client (transport-agnostic) ──

function sendToClient(client, msg) {
  client.send(msg);
}

// ── Client message handler (shared by WS and HTTP) ──

function handleClientMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  if (process.env.GCU_WEBMCP_DEBUG) stderr(`recv ${clientId} ${msg && msg.type}`);

  if (msg.type === 'tools_changed') {
    clearTimeout(client.staleTimer);
    client.state = 'ready';
    client.tools = msg.tools || [];
    remergeTools();
    if (client.transport === 'ws') startHeartbeat(client);

  } else if (msg.type === 'tool_result') {
    const pending = pendingCalls.get(msg.callId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(msg.callId);
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
    }

  } else if (msg.type === 'notification') {
    if (mcpInitialized && msg.method) {
      sendMcp({
        jsonrpc: '2.0',
        method: 'notifications/' + msg.method,
        params: { client: clientId, ...(msg.params || {}) },
      });
    }
  }
}

// ── WS heartbeat ──

function startHeartbeat(client) {
  client.heartbeatTimer = setInterval(() => {
    sendPing(client.ws);
    client.pongTimer = setTimeout(() => {
      stderr(`client ${client.id} heartbeat timeout`);
      cleanupClient(client.id);
    }, HEARTBEAT_TIMEOUT);
  }, HEARTBEAT_INTERVAL);
}

function cleanupClient(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  clearTimeout(client.staleTimer);
  clearInterval(client.heartbeatTimer);
  clearTimeout(client.pongTimer);
  if (client.ws) client.ws.destroy();
  if (client.pollRes) {
    try { jsonResponse(client.pollRes, 200, []); } catch (e) { /* ignore */ }
    clearTimeout(client.pollTimer);
  }
  clients.delete(clientId);
  remergeTools();
  stderr(`client ${clientId} disconnected`);
}

// ── WebSocket connection handler ──

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  setupWebSocket(socket);
}

function setupWebSocket(ws) {
  let clientId = null;
  let buffer = Buffer.alloc(0);

  ws.on('error', () => { if (clientId) cleanupClient(clientId); else ws.destroy(); });
  ws.on('close', () => { if (clientId) cleanupClient(clientId); });

  ws.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const opcode = firstByte & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let payloadLen = buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (buffer.length < totalLen) return;

      let payload = buffer.slice(offset + maskLen, totalLen);
      if (masked) {
        const mask = buffer.slice(offset, offset + maskLen);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.slice(totalLen);

      if (opcode === 1) {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.type === 'hello') {
          if (msg.protocol !== PROTOCOL_VERSION) {
            sendWs(ws, { type: 'error', message: `Unsupported protocol version ${msg.protocol}. Bridge supports protocol ${PROTOCOL_VERSION}.` });
            ws.destroy();
            return;
          }
          if (msg.token !== sessionToken) {
            sendWs(ws, { type: 'error', message: 'Invalid or missing session token' });
            ws.destroy();
            return;
          }
          clientId = resolveClientId(msg.name, msg.path || '');
          if (clients.has(clientId)) cleanupClient(clientId);
          const client = {
            id: clientId,
            transport: 'ws',
            ws: ws,
            send: (obj) => sendWs(ws, obj),
            title: msg.title || 'Untitled',
            path: msg.path || '',
            tools: [],
            state: 'authenticated',
            staleTimer: null,
            heartbeatTimer: null,
            pongTimer: null,
          };
          clients.set(clientId, client);
          sendWs(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, id: clientId });
          stderr(`client ${clientId} connected (ws): ${client.title}`);
          client.staleTimer = setTimeout(() => {
            if (client.state === 'authenticated') {
              stderr(`client ${clientId} stale (no tools_changed)`);
              sendWs(ws, { type: 'error', message: 'No tools_changed received within timeout' });
              cleanupClient(clientId);
            }
          }, STALE_TIMEOUT);
        } else if (clientId) {
          handleClientMessage(clientId, msg);
        }
      } else if (opcode === 8) {
        if (clientId) cleanupClient(clientId); else ws.destroy();
        return;
      } else if (opcode === 10) {
        const client = clients.get(clientId);
        if (client) clearTimeout(client.pongTimer);
      } else if (opcode === 9) {
        ws.write(encodeFrame(10, payload.toString('utf8')));
      }
    }
  });
}

// ── HTTP polling transport ──

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Private Network Access: let a SECURE public origin (https://gentropic.org/weir)
  // reach this loopback bridge directly — Chromium gates public→loopback and
  // requires the server to opt in on the preflight. (The @gcu/bridge extension
  // path sidesteps PNA entirely; this header is for the no-extension fallback.)
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function jsonResponse(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function flushHttpQueue(client) {
  if (!client.pollRes || client.queue.length === 0) return;
  try { jsonResponse(client.pollRes, 200, client.queue.splice(0)); } catch (e) { /* dead response */ }
  clearTimeout(client.pollTimer);
  client.pollRes = null;
  client.pollTimer = null;
}

function handleHttpRequest(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // POST /connect — handshake
  if (req.method === 'POST' && url.pathname === '/connect') {
    readBody(req).then(body => {
      if (body.protocol !== PROTOCOL_VERSION) {
        return jsonResponse(res, 400, { type: 'error', message: `Unsupported protocol version ${body.protocol}. Bridge supports protocol ${PROTOCOL_VERSION}.` });
      }
      if (body.token !== sessionToken) {
        return jsonResponse(res, 403, { type: 'error', message: 'Invalid or missing session token' });
      }
      const incomingPath = body.path || '';
      const clientId = resolveClientId(body.name, incomingPath);
      if (clients.has(clientId)) cleanupClient(clientId);
      const client = {
        id: clientId,
        transport: 'http',
        ws: null,
        queue: [],
        pollRes: null,
        pollTimer: null,
        send: function (obj) { this.queue.push(obj); flushHttpQueue(this); },
        title: body.title || 'Untitled',
        path: incomingPath,
        tools: [],
        state: 'authenticated',
        staleTimer: null,
        lastPoll: Date.now(),
      };
      clients.set(clientId, client);
      stderr(`client ${clientId} connected (http): ${client.title}`);

      client.staleTimer = setTimeout(() => {
        if (client.state === 'authenticated') {
          stderr(`client ${clientId} stale (no tools_changed)`);
          cleanupClient(clientId);
        }
      }, STALE_TIMEOUT);

      jsonResponse(res, 200, { type: 'welcome', protocol: PROTOCOL_VERSION, id: clientId });
    }).catch(() => jsonResponse(res, 400, { type: 'error', message: 'Invalid JSON body' }));
    return;
  }

  // POST /send — client sends a message
  if (req.method === 'POST' && url.pathname === '/send') {
    readBody(req).then(body => {
      if (body.token !== sessionToken) return jsonResponse(res, 403, { type: 'error', message: 'Invalid token' });
      const client = clients.get(body.id);
      if (!client || client.transport !== 'http') return jsonResponse(res, 404, { type: 'error', message: 'Client not found' });
      handleClientMessage(body.id, body.message);
      jsonResponse(res, 200, { ok: true });
    }).catch(() => jsonResponse(res, 400, { type: 'error', message: 'Invalid JSON body' }));
    return;
  }

  // GET /poll — long-poll for messages
  if (req.method === 'GET' && url.pathname === '/poll') {
    const token = url.searchParams.get('token');
    const id = url.searchParams.get('id');
    if (token !== sessionToken) return jsonResponse(res, 403, { type: 'error', message: 'Invalid token' });
    const client = clients.get(id);
    if (!client || client.transport !== 'http') return jsonResponse(res, 404, { type: 'error', message: 'Client not found' });
    client.lastPoll = Date.now();

    if (client.queue.length > 0) return jsonResponse(res, 200, client.queue.splice(0));

    if (client.pollRes) {
      try { jsonResponse(client.pollRes, 200, []); } catch (e) { /* ignore */ }
      clearTimeout(client.pollTimer);
    }
    client.pollRes = res;
    client.pollTimer = setTimeout(() => {
      if (client.pollRes === res) { jsonResponse(res, 200, []); client.pollRes = null; client.pollTimer = null; }
    }, HTTP_POLL_TIMEOUT);
    req.on('close', () => {
      if (client.pollRes === res) { client.pollRes = null; clearTimeout(client.pollTimer); client.pollTimer = null; }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

// ── Tool merging ──

function remergeTools() {
  const oldNames = new Set(canonicalTools.keys());
  canonicalTools.clear();

  for (const [cid, client] of clients) {
    if (client.state !== 'ready') continue;
    for (const tool of client.tools) {
      if (canonicalTools.has(tool.name)) {
        canonicalTools.get(tool.name).providers.add(cid);
      } else {
        canonicalTools.set(tool.name, { clientId: cid, schema: tool, providers: new Set([cid]) });
      }
    }
  }

  const newNames = new Set(canonicalTools.keys());
  const changed = oldNames.size !== newNames.size ||
    [...oldNames].some(n => !newNames.has(n)) ||
    [...newNames].some(n => !oldNames.has(n));

  if (changed && mcpInitialized) {
    sendMcp({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
}

function getMcpTools() {
  const tools = [
    {
      name: 'listClients',
      description: 'Use as your first call to discover connected surfaces (browser pages exposing tools via @gcu/webmcp). Returns client IDs, titles, and transport. Most bridges front a single app, so there is usually one client. Client IDs are required by the `client` param of other tools only when more than one is connected.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, title: 'List connected surfaces' },
    },
    {
      name: 'getConnectionInfo',
      description: 'Returns the port:token connection string for this bridge. Give it to the user so a page can connect (paste into its MCP panel, or append #mcp=port:token to its URL). The token is machine-global; the port is this bridge\'s.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, title: 'Get bridge connection string' },
    },
  ];
  const multi = clients.size > 1;
  for (const [name, info] of canonicalTools) {
    if (!toolAllowed(name)) continue;   // hidden by the --allow capability gate
    const schema = { ...info.schema };
    const props = {};
    // Only inject the `client` param when more than one surface is connected —
    // single-app bridges (the common case) keep tool schemas clean.
    if (multi) props.client = { type: 'string', description: 'Client ID (use listClients). Required only when multiple surfaces are connected.' };
    if (schema.inputSchema && schema.inputSchema.properties) Object.assign(props, schema.inputSchema.properties);
    const required = [];
    if (schema.inputSchema && schema.inputSchema.required) required.push(...schema.inputSchema.required);
    tools.push({
      name: schema.name,
      description: schema.description,
      inputSchema: { type: 'object', properties: props, required },
      annotations: schema.annotations || {},
    });
  }
  return tools;
}

// ── Tool call routing ──

function routeToolCall(name, input) {
  return new Promise((resolve, reject) => {
    if (name === 'listClients') {
      const result = [];
      for (const [id, client] of clients) {
        if (client.state !== 'ready') continue;
        result.push({ id, title: client.title, transport: client.transport });
      }
      return resolve(result);
    }

    if (name === 'getConnectionInfo') {
      if (TRANSPORT === 'fs') {
        return resolve({ transport: 'fs', folder: FOLDER, app: APP_NAME || undefined, id: FS_ID || undefined, instructions: 'Mount this folder in the surface (an FSA handle) and connect it with the machine token; the page derives the shared key from token + app id.' });
      }
      const port = server.address().port;
      return resolve({ connectionString: `${port}:${sessionToken}`, port, app: APP_NAME || undefined, instructions: 'Paste into the surface\'s MCP panel, or append #mcp=<connectionString> to its URL.' });
    }

    if (!toolAllowed(name)) return reject(`Tool '${name}' is not in this bridge's --allow list.`);

    // Resolve which connected surface handles this call. With one client, default
    // to it; with several, require the `client` param to disambiguate.
    let clientId = input.client;
    if (!clientId) {
      const ready = [...clients.values()].filter(c => c.state === 'ready' && c.tools.some(t => t.name === name));
      if (ready.length === 1) clientId = ready[0].id;
      else if (ready.length === 0) return reject(`No connected surface offers tool '${name}'. Use listClients.`);
      else return reject(`Multiple surfaces offer '${name}': ${ready.map(c => c.id).join(', ')}. Pass the 'client' parameter to choose one.`);
    }

    const client = clients.get(clientId);
    if (!client) return reject(`Client '${clientId}' is not connected. Use listClients.`);
    if (client.state !== 'ready') return reject(`Client '${clientId}' is still initializing. Try again in a moment.`);
    if (!client.tools.some(t => t.name === name)) return reject(`Client '${clientId}' does not offer tool '${name}'. Use listClients.`);

    const { client: _drop, ...rest } = input;
    const callId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      reject(`Tool call timed out after ${TOOL_CALL_TIMEOUT / 1000}s. The surface may be unresponsive.`);
    }, TOOL_CALL_TIMEOUT);

    pendingCalls.set(callId, { resolve, reject, timer });
    sendToClient(client, { type: 'tool_invoke', callId, name, input: rest });
  });
}

// ── fs transport (TRANSPORTS.md §3): a bridge-role FsChannel over a shared folder ──

let fsChannel = null, fsClientId = null;

function makeFsDir(rootDir) {
  const fsp = fs.promises;
  const root = path.resolve(rootDir);
  // Containment guard: every op resolves under `root` or throws — defense-in-depth so a
  // crafted/forged path segment can never escape the exchange folder (esp. the recursive
  // rmrf). fs-channel also validates session/epoch segments; this is the belt to that.
  const P = (name) => {
    const p = path.resolve(root, name);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`fs path escapes the exchange folder: ${name}`);
    return p;
  };
  return {
    async read(name) { try { return await fsp.readFile(P(name), 'utf8'); } catch { return null; } },
    // atomic on a single fs: temp + rename (a reader never sees a partial local write)
    async write(name, str) { const f = P(name); await fsp.writeFile(f + '.tmp', str); await fsp.rename(f + '.tmp', f); },
    async list(d) { try { return await fsp.readdir(P(d)); } catch { return []; } },
    async remove(name) { try { await fsp.rm(P(name)); } catch { /* missing */ } },
    async mkdirp(d) { await fsp.mkdir(P(d), { recursive: true }); },
    async rmrf(d) { try { await fsp.rm(P(d), { recursive: true, force: true }); } catch { /* missing */ } },
  };
}

// Map verified inbound frames onto the existing client model (same `client` shape +
// handleClientMessage the WS/HTTP paths use). A frame that reaches here is already
// authenticated — the channel rejects any bad-HMAC frame before delivery.
function onFsMessage(msg) {
  if (msg.type === 'hello') {
    const clientId = resolveClientId(msg.name, msg.path || '');
    if (clients.has(clientId)) cleanupClient(clientId);
    const client = {
      id: clientId, transport: 'fs', ws: null,
      send: (obj) => { if (fsChannel) fsChannel.send(obj); },
      title: msg.title || 'Untitled', path: msg.path || '', tools: [], state: 'authenticated', staleTimer: null,
    };
    clients.set(clientId, client);
    fsClientId = clientId;
    sendToClient(client, { type: 'welcome', protocol: PROTOCOL_VERSION, id: clientId });
    stderr(`client ${clientId} connected (fs): ${client.title}`);
    client.staleTimer = setTimeout(() => {
      if (client.state === 'authenticated') { stderr(`client ${clientId} stale (no tools_changed)`); cleanupClient(clientId); }
    }, STALE_TIMEOUT);
  } else if (fsClientId && clients.has(fsClientId)) {
    handleClientMessage(fsClientId, msg);
  }
}

function startFsBridge() {
  if (!FOLDER) { stderr('fs transport requires --folder PATH'); process.exit(1); }
  if (!FS_ID) { stderr('fs transport requires --app NAME (or --fs-id) — it keys the shared secret'); process.exit(1); }
  try { fs.mkdirSync(FOLDER, { recursive: true }); } catch (e) { stderr(`could not create exchange folder ${FOLDER}: ${e.message}`); }
  const dir = makeFsDir(FOLDER);
  const hmac = (s) => crypto.createHmac('sha256', fsKey).update(s).digest('hex');
  fsChannel = new FsChannel({
    role: 'bridge', dir, hmac, now: Date.now,
    randomId: () => crypto.randomBytes(8).toString('hex'),
    onMessage: onFsMessage,
    onState: (s) => stderr(`fs channel ${s}`),
    onWarn: (m) => stderr(`fs: ${m}`),   // always-on: forged/stale frames, bad announce — never hidden
    log: (m) => { if (process.env.GCU_WEBMCP_DEBUG) stderr('fs: ' + m); },
  });
  fsChannel.start().then(() => {
    stderr(`fs bridge on ${FOLDER} (app=${APP_NAME || '?'}, id=${FS_ID})`);
    stderr(`connect the surface to this folder with the machine token (id=${FS_ID})`);
    // Poll loop with a busy-guard so ticks never overlap (TRANSPORTS §3.4).
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await fsChannel.tick(); } catch (e) { stderr(`fs tick error: ${e.message}`); } finally { busy = false; }
    }, FS_POLL_MS);
  }).catch((e) => { stderr(`fs start failed: ${e.message}`); process.exit(1); });
}

// ── MCP stdio transport (newline-delimited JSON-RPC) ──

let stdinBuffer = '';

function sendMcp(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handleMcpMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    mcpInitialized = true;
    const appLabel = APP_NAME ? ` for ${APP_NAME}` : '';
    sendMcp({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: `gcu-webmcp${APP_NAME ? '-' + APP_NAME : ''}`, version: '0.1.0' },
        instructions: `@gcu/webmcp bridge${appLabel}. It relays your tool calls to a running browser surface over localhost. Call listClients to see what is connected, then call the tools that surface advertises (their names and schemas are app-defined). Use getConnectionInfo to get the port:token string if the user still needs to connect a page.`,
      },
    });

  } else if (method === 'notifications/initialized') {
    // no response needed

  } else if (method === 'tools/list') {
    sendMcp({ jsonrpc: '2.0', id, result: { tools: getMcpTools() } });

  } else if (method === 'tools/call') {
    const { name, arguments: args } = params;
    routeToolCall(name, args || {}).then(
      result => sendMcp({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } }),
      error => sendMcp({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof error === 'string' ? error : JSON.stringify(error) }], isError: true } })
    );

  } else if (method === 'ping') {
    sendMcp({ jsonrpc: '2.0', id, result: {} });

  } else if (id) {
    sendMcp({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (line) {
      try { handleMcpMessage(JSON.parse(line)); }
      catch (e) { stderr(`failed to parse MCP message: ${e.message}`); }
    }
  }
});

// ── CLI subcommands ──

function printInfo() {
  const { file } = configPath();
  process.stdout.write(`@gcu/webmcp\n`);
  process.stdout.write(`  app:   ${APP_NAME || '(none — pass --app NAME)'}\n`);
  process.stdout.write(`  token: ${sessionToken}  (from ${file})\n`);
  if (TRANSPORT === 'fs') {
    process.stdout.write(`  transport: fs\n`);
    process.stdout.write(`  folder: ${FOLDER || '(none — pass --folder PATH)'}\n`);
    process.stdout.write(`  fs id:  ${FS_ID || '(pass --app or --fs-id)'}  (keys the shared secret; must match the page)\n`);
    process.stdout.write(`\n.mcp.json snippet:\n`);
    process.stdout.write(JSON.stringify({
      mcpServers: {
        [`webmcp${APP_NAME ? '-' + APP_NAME : ''}`]: {
          command: 'node',
          args: ['webmcp-bridge.js', '--app', APP_NAME || 'APP', '--transport', 'fs', '--folder', FOLDER || '/path/to/exchange'],
        },
      },
    }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`  port:  ${PREFERRED_PORT || '(OS-assigned — pass --port N for a stable app port)'}\n`);
  if (PREFERRED_PORT) process.stdout.write(`  connect a page with: ${PREFERRED_PORT}:${sessionToken}\n`);
  process.stdout.write(`\n.mcp.json snippet:\n`);
  process.stdout.write(JSON.stringify({
    mcpServers: {
      [`webmcp${APP_NAME ? '-' + APP_NAME : ''}`]: {
        command: 'node',
        args: ['webmcp-bridge.js', '--app', APP_NAME || 'APP', '--port', String(PREFERRED_PORT || 78_01)],
      },
    },
  }, null, 2) + '\n');
}

// --setup: friendly, copy-paste onboarding for Claude Code AND Claude Desktop, using
// the no-clone `npx github:` distributable (→ swap to `@gcu/webmcp` once on npm / a
// `jsr:` spec for deno). --info stays terse (app/token/port-or-folder).
function printSetup() {
  const { file } = configPath();
  const app = APP_NAME || 'APP';
  const fsMode = TRANSPORT === 'fs';
  const PKG = 'github:gentropic/webmcp';   // today's no-publish distributable
  const args = fsMode ? ['--app', app, '--transport', 'fs'] : ['--app', app, '--port', String(PREFERRED_PORT || 7801)];
  const w = (s) => process.stdout.write(s);
  w(`@gcu/webmcp — connect "${app}" to Claude Code / Claude Desktop\n\n`);
  w(`  transport: ${fsMode ? 'fs — a shared folder, no port, no browser extension' : 'socket — ws/http on localhost'}\n`);
  w(fsMode ? `  folder:    ${FOLDER}  (auto-created on start)\n` : `  port:      ${PREFERRED_PORT || 7801}\n`);
  w(`  token:     ${sessionToken}\n             (machine-global, from ${file} — the page needs this)\n\n`);
  w(`── Claude Code ──\n`);
  w(`  claude mcp add ${app} --scope user -- npx -y ${PKG} ${args.join(' ')}\n\n`);
  w(`── Claude Desktop ── add to claude_desktop_config.json\n`);
  w(`  (Windows: %APPDATA%\\Claude\\  ·  macOS: ~/Library/Application Support/Claude/)\n`);
  w(JSON.stringify({ mcpServers: { [app]: { command: 'npx', args: ['-y', PKG, ...args] } } }, null, 2) + '\n\n');
  w(`── then, in the page ──\n`);
  if (fsMode) {
    w(`  open ${app}'s WebMCP/Claude settings → pick the folder ${FOLDER},\n`);
    w(`  paste the token above, and "connect over folder". The page remembers it.\n`);
    w(`  Sync that folder (e.g. Syncthing) to drive ${app} from another machine.\n`);
  } else {
    w(`  paste  ${PREFERRED_PORT || 7801}:${sessionToken}  into ${app}'s WebMCP connection field\n`);
    w(`  (a public-origin PWA also needs the @gcu/bridge extension; --transport fs avoids that).\n`);
  }
  w(`\nRuntimes: node — or "bun ..." / "deno run -A ..." run the bridge unmodified.\n`);
}

if (process.argv.includes('--setup')) { printSetup(); process.exit(0); }
if (process.argv.includes('--info')) { printInfo(); process.exit(0); }

// ── Startup ──

function stderr(msg) { process.stderr.write(`[webmcp${APP_NAME ? ':' + APP_NAME : ''}] ${msg}\n`); }

let server = null;

function listen(port, isFallback) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && !isFallback) {
      // Another bridge (or an unrelated process) already holds the preferred app
      // port. Fall back to an OS-assigned one and run independently — pages
      // configured for the preferred port will reach whoever owns it, not us.
      stderr(`port ${port} in use — falling back to an OS-assigned port`);
      listen(0, true);
    } else {
      stderr(`listen error: ${e.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    const connStr = `${actual}:${sessionToken}`;
    stderr(`listening on 127.0.0.1:${actual}${PREFERRED_PORT && actual !== PREFERRED_PORT ? ` (preferred ${PREFERRED_PORT} was taken)` : ''}`);
    stderr(`connect a surface with: ${connStr}   (or #mcp=${connStr})`);
  });
}

if (TRANSPORT === 'fs') {
  startFsBridge();
} else {
  server = http.createServer(handleHttpRequest);
  server.on('upgrade', handleUpgrade);
  listen(PREFERRED_PORT, false);
}

// Sweep stale HTTP clients (no poll within HTTP_STALE_TIMEOUT).
setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (client.transport === 'http' && now - client.lastPoll > HTTP_STALE_TIMEOUT) {
      stderr(`client ${id} stale (no poll for ${Math.round((now - client.lastPoll) / 1000)}s)`);
      cleanupClient(id);
    }
  }
}, 15000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
