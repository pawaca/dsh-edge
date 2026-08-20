# Security Policy

English | [中文](SECURITY.zh.md)

## Supported versions

Security fixes target the version currently published on npm under `latest`. An actively tested prerelease published under `next` may also receive fixes, but prerelease users should upgrade when a replacement is published. Older versions are unsupported unless a security advisory says otherwise.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/pawaca/dsh-edge/security/advisories/new) for vulnerabilities in dsh-edge. Do not include exploit details, credentials, owner access keys, DeepSeek API keys, cookies, Worker secrets, or private deployment URLs in a public Issue or Discussion.

Include the affected dsh-edge version and runtime mode, the security impact, minimal reproduction steps, and sanitized diagnostics when available. Reports are handled on a best-effort basis; the maintainer will confirm the affected surface before coordinating a fix and disclosure.

Report vulnerabilities in Cloudflare, DeepSeek Harness, the DeepSeek API, or another upstream dependency to that project's security channel unless dsh-edge introduces the vulnerable behavior.

## Security scope

The single-owner authentication boundary, credential handling, Durable Object and VFS isolation, installer secret transport, Worker HTTP/WebSocket routes, Direct and Dynamic Loader command runtimes, and published npm artifact are in scope. Direct mode is intentionally not a Linux container and must not be exposed to untrusted users.
