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

(function () {
  var PROTOCOL = 1;

  var _tools = new Map();
  var _transport = null;            // { type: 'ws'|'http', ... }
  var _state = 'disconnected';      // disconnected | connecting | connected | error
  var _clientId = null;
  var _portAndToken = null;
  var _reconnectTimer = null;
  var _name = null;
  var _onStateChange = null;

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
    }
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
    fetch('http://localhost:' + t.port + '/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t.token, id: t.id, message: obj }),
    }).catch(function () { /* poll will detect disconnect */ });
  }

  function _connectHttp(port, token) {
    _setState('connecting');
    return fetch('http://localhost:' + port + '/connect', {
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
    fetch('http://localhost:' + t.port + '/poll?token=' + encodeURIComponent(t.token) + '&id=' + encodeURIComponent(t.id))
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

  // ── shared message handler ──

  function _handleMessage(msg) {
    if (msg.type === 'welcome') { _clientId = msg.id; _setState('connected'); }
    else if (msg.type === 'tool_invoke') { _handleInvoke(msg); }
    else if (msg.type === 'ping') { _send({ type: 'pong' }); }
    else if (msg.type === 'error') { console.error('[gcu-webmcp]', msg.message); _setState('error'); }
  }

  // ── connect (try WS, fall back to HTTP) ──

  function _connect(portAndToken) {
    if (typeof portAndToken !== 'string' || portAndToken.indexOf(':') === -1) throw new Error('Token required: use "port:token" format');
    var forceHttp = /:http$/.test(portAndToken);
    var connStr = (forceHttp || /:ws$/.test(portAndToken)) ? portAndToken.slice(0, portAndToken.lastIndexOf(':')) : portAndToken;
    _portAndToken = portAndToken;
    var idx = connStr.indexOf(':');
    var port = connStr.substring(0, idx);
    var token = connStr.substring(idx + 1);

    if (_transport) {
      if (_transport.type === 'ws' && _transport.ws) { try { _transport.ws.close(); } catch (e) { /* ignore */ } }
      if (_transport.type === 'http') _transport.polling = false;
      _transport = null;
    }
    clearTimeout(_reconnectTimer);

    _setState('connecting');
    var useHttp = forceHttp || (typeof location !== 'undefined' && location.protocol === 'file:');
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
    if (_transport) {
      if (_transport.type === 'ws' && _transport.ws) { try { _transport.ws.close(); } catch (e) { /* ignore */ } }
      if (_transport.type === 'http') _transport.polling = false;
      _transport = null;
    }
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
    set onStateChange(fn) { _onStateChange = fn; },
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
