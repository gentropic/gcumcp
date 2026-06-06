// @gcu/webmcp shim — WebMCP polyfill + WebSocket/HTTP bridge client.
// Generic: knows nothing about any specific app. Drop it into any page; it
// installs navigator.modelContext (registerTool/unregisterTool) and a small
// window.gcuWebMCP control surface, then relays tool calls to a @gcu/webmcp
// bridge over localhost. Tries WebSocket first; falls back to HTTP long-polling
// (which works from file:// origins where WS is blocked).
//
// Plain script, no imports/exports — inlines cleanly into any single-file build.
//
// Connect: gcuWebMCP.connect("PORT:TOKEN")  (the page usually stores PORT:TOKEN
// in its own config after a one-time paste, then reconnects silently). Or append
// #mcp=PORT:TOKEN to the URL. Set gcuWebMCP.name to a stable per-app id ("weir").
//
// Public-origin transport: a page served from a PUBLIC https origin (e.g.
// gentropic.org/weir) can't reach ws://localhost — Chromium's Local/Private
// Network Access gates public→loopback, and the WS upgrade can't carry the
// preflight. Set `gcuWebMCP.fetch = gcuFetch` (the @gcu/bridge extension's
// brokered fetch, the same one weir uses for Lemonade) and the shim routes its
// HTTP long-poll transport through it, sidestepping the page-origin gate.
// Injecting a fetch forces the HTTP transport (WS is skipped). On localhost/
// file:// dev, leave it unset and WS/direct-HTTP are used.

