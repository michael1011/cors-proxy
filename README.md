# cors-proxy

A small Cloudflare Worker that proxies HTTP(S) requests and attaches permissive
CORS headers to the response, so browser code can call APIs that don't return
CORS headers themselves.

## Usage

Two equivalent forms:

```
GET https://<your-worker>/https://api.example.com/things
GET https://<your-worker>/?url=https://api.example.com/things
```

Path-style is preferred. If both are present, path-style wins — `?url=` is only
consulted when the path is empty. The proxy forwards the method, headers, body,
and query string verbatim, follows redirects, and returns the upstream status
and body to the caller with CORS headers added.

`OPTIONS` preflights are answered locally with `204` and never forwarded
upstream.

## Configuration

Set in `wrangler.toml` under `[vars]`, or via `wrangler secret put`.

### `ALLOWED_HOSTS` (optional)

Comma-separated list of hostnames the proxy is allowed to fetch. If unset or
empty, **all hosts are allowed** (open-proxy mode — see Security below).

Two pattern types:

| Pattern           | Matches                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `api.example.com` | exactly `api.example.com`                                                             |
| `*.example.com`   | any subdomain (`a.example.com`, `x.y.example.com`) but **not** the apex `example.com` |

Matching is case-insensitive. Requests to a non-allowed host return `403` with
a plain-text body.

```toml
[vars]
ALLOWED_HOSTS = "api.example.com,*.googleapis.com"
```

## Security model

This worker is intentionally minimal. Read this before deploying.

- **No authentication.** Anyone who can reach the worker URL can use it.
- **No rate limiting in code.** Use Cloudflare's WAF / Rate Limiting Rules if
  you need it.
- **Open proxy unless `ALLOWED_HOSTS` is set.** Without an allowlist, the
  worker will fetch any HTTP(S) URL on behalf of any caller. That makes it
  useful as a free anonymizer/scraping relay, so set `ALLOWED_HOSTS` for any
  deployment that isn't strictly first-party-internal.
- **Credentials are forwarded.** `Authorization`, `Cookie`, and other
  caller-supplied headers are passed through to the upstream unchanged. This
  is by design — the proxy is meant to be transparent — but it means anyone
  who can call the worker can send arbitrary credentials to an allowlisted
  host with the worker's IP as the source. Treat `ALLOWED_HOSTS` as the only
  thing standing between callers and the upstream.
- **Hop-by-hop and Cloudflare tracing headers are stripped.** `Connection`,
  `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `Host`, `CF-Connecting-IP`,
  `CF-IPCountry`, `CF-Ray`, `CF-Visitor`, `X-Forwarded-*`, `X-Real-IP` are
  removed from the outgoing request.
- **`Set-Cookie` is preserved.** Multiple upstream `Set-Cookie` headers are
  forwarded individually (not collapsed). Browsers will ignore them in
  cross-origin contexts because the response uses `Access-Control-Allow-Origin: *`
  without `Allow-Credentials: true`, but non-browser callers will see them.
- **Only `http:` and `https:` targets are accepted.** Other schemes are
  rejected with `400`.

## Development

Requires [Bun](https://bun.sh) and Wrangler.

```sh
bun install
bun run dev           # wrangler dev (local)
bun run test          # unit tests (test/)
bun run test:e2e      # e2e against a real wrangler dev instance (e2e/)
bun run typecheck     # tsc --noEmit
bun run lint          # oxlint
bun run lint:fix      # oxlint --fix
bun run format        # oxfmt (writes in place)
bun run format:check  # oxfmt --check (CI-friendly)
bun run deploy        # wrangler deploy
```

Linting and formatting are handled by [oxc](https://oxc.rs):
[`oxlint`](https://oxc.rs/docs/guide/usage/linter) for lint, [`oxfmt`](https://oxc.rs/docs/guide/usage/formatter)
for format. Configs live in `.oxlintrc.json` and `.oxfmtrc.json`.

CI runs lint + format-check + typecheck + tests on every push and pull request
(`.github/workflows/ci.yml`).

## Layout

```
src/index.ts        worker entrypoint (single file)
test/index.test.ts  unit tests (call worker.fetch directly)
e2e/proxy.test.ts   smoke tests against a spawned wrangler dev + mock upstream
wrangler.toml       worker config
```

The e2e suite boots `wrangler dev` on `127.0.0.1:18787` with
`ALLOWED_HOSTS=localhost` and a local mock upstream on `127.0.0.1:18788`, so it
exercises the real workerd runtime and real `fetch`. Set `DEBUG_E2E=1` to see
wrangler's output.

## License

MIT — see [LICENSE](./LICENSE).
