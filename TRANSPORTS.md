# @gcu/webmcp — Transports

Status: **draft, v0.1.** Extends [SPEC.md §4](SPEC.md). Records the design for a
*pluggable transport layer* and a new **filesystem transport** (`fs`) that carries
the existing wire protocol over a shared folder instead of a localhost socket —
plus the seam for a later WebRTC upgrade. When code and this doc disagree, this
doc states intent; fix the code or amend the doc.

Motivating problem: today a browser surface reaches the bridge over `ws://localhost`
or HTTP long-poll. On a **public origin** (the deployed PWA) that path is gated by
Private/Local Network Access and needs the `@gcu/bridge` *fetch extension* to
punch through (SPEC §4.1). The `fs` transport sidesteps networking entirely: both
peers only ever touch a directory. For a same-machine agent it removes **both** the
extension *and* the localhost port — the bridge becomes a normal stdio MCP server
whose backend is a folder. The same folder, sync'd (Syncthing/Dropbox/a share),
reaches a surface on another machine with no port-forwarding.

---

## 1. The transport interface (the plug)

The shim today implicitly "picks a transport" (WS, else HTTP). Formalize that into
one duplex contract every transport implements; the shim and the bridge each own a
matching pair. A transport is a **dumb pipe for the §4 message set** — it carries
`hello`/`welcome`/`tools_changed`/`tool_invoke`/`tool_result`/`notification`/
`ping`/`pong` verbatim and knows nothing about tools.

```
interface Transport {
  connect(): Promise<void>          // establish/await the channel
  send(msg): void                   // enqueue one wire message (a §4 object)
  onMessage(cb): void               // deliver inbound wire messages
  onStateChange(cb): void           // 'connecting'|'open'|'closed'
  close(): void
}
```

`PROTOCOL_VERSION = 1` (the message set) is unchanged — `fs` carries the same
objects. What `fs` adds is an **envelope** around each message (auth + framing,
§3.3); that envelope has its own `FS_TRANSPORT_VERSION`, independent of the
protocol version. The selection rule extends SPEC §4.1: **explicit `fs` (a folder
is configured) → `fs`; else WS first; else HTTP long-poll.**

---

## 2. Transport catalog

