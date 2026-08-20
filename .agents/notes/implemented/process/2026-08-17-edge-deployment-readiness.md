# Agent Note: Verify Edge deployment readiness

Status: implemented

English | [中文](2026-08-17-edge-deployment-readiness.zh.md)

The installer-polling portion of this decision is superseded by [handing off Edge installs without CLI probing](../simplification/2026-08-18-edge-install-handoff-without-probing.md). This record remains active for the rationale behind the public health endpoint, release identifier, and configuration validation.

## Problem

A successful Cloudflare build and Wrangler upload prove that an artifact reached the platform, but not that the active Worker version has usable runtime configuration. A deployment can therefore appear successful while its public routes return an error or its first model turn rejects an invalid model, credential, or timeout choice.

## Decision

Release packaging compiles a public `dsh-edge@<version>/<mode>` identifier into each tested Worker artifact. The `dsh-edge install` command uploads that artifact without rebuilding it, obtains the public HTTPS origin from Wrangler's structured deployment output, and hands that admitted target to the owner without requesting it. The superseded installer design instead generated an identifier per invocation, then polled `/api/health` for at most 60 seconds, bounded each request to 5 seconds, waited 2 seconds between attempts, and failed the installation unless the endpoint returned that exact identifier with the complete Edge runtime identity and `status: ready`. That polling client and its tests no longer ship.

The entry Worker resolves the owner access key before routing health. The health implementation then uses the same deployment resolver as model-turn admission to require a deployment-scoped `DEEPSEEK_API_KEY` and validate the DeepSeek chat and search base URLs, model, output limit, reasoning policy, stream timeout, and Computer command-timeout policy. Model and search operations resolve the Worker secret per operation through the upstream credential service; public requests cannot override it.

Health validation is intentionally local. It does not call DeepSeek, instantiate the owner Durable Object, mutate the VFS, or execute the shell. The release identifier is not a secret or durable record; it identifies the published package version and runtime mode, but not one installation of that release. Provider availability and stateful runtime behavior remain the responsibility of integration tests and explicit production smoke tests.

## Alternatives considered

These alternatives record the rationale for the original readiness gate. The later handoff decision supersedes their conclusions about installation success, while the independent health diagnostic remains.

**Trust the Cloudflare build result:** this would leave versioned Worker secrets and invalid runtime choices outside the success condition that operators see.

**Run an authenticated model and shell turn after every deploy:** this would mutate owner state, spend provider quota, and turn external availability into a deployment prerequisite. The public health check verifies configuration without those side effects.

**Derive the public URL from Wrangler console text:** human-readable console text is not a stable interface. The installer instead consumes Wrangler's versioned structured-output event and requires a public `workers.dev` target produced by that upload.

**Trust Wrangler completion or a constant health payload to identify the active artifact:** rollout propagation or a misdirected public URL can still reach an older healthy Worker. Matching an identifier compiled into the uploaded artifact gave the superseded verifier direct, version-specific evidence instead of treating upload completion alone as readiness evidence.

## Consequences

- Installation requires no public-origin build variable or source-build binding; Wrangler's structured output is the target source of truth.
- A missing default DeepSeek credential or any invalid deployment choice prevents the public health endpoint from reporting ready and blocks the same configuration at model-turn admission.
- The release identifier lets an explicit health query distinguish package versions and runtime modes; it does not distinguish two installations of the same release, and the installer does not perform the query.
- Installation handoff completes from Wrangler's admitted structured target without waiting for public readiness.
- The check is side-effect free and does not prove provider reachability or Durable Object, VFS, and shell behavior.
- Unit tests pin structured `workers.dev` target admission, build-time package-and-mode identifier propagation, health runtime-mode reporting, complete configuration resolution, invalid choices, and deployment-secret admission. Edge CI starts the Direct artifact from an installed npm tarball. No automated installer polling or release matching remains; explicit production smoke tests retain the broader runtime responsibilities.
