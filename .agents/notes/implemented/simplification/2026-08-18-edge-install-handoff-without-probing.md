# Agent Note: Hand off Edge deployments without CLI probing

Status: implemented

English | [中文](2026-08-18-edge-install-handoff-without-probing.zh.md)

The conclusion that the installer performs no public request is superseded by [branding the installer and observing public activation](../feature/2026-08-21-installer-activation-experience.md). Wrangler acceptance remains the success boundary; the later observation cannot turn an accepted upload into a failed installation.

This decision supersedes the installer-polling portion of [verifying Edge deployment readiness](../process/2026-08-17-edge-deployment-readiness.md), the installer health-shell match described by the [free direct Edge shell](../architecture/2026-08-17-free-direct-edge-shell.md), and refines the post-upload boundary in the [guided Edge installer](../feature/2026-08-17-guided-edge-installer.md). The public health endpoint, release identifier, runtime-mode report, and configuration validation remain implemented.

## Problem

A successful Wrangler deployment produces the URL and credentials that the owner needs, but public route availability is controlled by Cloudflare. A newly uploaded Worker can encounter propagation delay or a platform challenge before its code runs. Treating an immediate CLI HTTP probe as part of installation therefore adds latency and can turn a successful upload into a false installation failure.

## Decision

The `dsh-edge install` command finishes its deployment contract when Wrangler succeeds and its versioned structured output yields a valid public `workers.dev` URL. A temporary-account installation additionally requires Wrangler to return a claim URL. The installer does not request the deployed Worker or authenticate on the user's behalf.

The success handoff prints the public URL and owner access key. For a temporary account it also prints the claim URL and tells the user to claim the account within 60 minutes before opening the Worker and entering the owner key. For an authenticated account it tells the user to open the Worker and enter the owner key. Success means that Cloudflare accepted the upload and the installer delivered the information needed for the next step; it does not claim that the public application was probed.

If upload succeeds but structured-output parsing, claim-URL extraction, interruption handling, or local credential cleanup prevents a normal handoff, the recovery card retains the active owner key and every known URL before the command exits unsuccessfully.

`GET /api/health` remains a public, side-effect-free diagnostic for users, monitors, and explicit smoke tests. It reports the release identifier compiled into the artifact and validates the default DeepSeek credential, model and transport choices, owner-key configuration, and command-timeout policy. It does not call DeepSeek, instantiate the owner Durable Object, mutate the VFS, or execute the shell.

## Alternatives considered

**Block installation on a public health poll:** this can catch invalid runtime configuration, but Cloudflare propagation and challenge responses are outside the installer contract and can reject an otherwise successful upload. The user can inspect health explicitly after deployment.

**Use the owner key to perform a CLI login and authenticated smoke test:** the installer already has the key, but replaying it over the public route increases credential handling and duplicates the browser interaction without proving that the user's browser can access the application.

**Remove the health endpoint with the installer probe:** operational diagnostics remain useful independently of the guided install, so the endpoint and release identifier stay available.

## Consequences

- Installation performs no post-upload network request to the Worker for either temporary or authenticated accounts.
- Cloudflare challenge and propagation responses cannot convert a successful Wrangler upload into an installer failure.
- The final UI describes concrete owner actions instead of claiming that dsh-edge is already ready.
- A malformed or missing structured deployment target still fails closed because the installer would have no safe URL to hand off.
- A temporary deployment without a claim URL still fails closed because the user could not retain it.
- Runtime configuration and provider availability are first observed when the user opens the application, queries `/api/health`, or runs an explicit smoke test.
- Unit and snapshot tests pin the upload boundary, output parsing, credential cleanup, recovery details, and next-step handoff without mocking a public readiness request.
