# Agent Note: 在 Edge runtime 中运行上游 DeepSeek Web Search

Status: implemented

[English](2026-08-18-edge-deepseek-web-search.md) | 中文

## Problem

Edge runtime 已暴露上游 agent loop 与 Web client，但模型只能使用本地 bash tool。因此，即使上游已经定义 Web capability、DeepSeek native search provider、面向模型的 tool、持久化 request event 与结构化 result presentation，用户仍无法询问时效信息。单独实现 Edge provider 会重复这些行为，并产生另一条需要保护的 credential path。

## Decision

Durable Object 会挂载上游 `@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-web-search-deepseek`、`@deepseek-ai/dsh-tool-call-timeout-policy` 与 `@deepseek-ai/dsh-tool-web` composition。只启用 `web_search`；在 Edge 拥有覆盖 SSRF、私网目标、redirect 与 response bound 的 arbitrary-URL network policy 之前，`web_fetch` 保持禁用。Timeout policy 会通过 abort signal 强制执行该 tool 上游定义的 30 秒 cooperative budget，未经修改的上游 Web client 会渲染该 tool 的结构化 result metadata。

Chat 与 search 都通过只读 Edge `ctx.credentials` provider 为每次操作解析 `DEEPSEEK_API_KEY`。Provider 会移除首尾空白，并把空白值视为未配置，与 deployment health 和 turn admission 保持一致。系统不存在 request header、plugin-specific secret 或 Durable Object 副本。Search 保留上游 model 与 request limit，并使用独立的 `DEEPSEEK_SEARCH_BASE_URL`；该变量默认为 DeepSeek Anthropic-compatible Messages endpoint。Edge 会在接纳 turn 或报告 health 前，验证该 endpoint 是不含 userinfo、query 与 fragment 的 HTTP(S) URL。

DeepSeek Search 使用 manual redirect handling，因为 Cloudflare Workers 会拒绝 Fetch 的 `redirect: "error"` 模式。3xx response 仍属于非成功响应，并进入 provider 现有 error path；真实 cross-origin redirect test 会证明携带 credential 的 request 从未访问 `Location` target。

## Alternatives considered

**实现 Edge 专用 search provider：**这会复制上游 request format、result mapping、event recording、error taxonomy、tool schema、prompt guidance 与 presentation metadata。复用上游 composition 可以让 Edge 继续只负责 runtime adaptation。

**把 Worker secret 直接传给 search plugin：**这会产生第二个 credential owner，也会让 rotation 无法通过标准 service 作用于下一次 operation。共享只读 provider 可以保留上游 credential semantics，同时不会让部署 secret 变为可写。

**随 search 一起启用 `web_fetch`：**不受限制的 URL retrieval 会在 Edge 拥有 destination 与 redirect control 之前扩大公开网络边界。Search 只访问一个已配置的 DeepSeek endpoint，是更适合首次上线的较小 capability。

**复用 `DEEPSEEK_BASE_URL`：**chat 与 native search 使用不同 protocol 和默认 path。独立变量遵循上游 provider contract，也允许分别配置兼容 gateway。

## Consequences

- 模型会获得上游 `web_search` guidance 与 tool metadata，实时或 replay turn 都会通过既有 Web result card 渲染。
- Search 会额外消耗一次 DeepSeek model request，并复用部署 API key，但不会持久化或暴露该 key。
- 即使 prompt 不会调用 search，health 与 turn admission 也会拒绝非法 search endpoint。
- Direct 与 isolated mode 共享同一 composition。Direct dry-run bundle 仍低于仓库 900 KiB compressed budget。
- Wrangler integration 与 model-visible snapshot 会覆盖完整的 chat → `web_search` → DeepSeek native search → structured tool result → final answer round，包括不含 secret 的持久 request event。