(function () {
  var PROTOCOL = 1;
  var FS_POLL_MS = 350;             // fs-transport poll cadence (reads are cheap; see TRANSPORTS §3.4)

  var _tools = new Map();
  var _transport = null;            // { type: 'ws'|'http'|'fs', ... }
  var _state = 'disconnected';      // disconnected | connecting | connected | error
  var _clientId = null;
  var _portAndToken = null;
  var _reconnectTimer = null;
  var _name = null;
  var _onStateChange = null;
  var _fetch = null;                // injected fetch for the HTTP transport (e.g. gcuFetch)
  var _folder = null;               // injected FileSystemDirectoryHandle ⇒ forces the fs transport

  // HTTP-transport fetch: the injected one if set, else the global. Injecting one
  // also forces the HTTP transport (see _connect) — that's the public-origin path.
  function _doFetch(url, opts) { return (_fetch || fetch)(url, opts); }

  function _setState(s) {
    _state = s;
    if (_onStateChange) { try { _onStateChange(s, _clientId); } catch (e) { /* host callback */ } }
    // Optional best-effort status element; apps normally use onStateChange instead.
    var el = (typeof document !== 'undefined') && document.getElementById('gcu-mcp-status');
    if (el) {
      el.textContent = s === 'connected' ? ('mcp ' + (_clientId || '')) : s === 'connecting' ? 'mcp…' : s === 'error' ? 'mcp err' : '';
      el.className = 'gcu-mcp-status mcp-' + s;
    }
  }

  function _serializeTools() {
    var tools = [];
    _tools.forEach(function (tool) {
      tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema || undefined, annotations: tool.annotations || undefined });
    });
    return tools;
  }

  function _derivedName() {
    var title = (typeof document !== 'undefined' && document.title) || 'surface';
    // Strip a leading "AppName — " / "AppName - " prefix, then slugify.
    title = title.replace(/^[^—–\-]{1,40}\s*[—–\-]+\s*/, '');
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'surface';
  }

  function _effectiveName() { return _name || _derivedName(); }

  // ── transport-agnostic send ──

  function _send(obj) {
    if (!_transport) return;
    if (_transport.type === 'ws') {
      if (_transport.ws && _transport.ws.readyState === WebSocket.OPEN) _transport.ws.send(JSON.stringify(obj));
    } else if (_transport.type === 'http') {
      _httpSend(obj);
    } else if (_transport.type === 'fs') {
      if (_transport.channel) _transport.channel.send(obj);
    }
  }

  function _teardownTransport() {
    if (!_transport) return;
    var t = _transport;
    if (t.type === 'ws' && t.ws) { try { t.ws.close(); } catch (e) { /* ignore */ } }
    if (t.type === 'http') t.polling = false;
    if (t.type === 'fs') { t.polling = false; if (t.timer) clearInterval(t.timer); if (t.channel) t.channel.stop(); }
    _transport = null;
  }

  // ── WebSocket transport ──

  function _connectWs(port, token) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket('ws://localhost:' + port); } catch (e) { return reject(e); }
      var timer = setTimeout(function () { ws.close(); reject(new Error('timeout')); }, 3000);

      ws.onopen = function () {
        clearTimeout(timer);
        _transport = { type: 'ws', ws: ws };
        _send({ type: 'hello', protocol: PROTOCOL, title: (typeof document !== 'undefined' && document.title) || 'Untitled', name: _effectiveName(), path: (typeof location !== 'undefined' && location.href) || '', token: token });
        _send({ type: 'tools_changed', tools: _serializeTools() });
        resolve();
      };
      ws.onmessage = function (event) { var msg; try { msg = JSON.parse(event.data); } catch (e) { return; } _handleMessage(msg); };
      ws.onclose = function () {
        if (!_transport || _transport.type !== 'ws' || _transport.ws !== ws) return;
        _clientId = null; _transport = null; _setState('disconnected');
        if (_portAndToken) _reconnectTimer = setTimeout(function () { _connect(_portAndToken); }, 2000);
      };
      ws.onerror = function () { clearTimeout(timer); reject(new Error('ws failed')); };
    });
  }

  // ── HTTP polling transport ──

  function _httpSend(obj) {
    if (!_transport || _transport.type !== 'http') return;
    var t = _transport;
    _doFetch('http://localhost:' + t.port + '/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t.token, id: t.id, message: obj }),
    }).catch(function () { /* poll will detect disconnect */ });
  }

  function _connectHttp(port, token) {
    _setState('connecting');
    return _doFetch('http://localhost:' + port + '/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: PROTOCOL, token: token, title: (typeof document !== 'undefined' && document.title) || 'Untitled', name: _effectiveName(), path: (typeof location !== 'undefined' && location.href) || '' }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.type === 'error') throw new Error(data.message);
      _transport = { type: 'http', port: port, token: token, id: data.id, polling: true };
      _clientId = data.id;
      _setState('connected');
      _httpSend({ type: 'tools_changed', tools: _serializeTools() });
      _pollLoop();
    });
  }

  function _pollLoop() {
    if (!_transport || _transport.type !== 'http' || !_transport.polling) return;
    var t = _transport;
    _doFetch('http://localhost:' + t.port + '/poll?token=' + encodeURIComponent(t.token) + '&id=' + encodeURIComponent(t.id))
      .then(function (r) { return r.json(); })
      .then(function (messages) {
        if (!Array.isArray(messages)) return;
        for (var i = 0; i < messages.length; i++) _handleMessage(messages[i]);
        _pollLoop();
      })
      .catch(function () {
        _transport = null; _clientId = null; _setState('disconnected');
        if (_portAndToken) _reconnectTimer = setTimeout(function () { _connect(_portAndToken); }, 2000);
      });
  }

  // ── fs transport (TRANSPORTS.md §3): a page-role FsChannel over an injected
  // FileSystemDirectoryHandle. Reuses fs-channel.js (loaded on the page as the global
  // GcuFsChannel, e.g. concatenated into the app build). No port, no extension. ──

  function _fsChannelCtor() {
    var g = (typeof GcuFsChannel !== 'undefined') ? GcuFsChannel
      : (typeof window !== 'undefined' && window.GcuFsChannel) ? window.GcuFsChannel : null;
    return g && g.FsChannel;
  }

  function _randHex(n) {
    var a = new Uint8Array(n); crypto.getRandomValues(a);
    var s = ''; for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
    return s;
  }

  // FSA dir-adapter: maps the FsChannel '/'-path interface onto a directory handle.
  // FSA has no atomic rename — but the signed sentinel tolerates partial reads, so a
  // plain createWritable is fine (a half-written payload fails its len/hmac and waits).
  function _fsaDir(root) {
    function parts(p) { return String(p).split('/').filter(Boolean); }
    async function dirOf(segs, create) {
      var h = root;
      for (var i = 0; i < segs.length; i++) h = await h.getDirectoryHandle(segs[i], { create: !!create });
      return h;
    }
    return {
      async read(name) {
        var p = parts(name), fn = p.pop();
        try { var d = await dirOf(p, false); var fh = await d.getFileHandle(fn, { create: false }); return await (await fh.getFile()).text(); }
        catch (e) { return null; }
      },
      async write(name, str) {
        var p = parts(name), fn = p.pop();
        var d = await dirOf(p, true);
        var fh = await d.getFileHandle(fn, { create: true });
        var w = await fh.createWritable();
        try { await w.write(str); } finally { await w.close(); }   // always release the OPFS write lock
      },
      async list(dirp) {
        try { var d = await dirOf(parts(dirp), false); var names = []; for await (var key of d.keys()) names.push(key); return names; }
        catch (e) { return []; }
      },
      async remove(name) {
        var p = parts(name), fn = p.pop();
        try { var d = await dirOf(p, false); await d.removeEntry(fn); } catch (e) { /* missing */ }
      },
      async mkdirp(dirp) { await dirOf(parts(dirp), true); },
      async rmrf(dirp) {
        var p = parts(dirp), last = p.pop();
        try { var d = await dirOf(p, false); await d.removeEntry(last, { recursive: true }); } catch (e) { /* missing */ }
      },
    };
  }

  // Derive the per-app HMAC key identically to the bridge: HKDF(token, salt='',
  // info='webmcp-fs|<app id>'), then HMAC-SHA256 over the canonical string → hex.
  async function _fsHmac(token, id) {
    var enc = new TextEncoder();
    var ikm = await crypto.subtle.importKey('raw', enc.encode(token), 'HKDF', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('webmcp-fs|' + id) }, ikm, 256);
    var key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return async function (str) {
      var sig = await crypto.subtle.sign('HMAC', key, enc.encode(str));
      var b = new Uint8Array(sig), hex = '';
      for (var i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
      return hex;
    };
  }

  async function _connectFs(token) {
    var FsChannel = _fsChannelCtor();
    if (!FsChannel) throw new Error('fs transport needs fs-channel.js (global GcuFsChannel) on the page');
    if (!(crypto && crypto.subtle)) throw new Error('fs transport needs crypto.subtle (a secure context)');
    _setState('connecting');
    var hmac = await _fsHmac(token, _effectiveName());
    var channel = new FsChannel({
      role: 'page', dir: _fsaDir(_folder), hmac: hmac,
      now: function () { return Date.now(); },
      randomId: function () { return _randHex(8); },
      onMessage: function (msg) { _handleMessage(msg); },
      onState: function (s) { if (s === 'closed') _setState('disconnected'); },   // 'connected' is set on `welcome`
      onWarn: function (m) { if (typeof console !== 'undefined') console.warn('[gcu-webmcp] fs:', m); },   // always-on (forged/stale frames)
    });
    var t = { type: 'fs', channel: channel, token: token, polling: true, timer: null };
    _transport = t;
    channel.send({ type: 'hello', protocol: PROTOCOL, title: (typeof document !== 'undefined' && document.title) || 'Untitled', name: _effectiveName(), path: (typeof location !== 'undefined' && location.href) || '' });
    channel.send({ type: 'tools_changed', tools: _serializeTools() });
    await channel.start();
    var busy = false;
    t.timer = setInterval(function () {
      if (busy || !t.polling) return;
      busy = true;
      Promise.resolve().then(function () { return channel.tick(); })
        .catch(function (e) { if (typeof console !== 'undefined') console.error('[gcu-webmcp] fs tick', e); })
        .then(function () { busy = false; });
    }, FS_POLL_MS);
  }

  // ── shared message handler ──

  function _handleMessage(msg) {
    if (msg.type === 'welcome') { _clientId = msg.id; _setState('connected'); }
    else if (msg.type === 'tool_invoke') { _handleInvoke(msg); }
    else if (msg.type === 'ping') { _send({ type: 'pong' }); }
    else if (msg.type === 'error') { console.error('[gcu-webmcp]', msg.message); _setState('error'); }
  }

  // ── connect (fs when a folder is injected; else try WS, fall back to HTTP) ──

  function _connect(portAndToken) {
    // fs transport: a folder handle is injected and the connect datum is just the
    // machine token (no port). The page derives the shared key from token + its name.
    if (_folder) {
      var fsToken = String(portAndToken || '').replace(/^fs:/, '').trim();
      if (!fsToken) throw new Error('fs transport needs the machine token (gcuWebMCP.connect("<token>"))');
      _portAndToken = portAndToken;
      _teardownTransport();
      clearTimeout(_reconnectTimer);
      _connectFs(fsToken).catch(function (e) {
        console.error('[gcu-webmcp] fs connection failed:', e.message || e);
        _setState('error');
        if (_portAndToken) _reconnectTimer = setTimeout(function () { _connect(_portAndToken); }, 5000);
      });
      return;
    }

    if (typeof portAndToken !== 'string' || portAndToken.indexOf(':') === -1) throw new Error('Token required: use "port:token" format');
    var forceHttp = /:http$/.test(portAndToken);
    var connStr = (forceHttp || /:ws$/.test(portAndToken)) ? portAndToken.slice(0, portAndToken.lastIndexOf(':')) : portAndToken;
    _portAndToken = portAndToken;
    var idx = connStr.indexOf(':');
    var port = connStr.substring(0, idx);
    var token = connStr.substring(idx + 1);

    _teardownTransport();
    clearTimeout(_reconnectTimer);

    _setState('connecting');
    // Injected fetch (gcuFetch) ⇒ public origin ⇒ HTTP transport (WS can't be brokered).
    var useHttp = forceHttp || !!_fetch || (typeof location !== 'undefined' && location.protocol === 'file:');
    (useHttp ? _connectHttp(port, token) : _connectWs(port, token).catch(function () { return _connectHttp(port, token); }))
      .catch(function (e) {
        console.error('[gcu-webmcp] connection failed:', e.message || e);
        _setState('error');
        if (_portAndToken) _reconnectTimer = setTimeout(function () { _connect(_portAndToken); }, 5000);
      });
  }

  function _disconnect() {
    _portAndToken = null;
    clearTimeout(_reconnectTimer);
    _teardownTransport();
    _clientId = null;
    _setState('disconnected');
  }

  function _handleInvoke(msg) {
    var tool = _tools.get(msg.name);
    if (!tool) { _send({ type: 'tool_result', callId: msg.callId, error: 'Tool not found: ' + msg.name }); return; }
    var client = { requestUserInteraction: function (cb) { return cb(); } };
    Promise.resolve()
      .then(function () { return tool.execute(msg.input || {}, client); })
      .then(function (result) { _send({ type: 'tool_result', callId: msg.callId, result: result }); })
      .catch(function (e) { _send({ type: 'tool_result', callId: msg.callId, error: (e && e.message) || String(e) }); });
  }

  // ── polyfill navigator.modelContext ──

  if (typeof navigator !== 'undefined' && !navigator.modelContext) {
    navigator.modelContext = {
      registerTool: function (tool) {
        if (!tool || !tool.name) throw new Error('Tool must have a name');
        _tools.set(tool.name, tool);
        if (_state === 'connected') _send({ type: 'tools_changed', tools: _serializeTools() });
      },
      unregisterTool: function (name) {
        _tools.delete(name);
        if (_state === 'connected') _send({ type: 'tools_changed', tools: _serializeTools() });
      },
    };
  }

  // ── public control surface ──

  var api = {
    connect: _connect,
    disconnect: _disconnect,
    notify: function (method, params) { _send({ type: 'notification', method: method, params: params }); },
    get state() { return _state; },
    get clientId() { return _clientId; },
    get name() { return _effectiveName(); },
    set name(v) { _name = v || null; },
    get derivedName() { return _derivedName(); },
    get tools() { var n = []; _tools.forEach(function (t) { n.push(t.name); }); return n; },   // registered tool names (introspection)
    invoke: function (name, input) {   // run a registered tool locally (testing / "try it" UIs)
      var t = _tools.get(name);
      if (!t) return Promise.reject(new Error('no such tool: ' + name));
      return Promise.resolve(t.execute(input || {}, { requestUserInteraction: function (cb) { return cb(); } }));
    },
    set onStateChange(fn) { _onStateChange = fn; },
    get fetch() { return _fetch; },
    set fetch(fn) { _fetch = fn || null; },   // inject gcuFetch for public-origin → localhost
    get folder() { return _folder; },
    set folder(h) { _folder = h || null; },   // inject a FileSystemDirectoryHandle ⇒ fs transport
  };
  if (typeof window !== 'undefined') {
    window.gcuWebMCP = api;
    // Back-compat alias for pages migrating from the Auditable-bundled shim.
    if (!window.__auditable_mcp) window.__auditable_mcp = api;
  }

  // ── auto-connect from URL fragment: #mcp=port:token ──

  if (typeof location !== 'undefined' && location.hash) {
    var m = location.hash.match(/[#&]mcp=([^&]+)/);
    if (m) setTimeout(function () { _connect(decodeURIComponent(m[1])); }, 500);
  }
})();
