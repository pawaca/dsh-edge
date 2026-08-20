# Agent Note: dsh-edge root landing page

Status: implemented

Repository-structure and inherited-document details in this note are superseded by the [standalone wrapper plan](../../proposed/architecture/2026-08-19-dsh-edge-standalone-wrapper.md). The product-first dsh-edge landing-page decision remains in force.

English | [中文](2026-08-18-dsh-edge-root-landing-page.zh.md)

## Problem

The fork inherited a root README written for upstream DeepSeek Harness. A visitor arriving at the dsh-edge repository therefore had to discover the Edge package before learning the fork's purpose, installation path, deployment modes, ownership, or limitations. The upstream README decision deliberately preserves the upstream product narrative, which cannot also represent this independently maintained fork.

## Decision

The dsh-edge root README is the public landing page for the fork. It leads with the browser-accessible Cloudflare deployment, the guided `npx dsh-edge@latest install` path, the free and isolated runtime choices, the single-owner security model, current capability gaps, and an explicit statement that the project is not affiliated with or endorsed by DeepSeek.

The page keeps high-level upstream architecture and contribution links, while detailed runtime behavior remains in `apps/dsh-edge/README.md`. It names the fork-owned `apps/dsh-edge` and `packages/client/ui-edge` areas so maintainers can distinguish the localized Edge adaptation from synchronized upstream packages.

Existing upstream documentation continues to link to the root `#run` and `#run-from-source` anchors. Those anchors retain their local DeepSeek Harness Web UI meaning and the `pnpm dsh web` command. A separate `pnpm --filter dsh-edge dev` path starts the Edge Worker locally. The English and Chinese pages have the same technical structure and commands.

This decision superseded the [upstream product-first root README decision](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/process/2026-07-22-product-first-root-readme.md) for the former fork's landing page.

## Alternatives considered

**Keep the upstream README at the fork root.** This minimizes the sync diff, but it hides the fork's value, installation path, deployment costs, security model, and independent ownership at the repository's primary entry point.

**Document dsh-edge only under `apps/dsh-edge`.** This preserves the upstream root unchanged, but requires every new visitor to know the package location before they can understand or install the product.

**Replace the upstream development entry points.** A purely Edge-focused page is simpler, but existing user and plugin-development guides rely on the root launch anchors and their local-filesystem semantics. Keeping distinct upstream and Edge source commands preserves both workflows without presenting one as the other.

## Consequences

The repository now explains its purpose, install command, operating modes, security stance, ownership, and limitations before exposing upstream implementation detail. The root README carries a small maintained summary of facts owned by the Edge runtime reference, so changes to installation, runtime modes, or supported capabilities update both locations. Upstream synchronization retains a deliberate root README difference, while the stable launch anchors keep inherited guides accurate.
