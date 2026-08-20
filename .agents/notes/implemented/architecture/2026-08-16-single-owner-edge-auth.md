# Agent Note: Add single-owner authentication to dsh-edge

Status: implemented

English | [中文](2026-08-16-single-owner-edge-auth.zh.md)

## Problem

The upstream local application relies on a trusted-user boundary and has no account model to preserve on Cloudflare. A public `dsh-edge` Worker still needs to protect the upstream UI, HTTP APIs, hibernatable WebSockets, DeepSeek credentials, and Durable Object state. Adding registration, password recovery, roles, email delivery, or an external identity product would create a second product surface and couple the runtime adapter to concerns the upstream project does not own.

The earlier instance selector is also unsuitable as identity. A caller-chosen header or query parameter cannot authorize access to a Durable Object.

## Decision

Treat one Cloudflare deployment as one owner. `DSH_EDGE_ACCESS_KEY` is one random 32–512-UTF-8-byte Worker secret. The entry Worker validates it through a size-bounded form and constant-work digest comparison, then issues an opaque HMAC-SHA256 cookie. The cookie contains only its version, expiry, and signature; it is HttpOnly, `SameSite=Strict`, scoped to `/`, and valid for 30 days. HTTPS deployments use the `Secure`, host-only `__Host-dsh_edge_owner` name; local HTTP development uses an unprefixed fallback because browsers require `Secure` for `__Host-` cookies. The same secret signs the cookie with a domain-separated message, so the deployment needs no second signing secret and rotating the access key invalidates every session.

The Worker serves a script-free login page at `/login`. It redirects an unauthenticated `/` request there and returns 401 for every other protected API or WebSocket request. Owner-authentication 401 responses carry the `WWW-Authenticate: DshEdgeOwner` challenge. The Edge Web assembly injects a small deployment guard ahead of the unchanged upstream bundles; only a same-origin API 401 carrying that exact challenge navigates the browser to `/login`, instead of leaving the upstream transport in a permanent reconnect loop. Other 401 responses, including missing or rejected provider credentials, remain visible to the upstream UI because another login cannot repair them. `/api/auth/session` reports cookie validity and `/api/auth/logout` expires it. Authentication form mutations reject cross-site browser requests. Every authenticated browser request that carries an `Origin` header must also match the exact deployment origin, because `SameSite=Strict` alone does not separate untrusted sibling origins on one registrable domain; this one check covers API reads, mutations, and WebSocket upgrades before runtime routing. Assembly also emits a Cloudflare asset policy with `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Applying it at the asset layer covers `/`, the direct `/index.html` asset, and arbitrary SPA fallback aliases, including paths Cloudflare serves without invoking the Worker. Non-browser clients without an `Origin` header remain supported. The public surface is limited to `/api/health`, the login flow, and immutable client assets; asset access alone grants no API or WebSocket access.

Every authenticated runtime request maps to the fixed `owner` `DshEdgeInstance`. The Worker rejects `x-dsh-edge-instance` and the `instance` query parameter. Before it forwards an upstream request to the Durable Object, it removes the owner cookie, generic authorization header, and legacy selector. For a WebSocket upgrade it replaces any caller value with trusted expiry metadata from the verified cookie. The Durable Object stores that expiry beside the channel in the hibernation attachment and schedules an alarm, so an open downlink cannot outlive the owner session that authorized it. Upstream UI bundles, `ApiProxy` envelopes, WebSocket frames, session schemas, persistence services, and the Durable Object storage layout remain unchanged.

## Alternatives considered

- **Better Auth or another embedded account system:** this supports multiple users and commercial account flows, but requires user tables, migrations, session storage, recovery policy, and UI integration that this single-owner open-source deployment does not need.
- **Cloudflare Access:** this is operationally strong, but makes a basic deployment depend on another configured product and moves the first-run experience outside the repository.
- **HTTP Basic authentication:** browsers expose awkward credential caching and logout behavior, and every request carries the reusable secret rather than an opaque session.
- **Keep caller-selected instance names behind one shared key:** this creates accidental multi-tenancy without ownership, quotas, administration, or isolation policy.
- **Fork the upstream Web UI to add account controls:** the authentication boundary exists before the upstream protocol and requires only a small login shell. A UI fork would increase upstream synchronization cost without improving the boundary.

## Consequences

- A deployer configures one owner key and logs in through one form. There is no registration, user database, role model, password reset, or per-user settings layer.
- HTTP APIs and both hibernatable WebSocket downlinks share one authentication and exact-origin enforcement point before Durable Object or workspace routing. Every asset-served shell alias is non-framable. A sibling-origin browser cannot use a same-site owner cookie to read or mutate runtime state, subscribe to downlinks, or clickjack the owner through an embedded shell. Forwarded requests never carry the owner cookie or generic authorization header; only the verified expiry reaches a downlink handshake, and Durable Object code does not read the deployment's access-key binding.
- The owner key is both the login credential and the root of cookie signatures. Rotation invalidates every cookie and future handshake; already-open downlinks remain bounded by the signed expiry recorded when they connected. Loss requires replacing the Worker secret.
- Ordinary static bundles remain public, cacheable, and able to bypass Worker execution; possessing those immutable files grants no runtime access. `/`, `/login`, and `/api/*` run Worker code first, so the normal application entry and every protocol operation require authentication.
- Switching from the earlier caller-selected `local`/named objects to the fixed `owner` object intentionally leaves prototype data under old Durable Object names unreachable. There is no migration because the fork has no released or hosted data.
- This boundary is appropriate for a personal or trusted-team deployment that shares one owner key. Supporting independent users later requires a separate identity-to-object routing design rather than expanding the instance selector.

## Verification

Focused tests cover unsafe deployment configuration, UTF-8 byte constraints, invalid and oversized login attempts, cross-site rejection, host-bound cookie flags, duplicate-cookie handling, expiry claims, tampering, key rotation, session reporting, and logout. Wrangler integration covers locked root and API requests, real login, authenticated HTTP and WebSocket traffic, non-framable headers on the routed root plus direct and SPA-fallback shell aliases, sibling-origin API mutation and WebSocket rejection, runtime-enforced WebSocket expiry, selector rejection, cookie survival across a Worker restart, and the existing Durable Object session and workspace flows. The browser snapshot enters the owner key before exercising the unchanged upstream Web UI, then replaces the owner session with a short-lived signed cookie and verifies automatic navigation back to the login shell after expiry.
