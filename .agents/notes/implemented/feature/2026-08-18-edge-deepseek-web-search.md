# Agent Note: Run upstream DeepSeek Web Search in the Edge runtime

Status: implemented

English | [中文](2026-08-18-edge-deepseek-web-search.zh.md)

## Problem

The Edge runtime exposes the upstream agent loop and Web client, but its model can only use the local bash tool. Users therefore cannot ask current-information questions even though upstream already defines the Web capability, DeepSeek native search provider, model-facing tool, durable request event, and structured result presentation. A separate Edge provider would duplicate that behavior and create another credential path to secure.

## Decision

The Durable Object mounts the upstream `@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-web-search-deepseek`, `@deepseek-ai/dsh-tool-call-timeout-policy`, and `@deepseek-ai/dsh-tool-web` composition. Only `web_search` is enabled; `web_fetch` remains disabled until Edge has an arbitrary-URL network policy that covers SSRF, private destinations, redirects, and response bounds. The timeout policy enforces the tool's upstream 30-second cooperative budget through its abort signal, and the unchanged upstream Web client renders the tool's structured result metadata.

Chat and search both resolve `DEEPSEEK_API_KEY` per operation through the read-only Edge `ctx.credentials` provider. The provider trims surrounding whitespace and treats a blank value as unconfigured, matching deployment health and turn admission. No request header, plugin-specific secret, or Durable Object copy exists. Search keeps its upstream model and request limits and uses the independent `DEEPSEEK_SEARCH_BASE_URL`, which defaults to DeepSeek's Anthropic-compatible Messages endpoint. Edge validates that endpoint as HTTP(S) without userinfo, query, or fragment before admitting a turn or reporting health.

DeepSeek Search uses manual redirect handling because Cloudflare Workers rejects Fetch's `redirect: "error"` mode. A 3xx response remains non-success and enters the provider's existing error path, while the real cross-origin redirect test proves that the credential-bearing request never contacts the `Location` target.

## Alternatives considered

**Implement an Edge-only search provider:** this would copy upstream request formats, result mapping, event recording, error taxonomy, tool schema, prompt guidance, and presentation metadata. Reusing the upstream composition keeps Edge limited to runtime adaptation.

**Pass the Worker secret directly to the search plugin:** this would create a second credential owner and prevent rotation from reaching the next operation through the standard service. The shared read-only provider preserves upstream credential semantics without making deployment secrets writable.

**Enable `web_fetch` with search:** unrestricted URL retrieval would expand the public network boundary before Edge has destination and redirect controls. Search contacts one configured DeepSeek endpoint and is a smaller launch-safe capability.

**Reuse `DEEPSEEK_BASE_URL`:** chat and native search use different protocols and default paths. A separate variable follows the upstream provider contract and permits independent compatible gateways.

## Consequences

- The model receives upstream `web_search` guidance and tool metadata, and live or replayed turns render through the existing Web result card.
- Search consumes another DeepSeek model request and reuses the deployment's API key without persisting or exposing it.
- Health and turn admission reject an invalid search endpoint even when a prompt would not call search.
- Direct and isolated modes share the same composition. The Direct dry-run bundle remains below the repository's 900 KiB compressed budget.
- Wrangler integration and the model-visible snapshot cover a complete chat → `web_search` → DeepSeek native search → structured tool result → final answer round, including the secret-free durable request event.
