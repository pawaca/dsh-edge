# dsh-edge

[![npm](https://img.shields.io/npm/v/dsh-edge)](https://www.npmjs.com/package/dsh-edge)
[![CI](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml/badge.svg)](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml)
[![License: MIT](https://img.shields.io/github/license/pawaca/dsh-edge)](LICENSE)

English | [中文](README.zh.md)

## DeepSeek Harness in your browser, deployed to Cloudflare with one command

DeepSeek Harness combines a capable coding-agent Web UI with a local host runtime. `dsh-edge` packages that experience for Cloudflare Workers so your personal agent is available from any browser—without maintaining a server, creating a GitHub repository, or setting up a build pipeline.

It keeps the upstream UI, agent loop, session protocol, model catalog, image experience, and Web Search intact. The Edge layer supplies the Cloudflare runtime, durable storage, single-owner login, and guided installer.

![dsh-edge running the upstream DeepSeek Harness Web UI with image input and Vision Exp](docs/assets/dsh-edge-browser.png)

> **Independent community project:** `dsh-edge` is maintained by [pawaca](https://github.com/pawaca). It is not affiliated with or endorsed by DeepSeek. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream project.

## Install

You need Node.js 22.14 or newer and your own DeepSeek API key:

```sh
npx dsh-edge install
```

The installer walks you through the runtime, Cloudflare account, Worker name, owner access key, DeepSeek key, cost summary, upload, and route activation. Choose the temporary-account path to try it without an existing Cloudflare login. Claim that deployment within 60 minutes if you want to keep its Worker and data.

The command installs the current stable release from npm. Prereleases, when available, remain opt-in through `npx dsh-edge@next install`.

## What you can do

- Continue persistent conversations and workspaces from any browser.
- Use DeepSeek V4 Flash, V4 Pro, or the experimental V4 Flash Vision Exp model through the upstream selector.
- Paste or drop PNG/JPEG images into the upstream composer and revisit them in conversation history.
- Search the Web with DeepSeek's native Web Search tool.
- Read and write a persistent `/workspace` and let the agent use its `bash` tool.
- Keep your DeepSeek key and data in your own Cloudflare deployment.
- Upgrade in place without attaching the Worker to this repository or Cloudflare Builds.

## Two deployment paths

| Path | Cloudflare account | Image storage | Best for |
| --- | --- | --- | --- |
| **Temporary preview** | No existing login required; claim within 60 minutes | Bounded 64 MiB Durable Object backend | Trying the complete browser and image flow with the lowest friction |
| **New permanent deployment** | Existing or newly authenticated account; R2 subscription must be enabled | Private R2 bucket | Keeping conversations and images in your own long-lived account |

The attachment backend is selected once per deployment and remains pinned across Durable Object sleep, claim, and upgrade:

- Claiming a temporary deployment preserves its DO-backed images; it does not silently migrate them to R2.
- R2 Standard has an [included monthly free tier](https://developers.cloudflare.com/r2/pricing/), but its separate usage-based subscription must first be [enabled in the Dashboard](https://developers.cloudflare.com/r2/get-started/).
- The first 0.3 upgrade of an older Worker asks once between no-setup Durable Object storage (64 MiB per instance) and private R2.
- The installer validates an R2 choice before collecting Worker secrets and, when safe, offers a switch back to DO storage if R2 is unavailable.
- Later upgrades preserve the selected backend and never migrate image data automatically.

### Choose a command runtime

| Mode | Cloudflare plan | Command runtime | Trade-off |
| --- | --- | --- | --- |
| **Free — Direct Shell** | Workers Free | Hardened just-bash inside the owner Durable Object | Lowest-friction personal deployment |
| **Isolated — Dynamic Worker** | Workers Paid | Cloudflare Computer Worker Shell through Worker Loader | Command execution in a separate Worker |

Both modes use the same UI, protocol, tools, conversations, workspace, image flow, and installer. Direct Shell is not a Linux container: it has no native binaries, background processes, PTYs, arbitrary Linux behavior, or shell networking. Do not expose it to untrusted users.

## Upgrade

```sh
npx dsh-edge upgrade
```

Select the existing Worker and the same runtime. Durable Object data and the deployment's pinned attachment backend are retained. Because Cloudflare secrets are write-only, the installer asks for the existing owner access key and DeepSeek API key again.

If the installed version contains `-alpha` or `-rc`, promote it to the stable channel once with `npx dsh-edge@latest upgrade`. Use `npx dsh-edge@next upgrade` only when you deliberately want to remain on prereleases.

## Data, credentials, and limits

- Conversations, workspace metadata, and `/workspace` files live in the deployment's Durable Object storage.
- R2-backed deployments store admitted images as immutable objects in a private bucket. DO-backed deployments use a 64 MiB, 512 KiB-chunked backend in the owner instance. Session events retain only upstream content-addressed references.
- Image admission accepts PNG and JPEG, at most 4 images per message, 3.5 MiB per image, 7 MiB total, 40 million pixels, and 2,000 pixels per side.
- `DEEPSEEK_API_KEY` and `DSH_EDGE_ACCESS_KEY` are Worker secrets. Their literal values are never written to session events, Durable Object state, the VFS, or browser responses.
- The installer sends secrets to Wrangler through a temporary mode-`0600` file, removes it afterwards, and never creates a source-build integration.
- The owner cookie is HttpOnly, `SameSite=Strict`, and valid for 30 days. Rotating the owner access key invalidates existing sessions.

## Current boundaries

`dsh-edge` is deliberately single-owner. It does not provide registration, multiple users, roles, or tenant routing. Vision Exp is experimental and may not be available to every DeepSeek account.

Non-image file attachments, session export, `@file` and `@session` references, remote MCP, Skills, Workflows, Jobs, and Subagents are not yet adapted to Edge. `web_fetch` remains disabled until the runtime has an explicit policy for SSRF, private addresses, and redirects.

See the [runtime reference](apps/dsh-edge/README.md) for the full compatibility matrix, API, limits, security behavior, and implementation details.

## How it stays close to upstream

This repository wraps exact published DeepSeek Harness packages instead of copying its monorepo. Upstream owns the Web UI, plugin composition, agent loop, model and attachment protocols, and session contracts. dsh-edge implements only the Cloudflare-specific runtime and storage seams.

Edge runtime code lives in [`apps/dsh-edge`](apps/dsh-edge). The small [`packages/client/ui-edge`](packages/client/ui-edge) plugin contributes deployment status, upgrade guidance, and owner-session controls through upstream client slots. The isolated assembly in `apps/dsh-edge/standalone` pins one upstream version and records every unavoidable version-bound patch.

For upstream architecture and plugin development, see the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and [reference documentation](https://deepseek-harness.github.io/deepseek-harness/reference/).

## Develop locally

Source checkout is only required for dsh-edge development. The repository toolchain requires Node.js `^22.19.0` or `>=24.0.0`:

```sh
git clone https://github.com/pawaca/dsh-edge.git
cd dsh-edge
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
```

Complete the [local Edge setup](apps/dsh-edge/README.md#run-locally), including an ignored `.dev.vars`, then run:

```sh
pnpm --filter dsh-edge dev
```

## Contributing and support

- Report dsh-edge bugs and installation problems in [Issues](https://github.com/pawaca/dsh-edge/issues).
- Report vulnerabilities through the [private security process](SECURITY.md), not a public Issue.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) when changing the repository.

## License

[MIT](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