| id | medium | identity | secret use | status |
|---|---|---|---|---|
| `ws` | `ws://localhost:<port>` | port | token in `hello` | shipped |
| `http` | localhost long-poll | port | token in `hello` | shipped (file:// / PNA) |
| `fs` | a shared directory | **folder** | **HMAC per frame** (§4) | **v1 shipped (bridge + shim)** |
| `webrtc` | data channel, folder-signalled | folder→then P2P | DTLS + handshake HMAC | **v1.5 seam (§7)** |

`ws`/`http` are unchanged. The rest of this doc is `fs`, with the `webrtc` seam.

---

## 3. The `fs` transport protocol

### 3.1 Folder layout

One exchange directory per surface (= the app-identity unit, §5). The bridge and
the page are symmetric folder peers; neither is a server.

```
<exchange>/
  bridge.live                              announce: {payload:"{v,session,ts}", sig} — page watches it
  sessions/<session>/<epoch>/
    to-page/                               bridge → page  (welcome, tool_invoke, ping)
      <seq>.json   <seq>.ready             payload + signed sentinel (§3.3)
    to-bridge/                             page → bridge  (hello, tools_changed, tool_result, notification, pong)
      <seq>.json   <seq>.ready
```

`<session>` is minted by the **bridge** per start (a restart = a new session).
`<epoch>` is minted by the **page** per connect — so a browser reload reconnects
on a *fresh* epoch instead of colliding seq counters with the still-live session
(see §3.2). Two **outboxes** because the channel is duplex and not request/response
— e.g. `tools_changed` is an unsolicited page→bridge push, `tool_invoke` is
bridge→page. Each direction has its own monotonic `seq`, scoped to `(session,
epoch)`. Message correlation (a tool call to its result) is the existing JSON-RPC
`callId` inside the payload; `seq` is only for delivery ordering and replay defence.

### 3.2 Session & epoch establishment (no port to dial)

The **bridge announces; the page dials** — the folder analog of "bridge listens,
page connects":

1. Bridge starts → mints a fresh `session` nonce → writes `bridge.live`. A fresh
   nonce each start means a restarted bridge is a new session.
2. Page (holds the folder handle + secret) polls `bridge.live`, verifies the sig
   and freshness, learns `session`, **mints its own `epoch` nonce**, and writes
   `hello` as `sessions/<session>/<epoch>/to-bridge/0.*`.
3. Bridge scans the session's epoch dirs, **adopts the one with the freshest
   `hello`**, replies `welcome`, and **sweeps the other epoch dirs** (reaping prior
   reloads — cleanup falls out of adoption). Adopting an epoch resets the bridge's
   per-connection `seq`/cursor for it.
4. Steady state: each side appends to its outbox, polls the other's.

**Reconnect is clean, not "free".** A naive flat session would wedge on a page
reload — the reloaded page restarts its in-memory `seq` at 0, which the live bridge
(cursor already past 0) would reject as a replay, and the page would see a gap in
the other direction. The per-connection epoch is precisely what fixes this: a
reload is a new epoch ⇒ fresh cursors both ways ⇒ a fresh handshake; the old epoch
is swept. A bridge restart (new session) likewise makes the page mint a new epoch
under it.

### 3.3 Framing & atomicity — the signed sentinel

A folder is an **at-rest medium synced across machines**, so two hazards that a
socket doesn't have: a reader may observe a *partially-written/partially-synced*
file, and sync engines do **not** guarantee atomic `temp→rename` propagation. The
fix doubles as the auth carrier (§4), so framing and security are one mechanism:

- Producer writes the payload `‹seq›.json`, then a tiny sentinel `‹seq›.ready`:
  ```
  { v, session, epoch, dir, seq, ts, len, sig }
  ```
  `len` = payload byte length; `sig` = `HMAC-SHA256(key, canon(session, epoch, dir,
  seq, ts, len, payload))` — the HMAC covers the **raw stored payload string**, not
  a re-serialization, so it's stable across engines (node writes, browser reads).
- A consumer **keys off `‹seq›.ready`**, then requires `‹seq›.json` to exist with
  `bytes == len` *and* a matching `sig` before it will parse. So:
  - **partial sync** → length/sig mismatch → wait (it completes on the next tick);
  - **reordered delivery** (sentinel arrives before payload — sync engines do this)
    → handled, because the consumer waits for the payload to satisfy the sentinel;
  - **tamper / injection / replay** → sig or `seq`/`ts` check fails (§4).
  - Check order is `seq` → fields → **freshness (`ts`)** → `len` → `sig`; a frame
    failing freshness or sig is removed so it can't wedge the cursor.
- After processing, the consumer deletes both files. `bridge.live` signs/verifies
  the same way over its raw stored payload string. Stale epoch dirs are swept on
  adoption (§3.2); a clean `close` removes the epoch dir.

This means we need **no** reliance on rename atomicity and **no** separate
integrity layer — a valid signed sentinel proves *complete AND authentic* in one
check.

### 3.4 Liveness & polling — passive, because writes are expensive

The asymmetry that shapes this: over a sync engine, **reads are cheap** (polling a
local `readdir` transfers nothing on the wire) but **writes are expensive** (each
is a detect→hash→transfer→remote-write round-trip) and, worse, write churn *delays
the real frames*. So a per-tick heartbeat is an anti-pattern here. Liveness is
**passive**:

- **A frame's signed `ts` is its own liveness proof.** During active RPC, liveness
  is free; no extra writes.
- **When idle, nobody writes anything.** "Is the peer alive?" only needs answering
  when there's work — and then the frame (or a tool-call timeout) answers it.
- **The one periodic write in the whole system** is the bridge refreshing
  `bridge.live` slowly (`ANNOUNCE_INTERVAL`), so an idle page can tell a live bridge
  from a stale one. The **page is write-silent when idle** — a browser tab must not
  thrash a synced folder doing nothing.
- **Page detects a dead bridge** when `bridge.live` is older than `LIVENESS`
  (→ state `connecting`, retry on the cheap read). **Bridge reaps a gone page**
  lazily (a failed/ timed-out call, or epoch sweep), not via heartbeat.
- **Polling (reads) stays frequent** for latency; over a sync hop the *engine's*
  latency dominates anyway (FS is the cross-machine *batch* transport; WebRTC is the
  *interactive* one, §7). The host must not overlap ticks (await one before the next).

### 3.5 Defaults (tunable, pin in code)

`FS_VERSION=1` · `SKEW≈5min` (frame freshness/replay window) ·
`ANNOUNCE_INTERVAL≈30s` (the only periodic write) · `LIVENESS≈90s` (page→
dead-bridge). Poll cadence is the host's to set (sub-second same-machine).

---

## 4. Security model

**Trust boundary = the folder.** Whoever can write the exchange dir can drive the
surface — the same posture as weir's Courier. A peer, once it completes the signed
handshake, is **fully trusted for the session** (you initiated it); FS-RPC is not
gated per-call the way Courier *dispatches* are. That is only safe because **every
frame is authenticated**, which a folder requires precisely because it has no
socket to anchor session identity to:

- **Key.** Reuse the existing machine token (`~/.gcu/webmcp.json`, SPEC §5) — no
  new secret to provision. Derive per-surface keys: `key = HKDF(token, "webmcp-fs|"
  + folderId)`, so the same token yields distinct keys per exchange dir, and a
  reserved second output slot can become an AES key if a fully-untrusted folder
  ever needs payload encryption (deferred — WebRTC/DTLS covers the wire in v1.5,
  and an own-cluster sync folder faces replay/injection, not eavesdropping).
- **Per-frame auth.** HMAC over the canonical payload (in the sentinel, §3.3).
- **Replay/freshness.** Reject a `seq` already delivered for `(session, epoch,
  dir)`; reject `ts` outside ±`SKEW`. A restored/duplicated old frame fails both.
  (Cross-machine clock skew past `SKEW` fails the channel mute-ly, so a freshness
  reject must **log loudly** — instrument the silent-degrade path.)
- **DoS-by-overwrite is accepted.** Anyone with folder-write can clobber or inject
  a frame filename; that is inherent to "folder = trust boundary" and out of scope
  — the same concession as the cluster secret (§4.1). Integrity/auth still hold (a
  clobbered frame fails its sig); only availability is at the mercy of a hostile
  cluster member, which you already trust enough to share the secret with.
- **Capability scoping (from day one).** The bridge enforces an allow-list passed
  at launch — `--allow 'query*,getItem,listFacets'` (globs), default `*`. This is
  orthogonal to, and composes with, the adapter's in-page consent (SPEC §5):
  transport-level scoping for *less-trusted peers* (e.g. a SaaS surface), adapter
  consent for *mutations*. Two layers, different jobs.

Signing the handshake **and** every frame is the whole reason "fully trust once
connected" is sound here — over a socket you'd sign only the handshake; over a
folder, each file must self-authenticate.

### 4.1 Threat model & conceded boundaries

State plainly what the secret defends and what it deliberately does not — the
conceded line is not a gap, it's the standard posture for any localhost-class tool.

- **Defended — hostile web origin.** A page you happen to visit can reach
  `localhost` (and, with `fs`, can't reach the folder at all); without the
  token/HMAC it can't speak the protocol. This is the original job of the `ws`/`http`
  token (SPEC §5) and of the `fs` HMAC. The page can't read your filesystem, so it
  can't learn the secret.
- **Defended — at rest.** The secret on disk is mode `600` (optionally an OS
  keyring, §4.2): protects against other OS users, stray backups, a synced/stolen
  home directory.
- **Conceded — local code running as you.** A process under your account can read
  the secret (file *or* keyring — a same-session process generally unlocks either)
  and can in any case already drive your browser, read your files, and keylog. So
  **local same-user malware is out of scope by design** — "if the box is
  compromised it's game over anyway." Per-process authentication (e.g. peer creds
  over a Unix socket) wouldn't help: browsers can't speak that, and a same-user
  attacker impersonates anyway.
- **`fs`-specific — the secret becomes a *cluster* secret.** Unlike `ws`/`http`
  (token never leaves one machine), an `fs` exchange needs the secret on **every**
  machine in the sync cluster. Two hard rules: (1) the secret is provisioned
  **out-of-band per machine and NEVER written into the exchange folder** — writing
  it there syncs your key to every peer; (2) the secret's blast radius = the whole
  cluster, so scope clusters tightly. Capability scoping (`--allow`) + adapter
  mutation-consent (SPEC §5) bound what a cluster peer can do and matter **more**
  here than at-rest encryption.

### 4.2 OS keyring — optional at-rest hardening

Opportunistic, with fallback: use the platform store (Windows DPAPI / macOS
Keychain / Linux libsecret) when present, else `~/.gcu/webmcp.json` mode `600`. It
improves **only** the at-rest line above (backups, disk theft, multi-user), and on
macOS adds a per-app unlock prompt — the one place it marginally raises the
local-process bar. It does **not** touch the primary (web-origin) or conceded
(local-process) boundaries. Cost: platform branches / a keyring dependency against
the bridge's zero-dep ethos (shelling out to `security`/`secret-tool`/DPAPI is the
zero-dep route). **Verdict: defensible later, not a v1 blocker** — file + `600`
already covers the threat the token is actually for. This whole threat model is
general (not `fs`-only); it ideally backports into SPEC §5.

