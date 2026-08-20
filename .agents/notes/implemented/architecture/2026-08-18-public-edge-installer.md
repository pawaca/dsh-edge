# Agent Note: Publish dsh-edge as an independent installer

Status: implemented

Repository-structure details in this note are superseded by the [standalone wrapper plan](../../proposed/architecture/2026-08-19-dsh-edge-standalone-wrapper.md). The installer and publication decisions remain in force.

English | [中文](2026-08-18-public-edge-installer.zh.md)

## Problem

Running the Edge deployment from a repository checkout makes installation depend on Git, the monorepo, and workspace dependency links. It also leaves deployed instances without a repeatable versioned upgrade path.

## Decision

Publish `dsh-edge` as an unscoped npm package with its own semantic version and `dsh-edge-v*` release tags. It remains inside the fork for source synchronization but is excluded by exact path from the upstream `@deepseek-ai/*` release family. The workspace constraint gate gives that exact application an independent public policy for its name, repository, access, and payload instead of treating it as a private app or upstream release member. The tarball contains the assembled Web assets, Worker source, Wrangler configuration renderer, installer, both runtime bundle gates, and package-local license and third-party notices derived from the repository-root legal authorities before packing. The [independent package attribution note](../process/2026-08-18-dsh-edge-independent-package-attribution.md) owns that derivation and validation contract; this note owns which artifacts the installer publishes. Workspace dependency specs become exact published versions in the tarball, and package metadata records the DeepSeek Harness base version used by runtime health.

The CLI exposes `install` and `upgrade`. Install may create a temporary direct-mode Cloudflare account; upgrade requires an authenticated account and an existing Worker. Upgrade redeploys the selected runtime and replaces the entered write-only secrets while preserving Durable Object storage. The browser checks the public npm registry without credentials, fails soft when it is unavailable, and only offers a copied CLI command rather than handling Cloudflare authority itself. The Windows-native standalone release job pins an npm version that supports Trusted Publisher OIDC and serializes publication. It compares the current channel before publishing: a newer candidate receives `latest` or `next` atomically from `npm publish`, while a delayed older candidate uses `historical`, so the OIDC-only workflow cannot regress the installer or its update check.

The first package version is published by the `pawaca` npm owner. Subsequent tagged releases use npm Trusted Publishing from the repository-owned GitHub Actions workflow, without a long-lived npm publish token. Publication uses the repository release helper: a retry skips an existing version only when npm reports the same tarball integrity and rejects different content under the immutable version.

## Alternatives considered

- **Require a source checkout:** this retains workspace-only assumptions and makes the advertised one-command install misleading.
- **Give the Edge package an unavailable npm scope:** package ownership would not match the maintainer's actual npm authority.
- **Deploy upgrades from the browser:** Cloudflare credentials would cross into the Worker or browser security boundary.
- **Use the upstream release family:** an independently versioned application would couple fork releases to every upstream package version.

## Consequences

- Users install or upgrade with `pnpm dlx dsh-edge@latest <command>` and do not need a GitHub repository or Cloudflare Builds project.
- The npm tarball, not the monorepo checkout, is the tested deployment artifact.
- Updating the upstream base requires updating the exact dependencies and recorded base version together.
- npm package ownership and GitHub Trusted Publisher configuration remain release-maintainer responsibilities.

## Verification

CI builds the assembled Web client, packs the npm artifact, installs it outside the workspace, checks its version and help entry points, and dry-runs both direct and isolated Worker bundles. Installer tests cover command routing, account eligibility, existing-Worker behavior, secret cleanup, and recovery output; client tests cover version comparison, fail-soft registry access, clipboard guidance, and state ownership.
