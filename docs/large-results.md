# Bounding large results in WebMCP tools

Guidance for **adapter authors** (the per-app `*-tools.js` that registers tools on
`navigator.modelContext`). The transport doesn't bound anything — each tool's
result is your responsibility. Learned the hard way: weir's first `listFacets`
returned every term of every facet and dumped **476 KB / 31 k lines** the moment it
hit a real corpus.

## Why it matters

A tool result goes **straight into the model's context**. So an unbounded result
either:

- **errors** — the host rejects oversized results (and may spill them to a file the
  agent then has to grep), or
- **burns context** — a few hundred KB of JSON crowds out everything else and costs
  real tokens.

The constraint isn't "rows" — it's **tokens**. Design every tool to return
something *useful and bounded*, with a way to get more **only if the agent asks**.

## The patterns (pick by result shape)

| Result shape | Pattern | Why |
|---|---|---|
| A summary / aggregate (facets, counts, histogram) | **Ranked truncation + filters** | The agent wants the *head* of the distribution; the long tail is noise. Return top-N by rank + `total`/`omitted`, plus knobs to drill (`facet`, `minCount`). Pagination would page through junk. |
| A list the agent *browses* | **Two-tier: lean list → detail fetch** | Return ids + short summaries; a *separate* tool fetches full detail by id. Keeps list output tiny; the agent pulls detail only for what it cares about. Usually the best default. |
| A list the agent must *exhaust* (migrate, "find all X") | **Keyset cursor pagination** | Opaque `nextCursor`; pass it back for the next page. The MCP-native shape (`tools/list`/`resources/list` use `cursor`/`nextCursor`). |
| Anything | **Filters over paging** | Rich narrowing (type, date range, owner, status) so the result is *naturally small*. The agent usually wants the *right 20*, not *page 7*. Good filters beat deep pagination. |
| Always | **Hard cap + `total`/`hasMore`** | Even with the above, cap the page and tell the agent how much it isn't seeing, so it can decide to narrow or page. |

Compose them. weir does: **ranked truncation** for `listFacets`, **two-tier**
(`queryItems` → `getItem`), **keyset cursor** on `queryItems`, and a **hard cap**
everywhere.

## Keyset, not offset

For exhaustive paging, prefer a **keyset** cursor (encode the sort key of the last
row) over a numeric `offset`:

- **Offset** (`skip N`) is fragile on a **live** dataset. weir polls constantly; if
  new items are inserted while the agent pages, an offset **skips or repeats** rows.
- **Keyset** encodes *where you were in sort order*, not *how many you skipped*. New
  rows that sort *above* the cursor are simply not re-served; rows below are reached
  exactly once. Stable across mutations.

Make the cursor **opaque** (base64 of a small JSON `{sortKey, id}`), include the
`id` as a tie-breaker so it's exact even when sort keys collide, and **tolerate a
bad cursor** (ignore it, return the first page) rather than erroring.

## Worked example — weir

**Ranked truncation** (`weir_listFacets`): per facet, return the top-N terms by
count with bookkeeping, and let the agent drill.

```js
// input: { facet?, limit=25 (max 200), minCount=1 }
out[facet] = { total: all.length, terms: all.slice(0, limit) };
if (all.length > limit) out[facet].omitted = all.length - limit;
```

**Keyset pagination** (`weir_queryItems`): newest-first, `(published_at desc, id
asc)` total order, opaque cursor.

```js
const pa  = (r) => r.published_at || 0;
const cmp = (a, b) => (pa(b) - pa(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const rows = store.query(opts).sort(cmp);

let start = 0;
if (cursor) {
  const c = decCursor(cursor);                       // bad cursor → null → start 0
  if (c) { const i = rows.findIndex(r => cmp({ published_at: c.pa, id: c.id }, r) < 0);
           start = i < 0 ? rows.length : i; }
}
const page = rows.slice(start, start + limit);
const out  = { count: page.length, total: rows.length, hasMore: start + page.length < rows.length, items: page.map(proj) };
if (out.hasMore && page.length) { const last = page[page.length - 1]; out.nextCursor = encCursor(pa(last), last.id); }
```

```js
const encCursor = (pa, id) => btoa(unescape(encodeURIComponent(JSON.stringify({ pa: pa || 0, id }))));
const decCursor = (s) => { try { const o = JSON.parse(decodeURIComponent(escape(atob(String(s))))); return typeof o.id === 'string' ? { pa: o.pa || 0, id: o.id } : null; } catch { return null; } };
```

**Two-tier**: `weir_queryItems` returns compact projections (id, title, url, feed,
published, tags, short excerpt); `weir_getItem` fetches the full record + facets +
(opt-in) extracted body by id.

## Checklist for a new tool

- [ ] Could this result be large on a real dataset? If yes, bound it **now** — don't
      wait for the corpus to find out.
- [ ] Cap the page; include `total` and `hasMore` so the agent knows there's more.
- [ ] Aggregate? Rank + truncate + offer drill filters. Don't paginate noise.
- [ ] Must be exhaustible? Add a **keyset** cursor (`nextCursor`), tolerate a bad one.
- [ ] Return ids + summaries; put full payloads behind a **separate detail tool**.
- [ ] Prefer adding a **filter** over adding a page.
- [ ] Keep individual fields lean (truncate long text; cap embedded bodies).
