# @gcu/numen

The official, zero-dependency way to connect **GCU browser surfaces** (weir,
Auditable notebooks, anything that loads the shim) to **Claude Code**, **Claude
Desktop**, or any MCP stdio client.

```
┌──────────────────┐
│  weir  (browser) │──WS/HTTP──┐
└──────────────────┘           │   ┌──────────────────┐  stdio   ┌─────────────┐
                               ├──►│  numen-bridge   │◄────────►│ Claude Code │
┌──────────────────┐           │   │  (node, :7801)   │   MCP    │             │
│  another surface │──WS/HTTP──┘   └──────────────────┘          └─────────────┘
└──────────────────┘
```

**Two transports:** the localhost **socket** (ws/http, shown above), and **`fs`** —
the *same* protocol carried over a shared folder, with **no port and no browser
extension** (the right pick for a public-origin PWA, and it reaches another machine
if you sync the folder). One bridge per surface; a Claude session sees only that
surface's tools — no crosstalk. Full design in [SPEC.md](SPEC.md); the fs transport +
its security model in [TRANSPORTS.md](TRANSPORTS.md). This is the quick start.

> Not a replacement for third-party MCPs (Gmail, Drive, …) — those install
> normally. This fronts *our* surfaces. The win is one bridge instead of one
> hand-written MCP server per GCU app.

> Don't confuse this with `@gcu/bridge`, the CORS **fetch** broker. This brokers
> agent↔page **tools**; that brokers page↔web **fetches**.

## Files