### 4.3 Authentication ≠ authorization — the confused-deputy boundary

The conceded local-process gap (§4.1) is about **authentication of a process**, and
it's a universal property of local APIs — not worth engineering against (a UID has
no sub-isolation; process-identity gates are theater a same-user attacker defeats,
and browsers can't speak them anyway). The effort belongs one layer up, in
**authorization**, which the transport's authentication does *not* grant:

- **"Fully trusted once connected" (§4) means authenticated, not omnipotent.** It
  asserts *the peer is who we think* — it never says *it may do anything*. A
  fully-authenticated peer is still bounded by the `--allow` capability scope and by
  adapter mutation-consent (SPEC §5). Keep authN and authZ separate and the apparent
  tension with §4.1 dissolves: the conceded gap is in authN-of-process; defence lives
  in authZ, and authZ survives regardless of who connected.
- **The real frontier threat is the confused deputy, not rogue connection.** The
  surfaces here ingest **untrusted content** — feed items, scraped pages, and most
  pointedly **Courier dispatches authored by an external agent** — and expose tools
  to an agent. The dangerous path is *legitimate, authenticated* content steering the
  agent (the deputy) into a tool call the human never intended; transport auth can't
  see it, because the call is correctly signed. **Transport trust ≠ content trust.**
- **Invariant: irreversible/structural actions stay human-gated, regardless of who
  or what proposed them.** This is weir's Courier ratify-gate (decides-vs-proposes)
  generalized: a feed-add arriving as a *proposal* the human ratifies is the pattern,
  not a special case. Apply it to any tool whose effect is hard to undo.
