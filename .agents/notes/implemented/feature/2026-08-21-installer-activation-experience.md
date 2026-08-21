# Agent Note: Brand the installer and observe public activation

Status: implemented

English | [中文](2026-08-21-installer-activation-experience.zh.md)

This decision supersedes the no-request conclusion in [handing off Edge deployments without CLI probing](../simplification/2026-08-18-edge-install-handoff-without-probing.md). It preserves that decision's upload-success boundary: public activation remains an observation, not an installation gate.

## Problem

The guided installer begins with a generic command label and ends as soon as Wrangler reports a target. The result is technically accurate but does not establish a recognizable product experience. More importantly, Cloudflare can return the public `workers.dev` origin before its route is available everywhere. Opening the printed URL immediately can show a platform placeholder such as “There is nothing here yet,” leaving the owner unsure whether the upload failed.

## Decision

An interactive terminal renders a static, dependency-free dsh-edge wordmark, the “DeepSeek Harness on Cloudflare” value proposition, the package version, the community-project boundary, and the selected operation before the first prompt. Narrow and non-interactive terminals receive a one-line identity instead. The hero uses the existing managed output boundary so a closed terminal still follows the installer's interruption and credential-recovery rules.

After Wrangler succeeds, the installer removes its temporary secret file and validates Wrangler's structured target exactly as before. It then tells the owner that Cloudflare usually activates the public URL in 10–30 seconds and observes `GET /api/health` for at most 45 seconds. Each request has a four-second timeout, redirects are not followed, responses are bounded to 64 KiB, and retries wait 1.5 seconds. The request carries only `Accept` and no-cache headers; it never transmits the owner access key, DeepSeek API key, cookie, bearer token, or instance selector.

Activation is ready only when the response identifies the exact packaged dsh-edge version, selected direct or isolated mode, expected shell, Durable Object SQLite VFS storage, service, and ready status. HTTP errors, DNS and transport failures, Cloudflare challenge responses, non-JSON placeholders, oversized bodies, another runtime, and an older release are transient observations until the bounded wait expires.

Wrangler acceptance remains the installation success boundary. A matching health response produces a prominent ready card. Expiry of the observation window produces an activation-pending card, retains exit status zero, explains that first-time `workers.dev` activation can take about a minute, and tells the owner that a placeholder can be refreshed after Cloudflare finishes activation. Temporary installs continue to put account claiming before opening the Worker. If the process is interrupted while observing an already-uploaded Worker, the existing recovery path prints the active owner key and known URLs before cleanup and failure exit.

## Alternatives considered

**Keep the immediate handoff:** this avoids an HTTP request but knowingly sends owners to a URL that may still show a platform placeholder.

**Restore readiness as a hard deployment gate:** this confuses Cloudflare propagation and challenge behavior with upload failure. A successfully uploaded Worker must not become a failed install merely because the public route took longer than the local observation window.

**Authenticate the CLI with the owner key:** health is already public and side-effect free. Replaying the owner credential adds exposure without improving the activation signal.

**Probe the browser root or perform a model turn:** the root mixes asset and login behavior, while a turn spends provider quota and mutates Durable Object state. The existing health identity is the smallest stable activation contract.

**Add a banner package or runtime endpoint:** a static wordmark avoids another dependency, and the existing health route already carries the required release and runtime facts.

## Consequences

- Interactive installs have recognizable product framing without affecting Worker bundles or their compressed-size budgets.
- Owners are not invited to open the public URL until the exact release is observed or the installer clearly labels activation as pending.
- Public activation delay cannot change an accepted upload into a failed installation.
- The observer does not prove DeepSeek provider reachability, create a session, instantiate the owner Durable Object, touch VFS state, or execute a command.
- Reinstalling the same package and mode can match an already-active artifact because the public health identity is release-scoped rather than Cloudflare-version-scoped. The URL is already usable in that case; future per-upload identity would require a new runtime binding and is outside this UX change.
- Unit coverage fixes exact health matching, credential-free manual-redirect requests, bounded bodies, pending timeout, interruption recovery, and ready/pending UI. The PTY transcript runs the shipped bin through the complete temporary-account journey and records both the Hero and activation boundary.