| File | Role |
|---|---|
| `numen-bridge.js` | Node bridge: MCP stdio ⇄ WebSocket/HTTP/**fs** relay, tool merge, routing. Zero deps. Runs unmodified on node, `bun`, or `deno run`. |
| `shim.js` | Generic WebMCP polyfill — `navigator.modelContext` + transport client. Vendor into each app's build. |
| `fs-channel.js` | The `fs`-transport protocol core (signed-sentinel framing). Vendor **alongside** `shim.js` for fs support. |
| `SPEC.md` · `TRANSPORTS.md` | Design + topology + assigned ports; the pluggable transports + fs protocol + security model. |

The **adapter** (the tools themselves) lives in each app's own repo — weir's
`weir-tools.js`, Auditable's `mcp-adapter.js` — not here.

Writing an adapter? See **[docs/large-results.md](docs/large-results.md)** for how
to keep tool results token-bounded (ranked truncation, two-tier list→detail,
keyset cursor pagination) — the one thing that bites every adapter the moment it
hits a real dataset.

## Connect a surface to Claude (no clone needed)

You have an instrumented GCU surface (e.g. the weir PWA) and want Claude to drive
it. Use the **`fs` transport** — no port, no extension — run straight from GitHub:

**Claude Code:**
```
claude mcp add weir --scope user -- npx -y github:gentropic/numen --app weir --transport fs
```
**Claude Desktop — one-click bundle (recommended):** `npm run mcpb` →
`dist/numen.mcpb`; double-click it (or Settings → Extensions → Install). It
installs **one multi-surface bridge** (`--watch ~/numen`) that serves **every** GCU
surface — no per-app config, and **Claude Desktop's bundled Node runs it (nothing else
to install)**. At install it asks for a folder (default `~/numen`) + a token you choose;
paste that same token into each surface's WebMCP settings when you connect its folder.

**Claude Desktop — manual config** (alternative): add to `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):
```json
{ "mcpServers": { "weir": { "command": "npx",
  "args": ["-y", "github:gentropic/numen", "--app", "weir", "--transport", "fs"] } } }
```
Then get the token + the exact connect steps:
```
npx -y github:gentropic/numen --app weir --transport fs --setup
```
It prints both client snippets, the machine token, the auto-created folder
(`~/numen/weir`), and the in-page step: open the surface's WebMCP settings → **pick
that folder** → **paste the token** → **connect over folder**. The page remembers it.

- **No npm key / publish needed** — `npx github:` runs the bin straight from the repo.
- **Prefer Deno?** It's published on **[JSR](https://jsr.io/@gcu/numen)** — point
  `command` at `deno` and `args` at `run -A jsr:@gcu/numen …` (versioned, no git
  fetch). `bun` runs the bridge unmodified too.
- Once on npm, the node line also becomes `npx -y @gcu/numen …`.

## Quick start (wiring an app, e.g. weir)

1. **Vendor `shim.js`** — and **`fs-channel.js`** if you want the fs transport —
   into the app so they load on the page (`fs-channel.js` before the shim), and set a
   stable id:
   ```js
   gcuWebMCP.name = 'weir';
   ```
2. **Register tools** in the app via the polyfilled API:
   ```js
   navigator.modelContext.registerTool({
     name: 'queryItems',
     description: 'Search the feed corpus.',
     inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
     annotations: { readOnlyHint: true, title: 'Query items' },
     execute: async ({ q }) => store.search(q),   // mutations should confirm first
   });
   ```
   The page selects the fs transport when a folder handle is injected
   (`gcuWebMCP.folder = <FileSystemDirectoryHandle>`, then `gcuWebMCP.connect("<token>")`);
   otherwise it uses the socket. See [TRANSPORTS.md §6.1](TRANSPORTS.md).
3. **Wire the bridge.** For end users: the [Connect](#connect-a-surface-to-claude-no-clone-needed)
   section above (`npx github:` + `--transport fs`). For local dev against a clone:
   ```json
   { "mcpServers": { "numen-weir": { "command": "node",
     "args": ["numen-bridge.js", "--app", "weir", "--transport", "fs"] } } }
   ```
   Run `node numen-bridge.js --app weir --transport fs --setup` for the token + the
   exact in-page connect steps. (Drop `--transport fs` for the localhost socket + the
   `@gcu/bridge` extension instead.)

In Claude Code: call `listClients` to see what's connected, then call the tools
the surface advertises.

## Ports & token

- **Ports** are app identity, not secret — committable. GCU reserves
  **7801–7820**; see the table in [SPEC.md §7](SPEC.md). weir = `7801`,
  auditable = `7802`.
- **Token** is machine-global, created on first run at `~/.gcu/numen.json`
  (mode `600`). It gates who may attach to your localhost bridge. Never commit it.
  Pages persist their own `port:token` in origin-scoped storage.

## Transports

**socket** — WebSocket first, automatic HTTP long-poll fallback on `file://` (where
browsers block WS); force with `port:token:http` / `port:token:ws`. A **public https
origin** (gentropic.org/weir, installed PWA) can't reach `ws://localhost` — Chromium's
Private/Local Network Access gates public→loopback. Inject the `@gcu/bridge` extension's
brokered fetch (`gcuWebMCP.fetch = gcuFetch`) and the shim routes HTTP through the
extension, sidestepping the gate (the path weir uses for Lemonade). See [SPEC §4.1](SPEC.md).

**`fs`** — the same wire protocol over a **shared folder**: the bridge and page exchange
signed frames in `~/numen/<app>` (auto-created). **No port, no PNA, no extension** — so
it's the clean path for a public-origin PWA, and it reaches another machine if you sync
the folder. Inject `gcuWebMCP.folder = <handle>` and connect with the bare machine token.
Polling-based, so it's snappy in a foreground tab and throttled (but lossless) when the
tab is hidden. Full protocol + security model (signed sentinels, per-frame HMAC, the
threat model) in **[TRANSPORTS.md](TRANSPORTS.md)**.

## Security model in one line

The token stops random web pages from driving your localhost bridge; **per-app
consent (confirm-on-mutation) is the adapter's responsibility** — the transport
won't do it for you. See [SPEC.md §5](SPEC.md).

## License

MIT © Arthur Endlein Correia.
