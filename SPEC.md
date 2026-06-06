# @gcu/webmcp — design spec

Status: **draft, v0.1.** The transport (shim + bridge) is extracted, working, and
in use by Auditable; this spec records the *topology* decisions made while
pulling it out into a shared package, and what's left to settle. When code and
SPEC disagree, SPEC states the intent — fix the code or amend the SPEC, don't
silently diverge.

---

## 1. What this is (and isn't)

`@gcu/webmcp` is the **single, official way to connect GCU browser surfaces to
Claude Code** (or any MCP stdio client). A "surface" is a browser page — weir, an
Auditable notebook, a future tool — that loads `shim.js` and registers tools via
`navigator.modelContext`. The bridge relays an MCP client's tool calls to that
page over localhost and streams results back.

**Scope: our surfaces only.** This fronts pages *we* instrument with a shim +
adapter. It is **not** a replacement for third-party MCP servers (Gmail, Drive,
a database MCP) — those install normally. The win is "one bridge instead of one
hand-written MCP server per GCU app," not "one bridge for every MCP."

**Why a bridge at all.** GCU apps are browser-native, local-first, single-file.
They can't *be* stdio MCP servers — no install, no daemon. So the relationship is
inverted: the **page is the tool provider**, the bridge is a dumb relay, and
writing tools means "ship a shim + adapter inside the page," never "stand up a
server."

---

## 2. Topology — one bridge per app, per-app port, machine token

The defining decision. Rejected alternatives (a shared fan-in bridge that every
app connects to; a singleton daemon) in favour of **per-app isolation by
construction**:

- **Port = app identity, per-app, not secret.** Each app gets a stable port
  (§7). It's declared in two places that must agree: the app's repo `.mcp.json`
  (`--port 7801`) and the app's default page config. Ports aren't secrets, so
  they're committable.
- **Token = machine secret, global.** One token in `~/.gcu/webmcp.json`, read by
  every bridge on the machine, created on first run. One secret to provision,
  never committed (it lives in `$HOME`, not a repo).

So: start Claude Code in the **weir** repo → weir's `.mcp.json` launches the
bridge on **weir's** port → weir's page (configured for that port) connects → a
Claude session working on weir sees **only weir's tools** and physically cannot
reach an Auditable notebook (different port, never dialled). Isolation falls out
of the port assignment; no namespacing required to keep apps apart.

### 2.1 Process model

Claude Code spawns the `.mcp.json` `command` as a **stdio child per session**.
So each Claude window in a repo gets its own bridge process. That's fine here:

- **Different apps → different ports → never contend.** The whole "who owns the
  shared port" problem doesn't exist.
- **Same app, two concurrent windows → both want that app's port.** First binds
  it; the second hits `EADDRINUSE` and **falls back to an OS-assigned port**
  (`listen(0)`), running independently. Because the token is machine-global, the
  fallback bridge is still valid — it's just an orphan the page didn't dial. You
  rarely want two bridges for one app anyway, so this is acceptable, not a bug.

### 2.2 Stability caveats (acceptable)

- The preferred port is a convention, not a reservation — between bridge runs an
  unrelated process *could* grab it. Then the bridge falls back and the page's
  stored port is stale → one re-paste fixes it. Pick uncommon ports (§7) and this
  is rare.
- "weir's tools visible in *every* concurrent Claude window simultaneously" is
  **not** provided (that needed the rejected singleton). It's visible in the
  window whose bridge owns the port. For interactive "help me with weir right
  now" work, that's the right scope.

### 2.3 Cross-app workflows = explicit opt-in

Isolation is the default; fan-in is a choice. To drive two surfaces from one
session (e.g. "take this weir card, save it as an Auditable note"), register
*both* bridges in that repo's `.mcp.json`. You opt into crosstalk deliberately
rather than getting it by accident.

---

## 3. Components

| Component | Lives | Role | Generic? |
|---|---|---|---|
| `webmcp-bridge.js` | this repo (node, dev-time) | MCP stdio ↔ WS/HTTP relay, tool merge, routing | Yes |
| `shim.js` | this repo; **vendored into each app's build** | `navigator.modelContext` polyfill + transport client | Yes |
| *adapter* | **each app's own repo** | registers that app's domain tools on `navigator.modelContext` | No — per app |

The adapter is the per-app part and intentionally **not** in this package.
Auditable's is `src/js/mcp-adapter.js` (cells/DAG/widgets). weir's will be
`weir-tools.js` (items/catalog/facets/notes). They share only the registration
seam (`navigator.modelContext.registerTool`) the shim polyfills.

The bridge is a **dev-time node process**, never shipped inside an app's bundle —
same category as weir's CORS fetch bridge. The shim is **pure dependency-free
browser JS** with no imports/exports, so it inlines into any single-file build
(weir vendors it as source, like `vfs.js`).

> **Name clash warning.** Weir already has a different `@gcu/bridge` — the CORS
> *fetch* broker (a Chromium extension). That is **not** this. This (`@gcu/webmcp`)
> brokers agent↔page *tools*; that brokers page↔web *fetches*. Keep them distinct
> in code and docs.

