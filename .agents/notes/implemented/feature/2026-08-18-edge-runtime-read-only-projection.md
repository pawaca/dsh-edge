# Agent Note: Project the programmatic Edge runtime through upstream read-only surfaces

Status: implemented

English | [中文](2026-08-18-edge-runtime-read-only-projection.zh.md)

## Problem

The Edge agent graph is assembled programmatically inside the Durable Object rather than loaded from an `agent.cordis.yml`. The upstream Agent Presets page nevertheless lists the built-in `dsh-edge` preset and offers its standard View action. Leaving `agentPreset.read` unsupported turns that valid-looking action into an error. The server also knows the effective shell mode, release, model policy, and deployment credential state, but its credential descriptor reported every reference as unconfigured. Owners need an inspectable, truthful view without an Edge-specific Web UI or any path that returns a secret value.

## Decision

`resolveEdgeDeploymentProfile()` produces the secret-free deployment facts the authenticated owner may inspect: release id, direct or isolated shell, Durable Object VFS, model endpoint and policy, command limits, and whether the `DEEPSEEK_API_KEY` Worker binding is non-empty. The endpoint projection omits query and fragment components because gateway URLs may carry credentials there; the operational turn configuration retains the complete validated URL. The Edge `ApiProxy` resolves the profile only when the owner opens the preset viewer, while a separate value-free boolean supplies credential status. An invalid model configuration can therefore fail the model and viewer paths without preventing workspace or history access. Credential values are never copied into either projection.

`agentPreset.read` accepts only the built-in `dsh-edge` id and returns the existing upstream response shape. Its content is a deterministic YAML projection of the effective programmatic graph: upstream agent loop and session services, the actual system prompt, DeepSeek chat and search routes, workspace, bash and `web_search` tools, release, runtime mode, limits, and value-free credential state. A heading inside the content states that the projection is read-only and is not an editable `agent.cordis.yml`. The preset roster remains `authorable: false`, and all authoring methods remain unavailable.

The Edge credential provider exposes the `DEEPSEEK_API_KEY` Worker secret through the upstream `ctx.credentials` service. Both model consumers and `credentials.describe` use that service, so the browser reports a configured `worker-secret` with `writable: false` while unknown references remain unconfigured and read-only. Edge continues to return no settings namespaces and does not restore the writable Models settings bundle. The existing upstream Agent Presets viewer renders the projection unchanged, preserving the [Cloudflare runtime boundary](../architecture/2026-08-14-cloudflare-computer-runtime-poc.md) that keeps browser source upstream-owned.

## Alternatives considered

- **Hide Agent Presets or remove its View action:** the upstream bundle is already useful for showing the active preset, and hiding a truthful read capability would make the Edge runtime less inspectable.
- **Build an Edge-only runtime settings page:** this would fork presentation, localization, and interaction behavior that the upstream read-only viewer already supplies.
- **Invent an Edge settings namespace and restore the Models editor:** the effective Worker configuration is deployment-owned and read-only. Presenting it through an editor-shaped schema would imply writes that the server cannot honor and would create an Edge-private settings contract.
- **Present the projection as a mountable Cordis composition:** the Edge graph includes programmatic registrations and a native bash adapter that cannot be reconstructed from a normal preset file. The projection states this limitation instead of offering a misleading copy or edit path.

## Consequences

- The previously broken View interaction succeeds through the standard `agentPreset.read` protocol and unchanged upstream modal.
- Owners can inspect the effective direct/isolated mode, release, model policy, prompt, tool, and credential readiness in one place. The authenticated response can include a configured model endpoint but never an API key or owner access key.
- Deployment options have one typed, secret-free projection shared by health identity and the preset viewer. A new effective option must be deliberately added to that profile before it becomes inspectable.
- This remains an observation surface, not a settings system. Changing Worker variables, secrets, presets, or runtime composition still happens at deployment time.

## Verification

Focused deployment and Edge API tests pin profile resolution, unknown-preset rejection, credential redaction, and composition content. The Wrangler integration exercises `agentPreset.read` and `credentials.describe` through the upstream carrier. The assembled-browser snapshot opens Settings → Agent presets → View in the unchanged Web client, pins the effective composition, and proves the former unavailable-capability error is absent.
