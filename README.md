![dsh-edge — Your DeepSeek Harness, anywhere. Deploy to Cloudflare in one command.](docs/assets/dsh-edge-hero.jpg)

[![npm](https://img.shields.io/npm/v/dsh-edge)](https://www.npmjs.com/package/dsh-edge)
[![CI](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml/badge.svg)](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml)
[![License: MIT](https://img.shields.io/github/license/pawaca/dsh-edge)](LICENSE)

English | [中文](README.zh.md)

`dsh-edge` runs the published DeepSeek Harness Web experience on Cloudflare Workers, so your personal coding agent is available wherever you have a browser. No server to maintain, GitHub repository to connect, or build pipeline to configure.

It keeps the upstream UI, agent loop, model selection, and Web Search, while adding goal tracking, file operations, context compaction, runtime-configurable settings, and persistent multi-workspace management — all on Cloudflare Workers.

> **Independent community project:** `dsh-edge` is maintained by [pawaca](https://github.com/pawaca). It is not affiliated with or endorsed by DeepSeek. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream project.

## Start in one command

You need Node.js 22.14 or newer and your own DeepSeek API key:

```sh
npx dsh-edge install
```

The installer guides you through every choice and deploys the Worker. You can try it without an existing Cloudflare login, or install it permanently in your own Cloudflare account. No source checkout is required.

[![Install dsh-edge, unlock the deployment, select Vision Exp, and analyze an image](docs/assets/dsh-edge-demo.gif)](docs/assets/dsh-edge-demo.mp4)

## What you get

- **Agent capabilities** — goal tracking with GoalBar UI, file tools (read, write, edit, read_image), context compaction for long conversations, and automatic session titles.
- **Workspaces** — multiple persistent workspaces with create, rename, archive, and reorder; a `/workspace` filesystem backed by Durable Object SQLite; and a bash tool with configurable timeouts.
- **Models** — DeepSeek V4 Flash, V4 Pro, and Vision Exp through the upstream selector; runtime-configurable settings (model, API key, reasoning effort) without redeployment; Web Search and PNG/JPEG image input.
- **Conversations** — session fork to branch conversations, queue/steer message editing, persistent history from any browser.
- **Deployment** — your own Cloudflare Worker, credentials, and data; in-place upgrades without a repository or build pipeline.

## Choose your deployment

| Path | What you need | Best for |
| --- | --- | --- |
| **Try now** | No existing Cloudflare login; claim within 60 minutes to keep it | Exploring the complete experience with the lowest friction |
| **Keep it** | An existing or new Cloudflare account with R2 enabled | A long-lived personal deployment |

The default **Free — Direct Shell** runtime works on Cloudflare Workers Free. The optional **Isolated — Dynamic Worker** runtime executes commands in a separate Worker and requires Workers Paid. Both modes use the same product UI, conversations, workspace, images, and tools; Direct Shell is a sandboxed shell runtime, not a Linux container.

## Upgrade

```sh
npx dsh-edge upgrade
```

The installer finds your Worker and upgrades it in place while preserving its durable data. See the [release notes](docs/releases/) for version-specific details.

## Important boundaries

- dsh-edge is designed for one owner; it does not provide registration, multiple users, roles, or tenant routing.
- Your DeepSeek key is stored as a secret in your Cloudflare Worker, and the deployment's durable data stays in your Cloudflare account.
- Some upstream capabilities (MCP, subprocess, PTY) require Cloudflare Containers and are not yet adapted. Vision Exp is experimental and account-dependent. See the [compatibility matrix](apps/dsh-edge/README.md#cloudflare-compatibility-matrix) and the [wiki](https://github.com/pawaca/dsh-edge/wiki) for the full status.

## Built on DeepSeek Harness

dsh-edge wraps exact published DeepSeek Harness packages instead of copying its monorepo. Upstream remains responsible for the Web UI, plugin composition, agent loop, and session protocols; this repository implements the Cloudflare runtime and storage adapters needed to run them at the edge.

For the upstream architecture and plugin APIs, see the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and [reference documentation](https://deepseek-harness.github.io/deepseek-harness/reference/).

## Documentation

- [Architecture and subsystem wiki](https://github.com/pawaca/dsh-edge/wiki)
- [Runtime reference, compatibility, security, and limits](apps/dsh-edge/README.md)
- [Release notes](docs/releases/)
- [DeepSeek Harness upstream documentation](https://deepseek-harness.github.io/deepseek-harness/reference/)

## Develop locally

Source checkout is only required for development. The repository toolchain requires Node.js `^22.19.0` or `>=24.0.0`:

```sh
git clone https://github.com/pawaca/dsh-edge.git
cd dsh-edge
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
```

See the [local Edge setup](apps/dsh-edge/README.md#run-locally) to run the Worker locally.

## Contributing and support

- Report dsh-edge bugs and installation problems in [Issues](https://github.com/pawaca/dsh-edge/issues).
- Report vulnerabilities through the [private security process](SECURITY.md), not a public Issue.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) when changing the repository.

## License

[MIT](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
