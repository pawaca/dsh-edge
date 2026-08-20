---
name: dsh-code-review
description: Review dsh-edge pull requests for Cloudflare runtime correctness, upstream-wrapper boundaries, durable compatibility, credential safety, package integrity, and focused evidence. Use when judging review findings or deciding whether an Edge PR is ready to merge.
---

# Review a dsh-edge PR

Verify the live base and exact head, inspect the complete diff, and read [`AGENTS.md`](../../../AGENTS.md) plus the active Agent Note. Prioritize correctness, security, persistent data, release artifacts, and required user behavior over style.

## Blocking checks

1. Upstream behavior is composed from exact published packages. Flag copied Harness source, workspace fallbacks, ranges, dist-tags, or dependencies supplied accidentally by the root install.
2. Direct and Dynamic Loader artifacts preserve the intended parity. Tests must start promoted or packed artifacts when validating release behavior.
3. Durable Object bindings, class names, SQL/KV/VFS data, session events, auth cookies, and routes remain compatible unless the owning decision explicitly changes them.
4. DeepSeek and owner credentials remain request-scoped or Worker secrets and never enter durable state, VFS, responses, generated configuration, logs, fixtures, or tarballs.
5. Direct mode stays within its gzip budget and does not silently gain unsupported network, process, PTY, or native-binary behavior.
6. Patch files are version-bound, narrowly justified, mechanically exercised, and removable when upstream supplies the capability.
7. Installer and release changes are cross-platform, do not guess deployment success, preserve secrets, and verify the exact npm artifact.
8. Product and legal prose describes an independent pawaca-maintained project and does not imply DeepSeek ownership or endorsement.

## Judge evidence

Trace the real HTTP/WebSocket, Durable Object, installer, Worker, and browser entrypoints affected by the change. Confirm tests fail for the claimed regression rather than restating implementation details. Compare English and Chinese text semantically; a pairing hash proves synchronization, not translation quality.

Report each defect with location, impact, and evidence. Treat incoming findings as claims: fix valid in-scope defects, rebut stale or incorrect claims, and request a user decision only when the repair changes product, security, durable data, public API, or PR scope.