- **Defaults: mutations default-gated even for a trusted peer; reads liberal.** The
  two-tier posture SPEC §5 already mandates. Cataloging stays a constrained
  *classification* call that takes no actions (GLASS §1.1), so untrusted content it
  reads cannot, by construction, drive an action.

So: we do **not** chase the local-process authN gap (universal seam); we **do** keep
authority minimal and irreversible actions human-gated (the part that is ours, and
where untrusted content + an agent + tools actually meet).

---

## 5. Identity & isolation — folder replaces port

SPEC §2 makes **port = app identity** and gets app isolation for free (weir's
session physically can't dial Auditable's port). `fs` keeps the property with a
different key: **the exchange folder is the identity.** One folder per surface;
distinct folders can't see each other's traffic. So the §2 topology generalizes:

| mode | identity | isolation | secret |
|---|---|---|---|
| `ws`/`http` | per-app port | distinct ports | machine token |
| `fs` | per-app folder | distinct folders | machine token (HMAC) |

Cross-surface fan-in stays explicit opt-in (SPEC §2.3): register two exchanges in
one session to drive both.

---

## 6. The bridge in `fs` mode

The agent side is the **existing `webmcp-bridge.js`**, gaining an `fs` backend —
not a new binary, and not per-app. Its MCP-facing side is unchanged stdio
JSON-RPC; only its surface-facing side swaps the socket for the folder:

```json
{ "mcpServers": { "webmcp-weir": { "command": "node",
  "args": ["webmcp-bridge.js", "--app", "weir",
           "--transport", "fs", "--folder", "~/laney-sync/weir-rpc"] } } }
```

Because **the page advertises its own tools** (WebMCP), the bridge is fully
surface-agnostic — it relays frames and merges the tool list the page sends. So:

