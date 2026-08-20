# dsh-edge-client-ui

English | [中文](README.zh.md)

Private Edge-only Web settings plugin for a `dsh-edge` deployment. It is maintained by the independent `pawaca/dsh-edge` wrapper and is not an official `@deepseek-ai` package. It contributes one standard `settings.section` page through the upstream client runtime and slot contract. The page lazily reads the deployment's `/api/health` projection, then shows the installed Edge release, the latest public npm release when the registry is reachable, the DeepSeek Harness base version, runtime mode, storage backend, deployment identity, and the current owner's sign-out action. When a newer release exists, it provides the public installer's copyable upgrade command.

The browser performs no deployment mutation and receives no Cloudflare credentials. Signing out clears the browser cookie without changing the Worker or Durable Object data. The owner-session control remains available when deployment health cannot be loaded, so a broken runtime configuration never traps the browser session.

This is a regular browser plugin but a deployment-specific composition member. The pinned assembler at `apps/dsh-edge/standalone/scripts/assemble-standalone-web.mjs` selects it beside the upstream Web roster; the generic upstream Web bundle does not include it.

## Model Experience

### Edge deployment settings

#### What the model sees

Nothing. This browser-only `settings.section` package renders deployment metadata and owner-session controls without registering a model-visible tool, prompt, or message.

#### Token effect

None. The settings page does not add or modify provider-request tokens.

#### KV Cache effect

None. This package never changes a provider request.

## Known Limitations and Deferred Work

- The public registry lookup fails soft; an unavailable registry suppresses release comparison and upgrade guidance without hiding deployment health or owner controls.
- Upgrade execution stays in the CLI; the browser never receives Cloudflare credentials.
