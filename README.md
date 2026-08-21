# dsh-edge

English | [中文](README.zh.md)

Run DeepSeek Harness in your own Cloudflare account and use it from any browser. `dsh-edge` packages the upstream Web UI, agent loop, session protocol, DeepSeek Web Search, and a persistent workspace into one guided Cloudflare Workers installation.

No server or GitHub repository is required. The installer can deploy a free single-owner instance, collect the required secrets without echoing them, and print the URL and owner access key when it finishes.

> **Independent project:** `dsh-edge` is maintained by [pawaca](https://github.com/pawaca). It is not affiliated with or endorsed by DeepSeek. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) remains the upstream project.

## What you get

- The upstream DeepSeek Harness Web UI and typed HTTP/WebSocket protocol.
- Persistent conversations and a `/workspace` virtual filesystem backed by Durable Object SQLite.
- DeepSeek chat and native Web Search using your own API key.
- A `bash` tool over the persistent workspace, with a free direct runtime or an optional isolated runtime.
- One owner access key exchanged for a signed browser cookie; the installer can generate a high-entropy value.
- Guided install and upgrade commands that upload directly through Wrangler without creating a source-build pipeline.

## Install

### Install an Edge instance

You need Node.js 22.14 or newer and a DeepSeek API key. A Cloudflare account is optional for the free temporary-account path; the installer can also use an existing account or open Cloudflare sign-in and registration.

Install the current 0.2 prerelease from the `next` channel:

```sh
npx dsh-edge@next install
```

Use `npx dsh-edge@latest install` for the stable channel, which remains on 0.1.3 until 0.2 is promoted.

The installer asks you to:

1. Choose **Free — Direct Shell** or **Isolated — Dynamic Worker**.
2. Select or create a Cloudflare account and choose a Worker name.
3. Generate a high-entropy owner access key or enter your own randomly generated value, then enter your DeepSeek API key through hidden input.
4. Confirm the cost summary and upload.

After Cloudflare accepts the upload, the installer waits briefly for the exact package and runtime to appear on the public URL. A ready result can be opened immediately. If Cloudflare is still activating the `workers.dev` route when the bounded wait ends, installation still succeeds and the final card tells you to wait a moment and refresh instead of mistaking the platform placeholder for a failed deployment.

Open the printed Worker URL and sign in with the owner access key. Save the key for future upgrades: rotating it invalidates existing browser sessions, and Cloudflare does not expose the current secret to a later upgrade.

A temporary Cloudflare account must be claimed through the printed claim URL within 60 minutes to retain the Worker and its data.

## Choose a runtime

| Mode | Cloudflare plan | Command runtime | Use it when |
| --- | --- | --- | --- |
| **Free — Direct Shell** | Workers Free | Hardened just-bash in the owner Durable Object | You want the lowest-friction personal deployment and trust the single owner. |
| **Isolated — Dynamic Worker** | Workers Paid | Cloudflare Computer Worker Shell through a Worker Loader binding | You want command execution in a separate Worker and accept the paid-plan requirement. |

Both modes use the same Web UI, DSH protocol, tools, Durable Object storage, and installer. The selected deployment configuration includes only its command runtime, so isolated deployments do not also load the direct shell implementation.

Direct mode is not a Linux container. It does not provide native binaries, background processes, PTYs, arbitrary Linux behavior, or shell networking. Do not expose a direct-mode instance to untrusted users.

## Upgrade

Run the upgrade command for the same release channel, choose the same runtime, and enter the existing Worker name. A 0.2 prerelease deployment follows `next`:

```sh
npx dsh-edge@next upgrade
```

Stable deployments use `npx dsh-edge@latest upgrade`. The Edge settings page detects the installed channel and copies the matching command.

Durable Object data is retained. The installer asks for the owner access key and DeepSeek API key again because Cloudflare secrets can be replaced but not read back.

## Current scope

`dsh-edge` is a developer preview. The current preview focuses on a complete personal-use path: upstream conversations and workspaces, persistent sessions, model selection, Web Search, workspace file operations, command execution, and the upstream browser experience.

The deployment is deliberately single-owner. It does not provide registration, multiple users, roles, or tenant routing. Attachments and images, remote MCP, Skills, Workflows, Jobs, and Subagents are not yet adapted to the Edge runtime. `web_fetch` remains disabled until the runtime has an explicit policy for SSRF, private addresses, and redirects.

See the [dsh-edge runtime reference](apps/dsh-edge/README.md) for the full compatibility matrix, limits, security behavior, API reference, local development commands, and current implementation status.

## Data and credentials

- Conversations, workspace metadata, and `/workspace` files live in the deployment's Durable Object storage.
- `DEEPSEEK_API_KEY` and `DSH_EDGE_ACCESS_KEY` are Cloudflare Worker secrets. Their literal values are not written to session events, Durable Object state, the virtual filesystem, or browser responses.
- The installer passes secrets to Wrangler through a temporary mode-`0600` file, removes it after the command, and does not bind the deployment to GitHub or Cloudflare Builds.
- The owner cookie is HttpOnly, `SameSite=Strict`, and valid for 30 days. Changing the owner access key invalidates it.

## Relationship to upstream

This repository is a standalone wrapper around exact published DeepSeek Harness packages. The upstream plugin composition, Web UI, agent loop, protocol, and persistence contracts remain the source of truth, but their monorepo source is not copied here. Edge runtime code lives under [`apps/dsh-edge`](apps/dsh-edge), while the Edge-owned [`packages/client/ui-edge`](packages/client/ui-edge) plugin contributes deployment status, upgrade guidance, and owner-session controls through upstream client slots.

The isolated assembly under `apps/dsh-edge/standalone` pins one upstream version and records every unavoidable package patch. An upstream-defined schema or service contract remains unchanged unless the Edge environment makes that impossible.

For upstream architecture and plugin development, use the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and [reference documentation](https://deepseek-harness.github.io/deepseek-harness/reference/).

Development history before the standalone repository cutover, including PR reviews and the 0.1.3 GitHub Release, remains available in the archived [dsh-edge-history repository](https://github.com/pawaca/dsh-edge-history).

## Run

Use a source checkout only for dsh-edge development. These commands are not required for the guided Cloudflare installation. The repository toolchain requires Node.js `^22.19.0` or `>=24.0.0`, which is stricter than the packaged installer's Node.js requirement.

Install the repository checks and the isolated release assembly separately:

```sh
git clone https://github.com/pawaca/dsh-edge.git
cd dsh-edge
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
```

### Run dsh-edge locally

Complete the [local Edge setup](apps/dsh-edge/README.md#run-locally), including its ignored `.dev.vars` file with an owner access key and DeepSeek API key. Then start the Cloudflare Worker development server:

```sh
pnpm --filter dsh-edge dev
```

## Contributing and support

- Report dsh-edge bugs and installation problems in this repository's [Issues](https://github.com/pawaca/dsh-edge/issues).
- Report vulnerabilities through the [private security process](SECURITY.md), not a public Issue.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for repository changes.
- Agents working in the repository must follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