- **One bridge install, parameterized per surface by `--folder`.** This resolves
  SPEC §10's "user-scope install" question: the *binary* installs once (global /
  `npx @gcu/webmcp`); *identity* stays explicit in the `--folder` arg, so
  registration can be per-repo `.mcp.json` (keeps app identity with the app, as
  today) **or** user-scope — both work because identity no longer hinges on where
  the process was launched. Recommended: global binary, per-app `.mcp.json` entry.
- Same-app concurrent windows: harmless here — folder peers don't contend for a
  port (the `EADDRINUSE` dance, SPEC §2.1, doesn't apply). Two bridges on one
  folder is a real edge (double-consume); v1 assumes one bridge per exchange and a
  second logs a warning.

### 6.1 The shim (page) side — `fs-channel.js` + an FSA adapter

`shim.js` selects the `fs` transport when a directory handle is injected —
`gcuWebMCP.folder = <FileSystemDirectoryHandle>` (the way `gcuWebMCP.fetch =
gcuFetch` forces HTTP today) — and `gcuWebMCP.connect("<machine-token>")` with a
**bare token** (no port). Internals:

- **Reuses `fs-channel.js`** (role `page`). The shim is a plain IIFE that can't
  `import`, so `fs-channel.js` attaches `globalThis.GcuFsChannel` when not in
  CommonJS; the app build must **load it on the page alongside the shim** (concat /
  vendor as source). If absent, the shim errors clearly on connect.
- **FSA dir-adapter** maps the channel's `/`-path interface onto the handle
  (walking `getDirectoryHandle`). FSA has **no atomic rename**, but the signed
  sentinel makes that unnecessary — a half-written `createWritable` payload fails
  its len/HMAC and the reader waits. Writes `close()` in a `finally` (release the
  OPFS/FSA write lock even on error), and a failed frame write is **retried, not
  dropped** (the seq commits only on success — a transient lock/AV/sync error must
  not burn a seq and wedge the channel).
- **Key derivation** matches the bridge exactly via `crypto.subtle`: `HKDF(token,
  salt='', info='webmcp-fs|'+gcuWebMCP.name)` → HMAC-SHA256 → hex. Needs a secure
  context (https / localhost / file://); the page derives the same key the bridge
  did from the same token + app id.

---

## 7. WebRTC upgrade — v1.5 seam (spec now, build next)

Folder transport is the cross-machine *batch* path; its steady-state latency is
the sync engine's. For cross-machine *interactive* use, upgrade to a WebRTC data
channel **signalled through the same folder** — the one part of WebRTC that is
low-bandwidth and latency-tolerant, so the folder's lag bites only once at setup:

- `sessions/<session>/signal/{offer,answer,ice-*}.json` (signed like any frame).
- **Opportunistic:** after the `fs` session is live, either peer may offer; on a
  successful channel, frames move to the data channel and the folder goes quiet
  (heartbeats only). On channel failure, fall back to `fs` seamlessly.
- DTLS encrypts the channel (so §4's deferred payload-encryption is moot once
  upgraded). ICE host candidates cover same-machine/LAN with no server; the open
  internet needs a STUN server (free/public, a minor ethos asterisk) and worst-case
  symmetric-NAT needs TURN (a real relay — out of scope for v1.5).
- **`allowRemote` toggle, default `false` (local/LAN only).** Reachability is an
  ICE-candidate policy, so the toggle is principled, not a hack:
  - *off (default):* `iceServers: []` (no STUN/TURN → only host candidates gather) **and**
    a candidate filter dropping anything that isn't loopback / private
    (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fe80::/10`, `fc00::/7`) or an
    mDNS `.local` name, applied to both advertised and accepted candidates. Result:
    connects same-machine + LAN; an internet peer has no path. Enforce + **audit** via
    `getStats()` on the selected pair — tear down if it resolved to a public IP.
  - *on (opt-in):* add STUN (+ TURN if needed) and stop filtering public candidates.
  - This is a network-*exposure* control layered on the existing auth (folder
    membership + per-frame HMAC is still the trust boundary — `allowRemote` only
    governs whether a direct internet-facing P2P socket may form). And it degrades
    gracefully: a refused remote channel **stays on the `fs` transport** (which already
    works remotely, sync-paced), so the toggle controls *fast P2P*, not connectivity.

### 7.1 Reach is a ladder; same-machine is enforced by the medium, not WebRTC

The transport's reach equals **the folder's reach**, so "strictly this machine" is an
operational choice, not a code filter — and a stronger guarantee for it:

| reach | how | WebRTC |
|---|---|---|
| **same machine only** | **un-synced local folder** (bytes never leave the box) | off — and unneeded (local `fs` is already direct disk I/O) |
| LAN / remote, slow | a synced folder | off → stays on `fs` |
| LAN / remote, fast | a synced folder | on (`allowRemote`; +STUN for internet) |

Don't try to make WebRTC loopback-only: browsers obfuscate local host candidates as
`.local` mDNS names (loopback indistinguishable from LAN, and loopback candidates often
aren't gathered at all), so a candidate filter can't reliably mean "this machine." It
doesn't matter — same-machine gets no benefit from WebRTC anyway. If a *code-enforced*
same-machine guarantee is wanted, the **`ws`/`http` socket transport** is the strongest
(it binds `127.0.0.1`, OS-unroutable off-box); `fs` is what you reach for when the socket
isn't usable (public origin, or crossing machines).
- Relay-side WebRTC stack (`node-datachannel`/`werift`) is a bridge-only (dev-time)
  dependency, never in a shipped browser bundle — acceptable, but pin it.

v1 ships **without** any of this; the folder layout reserves `signal/` so adding it
is additive.

---

## 8. weir as the first consumer

- Mount the exchange via weir's existing aux-handle path (`fsmount.js`), a **handle
  of its own**, distinct from the Courier's (blast-radius isolation; they may live
  as siblings under one synced parent but never share a channel).
- Status in the flight-deck statusbar, like `courier-status`. Optional auto-connect
  on boot (mirrors the Courier's silent reconnect).
- A weir-side UI *brand* for "an agent is driving me live over a folder" (a hydro
  word — **Flume**/**Penstock** are the front-runners) is a deferrable weir-skin
  decision, made when weir's UI for it is built — **not** a webmcp-layer concern.
  In webmcp the thing is just "the `fs` transport." Do **not** reuse "Courier" — it
  fits weir's curated human-ratified exchange better than a dumb fast pipe, and
  renaming a shipped subsystem to free the name is churn.

---

## 9. Scope & sequencing

- **v1 — `fs` transport. ✅ shipped.** The interface (§1), the folder protocol
  (§3), the security model (§4), the bridge `fs` backend (§6), the shim/FSA page
  side (§6.1). Browser(FSA) ↔ agent(stdio bridge), same-machine **and** sync'd,
  single peer. **Proven by:** `tools/smoke-fs.mjs` (protocol core, incl. reconnect +
  tamper/partial/replay attacks), `tools/smoke-fs-bridge.mjs` (the REAL bridge over
  a folder driven via MCP stdio — no port, no extension), and `tools/e2e-fs.mjs`
  (the real shim in Chromium over OPFS — the browser-side FSA adapter + subtle
  HKDF/HMAC). Node smokes are zero-dep + in `npm run smoke`; the browser e2e is
  local-only (sibling Playwright), like `e2e-browser.mjs`.
- **v1.5 — WebRTC upgrade** (§7), folder-signalled, opportunistic, STUN-only.
- **v2 — hardening:** payload encryption option, multi-peer per folder, TURN, a
  shared consent helper (SPEC §10).

---

## 10. Open questions

- **Secret-provisioning UX.** Reusing the machine token means *no* new paste in the
  common case — but the page still needs the token to compute HMACs. Today it's
  pasted once (`port:token`) and stored origin-scoped. For `fs` the connect datum
  is `folder-handle + token`; the token paste can stay identical, or weir can show
  the token in-UI for the connector. Settle the exact first-connect flow.
- **Polling vs a watch hint.** Browsers have no FSA change events; we poll. Is an
  optional out-of-band nudge (a same-origin BroadcastChannel when weir itself
  wrote) worth it, or is adaptive polling enough? (Lean: enough.)
- **Sync-conflict files.** Engines may emit `file.sync-conflict-…` copies. The
  sentinel/seq scheme ignores them (wrong name), but the sweep should reap them.
- **v1.5 timing.** Flagged "soon" by the maintainer — sequence right after v1
  rather than vague-future.
