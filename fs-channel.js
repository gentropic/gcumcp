// fs-channel.js — @gcu/webmcp `fs` transport core. See TRANSPORTS.md §3.
//
// Dependency-free protocol shared by the bridge (node fs) and the shim (browser
// FSA). PURE over injected adapters, so it runs anywhere and tests without a real
// filesystem, crypto, or browser:
//
//   dir       async { read(name)->str|null, write(name,str), list(dir)->[name],
//                     remove(name), mkdirp(dir) }     — name/dir are '/'-relative paths
//   hmac      async (str) -> hex                      — key is bound by the caller
//                                                       (HKDF of the machine token);
//                                                       key material NEVER enters here
//   now       () -> epoch ms
//   randomId  () -> hex string                        — session nonce source (bridge)
//   onMessage (wireMsg) -> void                       — deliver a verified inbound msg
//   onState   ('connecting'|'open'|'closed') -> void
//
// Roles: the BRIDGE announces (writes `bridge.live`); the PAGE dials. Duplex — each
// side appends signed frames to its own outbox and consumes the peer's. A frame is
// `‹seq›.json` (payload) + `‹seq›.ready` (signed sentinel). The sentinel proves the
// payload COMPLETE and AUTHENTIC in one check (§3.3): partial sync, reordered
// delivery, tamper, and replay all fail closed. Delivery is in-order, exactly-once.
//
// The host drives time: call tick() on an interval (the bridge/shim) or in a loop
// (the smoke). The channel carries the existing wire message set verbatim
// (hello/welcome/tools_changed/tool_invoke/tool_result/notification/ping/pong) and
// knows nothing about tools.

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GcuFsChannel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FS_VERSION = 1;
  var SKEW_MS = 5 * 60 * 1000;   // accept frames within ±5 min (freshness / replay window)

  function outboxOf(role) { return role === 'bridge' ? 'to-page' : 'to-bridge'; }
  function inboxOf(role) { return role === 'bridge' ? 'to-bridge' : 'to-page'; }

  // The signed string binds the envelope to the payload — swapping a sentinel onto a
  // different payload, or editing any envelope field, breaks the HMAC.
  function canon(session, dir, seq, ts, len, payload) {
    return FS_VERSION + '|' + session + '|' + dir + '|' + seq + '|' + ts + '|' + len + '|' + payload;
  }

  function FsChannel(opts) {
    this.role = opts.role;                 // 'bridge' | 'page'
    this._dir = opts.dir;
    this._hmac = opts.hmac;
    this._now = opts.now || function () { return Date.now(); };
    this._rand = opts.randomId || function () { return 'x'; };
    this._onMessage = opts.onMessage || function () {};
    this._onState = opts.onState || function () {};
    this._log = opts.log || function () {};
    this.session = null;
    this.state = 'connecting';
    this._outSeq = 0;
    this._lastIn = -1;                     // highest inbound seq delivered (replay/order guard)
    this._outQueue = [];
  }

  FsChannel.prototype._setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    try { this._onState(s); } catch (e) { /* host callback */ }
  };

  FsChannel.prototype._sessDir = function (sub) { return 'sessions/' + this.session + '/' + sub; };

  // ── start ──

  FsChannel.prototype.start = async function () {
    if (this.role === 'bridge') {
      this.session = this._rand();
      await this._dir.mkdirp(this._sessDir('to-page'));
      await this._dir.mkdirp(this._sessDir('to-bridge'));
      await this._announce();
    }
    // page discovers lazily on the first tick()
  };

  FsChannel.prototype._announce = async function () {
    var ts = this._now();
    var body = { v: FS_VERSION, session: this.session, ts: ts };
    var payload = JSON.stringify(body);
    var sig = await this._hmac(canon(this.session, 'announce', 0, ts, payload.length, payload));
    await this._dir.write('bridge.live', JSON.stringify({ body: body, sig: sig }));
  };

  // Page: read + verify bridge.live, adopt its session (re-handshaking if it changed).
  FsChannel.prototype._discover = async function () {
    var raw = await this._dir.read('bridge.live');
    if (!raw) return false;
    var ann; try { ann = JSON.parse(raw); } catch (e) { return false; }
    if (!ann || !ann.body || ann.body.v !== FS_VERSION) return false;
    var b = ann.body, payload = JSON.stringify(b);
    var expect = await this._hmac(canon(b.session, 'announce', 0, b.ts, payload.length, payload));
    if (expect !== ann.sig) { this._log('bad announce sig'); return false; }
    if (Math.abs(this._now() - b.ts) > SKEW_MS) { this._log('stale announce'); return false; }
    if (this.session !== b.session) {           // first / new session → (re)handshake
      this.session = b.session;
      this._outSeq = 0; this._lastIn = -1;
      await this._dir.mkdirp(this._sessDir('to-bridge'));
      await this._dir.mkdirp(this._sessDir('to-page'));
    }
    return true;
  };

  // ── send (queued; flushed by tick once a session exists) ──

  FsChannel.prototype.send = function (msg) { this._outQueue.push(msg); };

  FsChannel.prototype._writeFrame = async function (msg) {
    var dir = outboxOf(this.role);
    var seq = this._outSeq++;
    var ts = this._now();
    var payload = JSON.stringify(msg);
    var sig = await this._hmac(canon(this.session, dir, seq, ts, payload.length, payload));
    var base = this._sessDir(dir) + '/' + seq;
    await this._dir.write(base + '.json', payload);      // payload first…
    await this._dir.write(base + '.ready', JSON.stringify({   // …then the sentinel
      v: FS_VERSION, session: this.session, dir: dir, seq: seq, ts: ts, len: payload.length, sig: sig,
    }));
  };

  FsChannel.prototype._remove = async function (base) {
    await this._dir.remove(base + '.json');
    await this._dir.remove(base + '.ready');
  };

  // Consume the peer's outbox: verify + deliver in seq order, exactly once.
  FsChannel.prototype._drainInbox = async function () {
    var dir = inboxOf(this.role);
    var dpath = this._sessDir(dir);
    var names = await this._dir.list(dpath);
    var readys = [];
    for (var i = 0; i < names.length; i++) {
      var m = /^(\d+)\.ready$/.exec(names[i]);
      if (m) readys.push(parseInt(m[1], 10));
    }
    readys.sort(function (a, b) { return a - b; });

    for (var j = 0; j < readys.length; j++) {
      var seq = readys[j];
      var base = dpath + '/' + seq;
      if (seq <= this._lastIn) { await this._remove(base); continue; }   // already delivered → sweep
      if (seq !== this._lastIn + 1) break;                               // gap → wait for the missing seq

      var rawR = await this._dir.read(base + '.ready');
      if (rawR == null) continue;
      var sent; try { sent = JSON.parse(rawR); } catch (e) { continue; }
      if (!sent || sent.v !== FS_VERSION || sent.session !== this.session || sent.seq !== seq || sent.dir !== dir) break;
      if (Math.abs(this._now() - sent.ts) > SKEW_MS) { this._log('stale frame ' + seq); await this._remove(base); break; }

      var payload = await this._dir.read(base + '.json');
      if (payload == null || payload.length !== sent.len) break;         // not fully synced yet → wait
      var expect = await this._hmac(canon(this.session, dir, seq, sent.ts, sent.len, payload));
      if (expect !== sent.sig) { this._log('bad frame sig ' + seq); await this._remove(base); break; }

      var msg; try { msg = JSON.parse(payload); } catch (e) { await this._remove(base); break; }
      this._lastIn = seq;
      if (this.role === 'bridge') this._setState('open');               // a page is talking
      await this._remove(base);
      try { this._onMessage(msg); } catch (e) { this._log('onMessage threw'); }
    }
  };

  FsChannel.prototype._beat = async function () {
    var ts = this._now();
    var sig = await this._hmac(canon(this.session, outboxOf(this.role) + '/.alive', 0, ts, 0, ''));
    await this._dir.write(this._sessDir(outboxOf(this.role)) + '/.alive', JSON.stringify({ ts: ts, sig: sig }));
    if (this.role === 'bridge') await this._announce();                 // keep bridge.live fresh
  };

  // ── tick: one poll cycle (host schedules it) ──

  FsChannel.prototype.tick = async function () {
    if (this.state === 'closed') return;
    if (this.role === 'page') {
      var ok = await this._discover();
      if (!ok) { this._setState('connecting'); return; }
      this._setState('open');                                           // the bridge is announcing
    }
    if (!this.session) return;
    while (this._outQueue.length) await this._writeFrame(this._outQueue.shift());
    await this._beat();
    await this._drainInbox();
  };

  FsChannel.prototype.stop = function () { this._setState('closed'); this._outQueue.length = 0; };

  return { FsChannel: FsChannel, FS_VERSION: FS_VERSION };
}));
