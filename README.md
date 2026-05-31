# @gcu/webmcp

The official, zero-dependency way to connect **GCU browser surfaces** (weir,
Auditable notebooks, anything that loads the shim) to **Claude Code** — or any
MCP stdio client — over localhost.

```
┌──────────────────┐
│  weir  (browser) │──WS/HTTP──┐
└──────────────────┘           │   ┌──────────────────┐  stdio   ┌─────────────┐
                               ├──►│  webmcp-bridge   │◄────────►│ Claude Code │
┌──────────────────┐           │   │  (node, :7801)   │   MCP    │             │
│  another surface │──WS/HTTP──┘   └──────────────────┘          └─────────────┘
└──────────────────┘
```

**One bridge per app, on a stable per-app port, with a machine-global token.** A
Claude session started in an app's repo launches that app's bridge on that app's
port and sees only that app's tools — no crosstalk between apps. See
[SPEC.md](SPEC.md) for the full design; this is the quick start.

> Not a replacement for third-party MCPs (Gmail, Drive, …) — those install
> normally. This fronts *our* surfaces. The win is one bridge instead of one
> hand-written MCP server per GCU app.

> Don't confuse this with `@gcu/bridge`, the CORS **fetch** broker. This brokers
> agent↔page **tools**; that brokers page↔web **fetches**.

## Files

| File | Role |
|---|---|
| `webmcp-bridge.js` | Node bridge: MCP stdio ⇄ WebSocket/HTTP relay, tool merge, routing. Zero deps. |
| `shim.js` | Generic WebMCP polyfill — `navigator.modelContext` + transport client. Vendor into each app's build. |
| `SPEC.md` | Design + topology decisions + assigned-ports table. |

The **adapter** (the tools themselves) lives in each app's own repo — weir's
`weir-tools.js`, Auditable's `mcp-adapter.js` — not here.

Writing an adapter? See **[docs/large-results.md](docs/large-results.md)** for how
to keep tool results token-bounded (ranked truncation, two-tier list→detail,
keyset cursor pagination) — the one thing that bites every adapter the moment it
hits a real dataset.

## Quick start (wiring an app, e.g. weir)

1. **Vendor `shim.js`** into the app so it loads on the page, and set a stable id:
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
3. **Add `.mcp.json`** to the app's repo (point `args` at wherever the bridge lives):
   ```json
   {
     "mcpServers": {
       "webmcp-weir": {
         "command": "node",
         "args": ["webmcp-bridge.js", "--app", "weir", "--port", "7801"]
       }
     }
   }
   ```
4. **Connect once.** Print the connection string:
   ```
   node webmcp-bridge.js --app weir --port 7801 --info
   ```
   Paste the `port:token` into the page's MCP panel, or append `#mcp=port:token`
   to its URL. The page stores it (OPFS/localStorage) and reconnects silently
   after that.

In Claude Code: call `listClients` to see what's connected, then call the tools
the surface advertises.

## Ports & token

- **Ports** are app identity, not secret — committable. GCU reserves
  **7801–7820**; see the table in [SPEC.md §7](SPEC.md). weir = `7801`,
  auditable = `7802`.
- **Token** is machine-global, created on first run at `~/.gcu/webmcp.json`
  (mode `600`). It gates who may attach to your localhost bridge. Never commit it.
  Pages persist their own `port:token` in origin-scoped storage.

## Transport

WebSocket first; automatic HTTP long-poll fallback on `file://` origins (where
browsers block WS). Force one with a suffix: `port:token:http` or `port:token:ws`.

**Public https origins** (gentropic.org/weir, installed PWA) can't reach
`ws://localhost` — Chromium's Private/Local Network Access gates public→loopback.
Inject the `@gcu/bridge` extension's brokered fetch — `gcuWebMCP.fetch = gcuFetch`
— and the shim forces the HTTP transport through the extension, sidestepping the
gate (the same path weir uses for Lemonade). The bridge also sends
`Access-Control-Allow-Private-Network: true` so a *secure* origin can reach
loopback directly with the browser's one-time permission. See [SPEC §4.1](SPEC.md).

## Security model in one line

The token stops random web pages from driving your localhost bridge; **per-app
consent (confirm-on-mutation) is the adapter's responsibility** — the transport
won't do it for you. See [SPEC.md §5](SPEC.md).

## License

MIT © Arthur Endlein Correia.
