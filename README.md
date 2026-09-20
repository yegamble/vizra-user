# vizra-user

Vizra's user-facing application: Next.js App Router, TypeScript and Tailwind,
consuming the TypeScript client generated from `vizra-core`'s OpenAPI contract.
A component of [yegamble/vizra](https://github.com/yegamble/vizra).

## Requirements
- Node — the version in [`.nvmrc`](.nvmrc) (`nvm use`). npm, with the committed
  lockfile.
- A reachable `vizra-core` for anything beyond the skeleton.

## Quick start
```sh
npm ci
INTERNAL_API_BASE_URL=http://127.0.0.1:8080 \
PUBLIC_ORIGIN=http://127.0.0.1:3000 \
npm run dev
```

`/health` is a liveness page: it says this process renders. It deliberately
reports nothing about vizra-core, PostgreSQL, the cache or storage — that is
core's `/readyz`.

## The gate
```sh
npm run ci          # lint, typecheck, test, build — what CI runs
npm run check:contract   # vendored contract ↔ manifest ↔ generated client
```

## Configuration
Read from the environment at request time; nothing is baked into the image.

| Variable | Meaning |
|---|---|
| `INTERNAL_API_BASE_URL` | how this process reaches vizra-core (inside the compose network) |
| `PUBLIC_ORIGIN` | the instance's public origin, sent as `Origin` on state-changing requests |
| `API_TIMEOUT_MS` | deadline for one request to vizra-core — both the default and the ceiling a caller cannot exceed (default 10000) |

## Contributing
Read [`AGENTS.md`](AGENTS.md) first. In short: the API contract belongs to
`vizra-core` and the client here is generated from it; all server-side API
access goes through `publicFetch` / `viewerFetch`; no mock data on a product
path.

## Status
M0 foundation skeleton (VZ-FOUND-002). There is no product surface yet.