---

## 4. Protocol (bridge ↔ surface)

> **Transports are pluggable.** This section describes the `ws`/`http` localhost
> transports. A third transport — **`fs`**, the same message set over a shared
> (optionally sync'd) folder, removing the port and the PNA/extension dependency —
> and the formal transport interface + a WebRTC seam are specified in
> **[TRANSPORTS.md](TRANSPORTS.md)**.

Localhost only. WebSocket first; HTTP long-poll fallback for `file://` origins.
Both transports carry the same JSON messages. `PROTOCOL_VERSION = 1` is pinned on
both sides — mismatches are rejected, so apps must vendor a shim matching the
bridge.

| Direction | `type` | Purpose |
|---|---|---|
| page → bridge | `hello` | authenticate (protocol + token), carry `name`/`title`/`path` |
| bridge → page | `welcome` | assign client id |
| page → bridge | `tools_changed` | (re)register the tool list |
| bridge → page | `tool_invoke` | run a tool (`callId`, `name`, `input`) |
| page → bridge | `tool_result` | return result or error for a `callId` |
| page → bridge | `notification` | push (forwarded to MCP as `notifications/<method>`) |
| bridge → page | `ping` / page → bridge `pong` | WS heartbeat |

HTTP uses `POST /connect`, `POST /send`, `GET /poll` (long-poll) with CORS.

**MCP side (bridge ↔ Claude):** standard JSON-RPC over stdio — `initialize`,
`tools/list`, `tools/call`, `notifications/tools/list_changed`, `ping`. Two
built-in tools the bridge answers itself: `listClients` and `getConnectionInfo`.
A `client` parameter is injected into surface tools **only when >1 surface is
connected** (single-app bridges keep clean schemas).

### 4.1 Transport selection & public origins

The shim picks a transport: **WS first, HTTP long-poll fallback** (the fallback
fires on `file://`, where browsers block WS). But a page served from a **public
https origin** (gentropic.org/weir, or the installed PWA — same origin) can't
reach `ws://localhost` at all: Chromium's **Local/Private Network Access** gates
public→loopback, and the WS upgrade can't carry the required preflight. Two
answers, both already wired:

- **Inject `gcuFetch`** — `gcuWebMCP.fetch = gcuFetch` (the `@gcu/bridge`
  extension's brokered fetch, the same one weir uses for Lemonade). Injecting a
  fetch **forces the HTTP transport** and routes `/connect`·`/send`·`/poll`
  through the extension, which isn't subject to the *page's* PNA gate. This is the
  primary path for the deployed PWA.
- **PNA preflight grant** — for the no-extension fallback, the bridge sends
  `Access-Control-Allow-Private-Network: true` on preflights, so a **secure**
  public origin *may* reach loopback directly (subject to the browser's one-time
  "allow local network" permission — which weir's Lemonade connection already
  goes through). A plain `http` page origin can't: PNA requires a secure
  initiator.

Caveat to verify in production: a `GET /poll` is held ~25s; if `gcuFetch`/the
extension imposes a shorter timeout, shorten `HTTP_POLL_TIMEOUT` on the bridge.

---

## 5. Tokens, ports, consent

- **Token** — machine-global, `~/.gcu/webmcp.json`, mode `600` (best-effort).
  Defends against a malicious web page you happen to visit POST-ing to your
  localhost bridge. Created on first bridge run.
- **Page-side persistence** — after a one-time connect (paste or `#mcp=`), a
  surface stores its `port:token` in its **own origin storage** (weir: OPFS;
  others: OPFS/localStorage) and reconnects silently. Origin-scoped storage means
  a hostile page can't read another origin's token. Never put the token in a
  committed file.
- **Consent is the adapter's job.** The transport is unauthenticated beyond the
  token. Read tools may be liberal; **mutations must confirm** (a dialog in the
  page) and/or honour an access policy. Auditable does this with `%mcp` cell
  directives + accept/reject dialogs; every app's adapter needs an equivalent.
  "The official GCU way" implies a shared *consent posture*, not just a wire.

### 5.1 Threat model

What the token/transport defends and what it deliberately concedes — general to all
transports; the `fs`-specific cluster-secret detail is in
[TRANSPORTS.md §4.1–4.3](TRANSPORTS.md).

- **Defended — hostile web origin.** A page you visit can reach `localhost` but
  can't read your filesystem, so it can't learn the token → the bridge rejects it.
  This is the token's actual job.
- **Defended — at rest.** `~/.gcu/webmcp.json` is mode `600` (other OS users,
  backups, a stolen/synced home dir). An OS keyring is *optional* hardening on this
  line only, not a fix for anything else (TRANSPORTS §4.2).
- **Conceded — local code running as you.** A same-user process can read the token
  (file *or* keyring) and could already drive your browser / read your files anyway.
  Local same-user malware is **out of scope by design** — the standard posture for
  any localhost-class API (dev servers, LSP, the Chrome debug port). Process-identity
  gates are theater within a UID; we don't engineer against this.
- **authN ≠ authZ.** Authenticating a connection ("it's the peer we think") never
  grants unlimited authority. Authority stays bounded by the adapter's consent policy
  regardless of who connected — which is where defence actually lives.
- **The real threat is the confused deputy.** Surfaces ingest *untrusted content*
  (feed items, scraped pages, agent-authored Courier dispatches) and expose tools to
  an agent; the danger is legitimate content steering the agent into an unintended
  tool call, which transport auth can't see. Invariants: **transport trust ≠ content
  trust**, and **irreversible/structural actions stay human-gated regardless of who
  proposed them** (weir's Courier ratify-gate, generalized). This is *why* "mutations
  must confirm" above is load-bearing, not a nicety.

---

## 5a. Bounding large results

Tool results land in the model's context, and the transport bounds nothing — so
keeping results token-bounded is the **adapter's** job. This is the single thing
that bites every adapter the moment it meets a real dataset (weir's first
`listFacets` dumped 476 KB). Patterns — ranked truncation for aggregates, two-tier
list→detail, **keyset** (not offset) cursor pagination for exhaustible lists,
filters over paging, always a hard cap + `total`/`hasMore`. Full guide with worked
weir examples: **[docs/large-results.md](docs/large-results.md)**.

## 6. Tool naming

With per-app bridges (§2) tool lists never merge across apps, so namespacing is
**nice-to-have, not load-bearing**. Conventions anyway:

- Prefer a short, app-meaningful verb-noun: `queryItems`, `getItem`, `listFacets`.
- If an app expects to be co-registered with others in one session (§2.3), prefix
  with the app: `weir.queryItems`. The bridge merges canonical tools by *name*
  and **first-registered wins the schema** for a shared name — so never reuse a
  name across apps with a *different* schema.
- `getConnectionInfo` / `listClients` are reserved (bridge built-ins).

---

## 7. Assigned ports

GCU reserves **7801–7820** for WebMCP surfaces. Keep this table authoritative.

| App | Port | Notes |
|---|---|---|
| weir | `7801` | feed reader / glass home |
| auditable | `7802` | computational notebooks |
| glean | `7803` | reserved (future) |
| *(spare)* | `7804–7820` | assign on first use |

A page and its bridge must agree on the port. Pass `--port` to the bridge and set
the same value in the page's config.

---

## 8. Wiring an app

1. **Vendor the shim.** Copy `shim.js` into the app's build so it loads on the
   page. Set a stable id early: `gcuWebMCP.name = 'weir'`.
2. **Write an adapter.** Register tools via `navigator.modelContext.registerTool`.
   Gate mutations behind confirmation (§5).
3. **Add `.mcp.json`** to the app's repo:
   ```json
   { "mcpServers": { "webmcp-weir": { "command": "node",
     "args": ["webmcp-bridge.js", "--app", "weir", "--port", "7801"] } } }
   ```
   (Point `command`/`args` at wherever the bridge lives — a sibling clone, an
   `npx @gcu/webmcp`, or a vendored copy.)
4. **Connect once.** `node webmcp-bridge.js --app weir --port 7801 --info` prints
   the `port:token`. Paste it into the page (or `#mcp=`); the page stores it and
   reconnects silently thereafter.

---

## 9. Migration from the Auditable-bundled bridge

Auditable currently bundles its own `shim.js` + `webmcp_bridge.js` and registers
tools in `mcp-adapter.js`. To migrate:

- Replace its bundled shim with this package's `shim.js` (back-compat alias
  `window.__auditable_mcp` is preserved, so the adapter keeps working).
- Point its `.mcp.json` at this `webmcp-bridge.js` with `--app auditable --port
  7802`.
- Terminology changed `notebook`→`client` and `listNotebooks`→`listClients`; the
  Auditable adapter's instructions/text should follow, but the wire protocol is
  unchanged (`hello`/`welcome`/`tools_changed`/`tool_invoke`/`tool_result`).
- The Auditable-specific `--setup` hook (block reading `<!--AUDITABLE-NOTEBOOK-->`
  HTML) is **not** in the generic bridge; keep it in the Auditable repo if wanted.

---

## 10. Open questions

- **Zero-paste first connect.** Can the page discover the token without a manual
  paste, without weakening the malicious-page defence? (A localhost discovery
  endpoint the bridge serves, gated somehow?) For now: paste once, persist.
- **Same-app multi-window.** Is fallback-to-random enough, or do we want a
  lightweight "second bridge proxies to the first" election? Deferred until it
  actually bites.
- **Consent vocabulary.** Should the access/confirm model be standardised across
  adapters (a shared helper in this package) or left per-app? Leaning shared
  helper, eventually.
- **User-scope install.** Register the bridge once at user scope so any project
  gets it, vs per-repo `.mcp.json`. Per-repo is clearer for per-app ports; revisit
  if it's annoying.
