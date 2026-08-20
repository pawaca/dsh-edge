# Agent Note: Add an Edge-owned settings plugin through upstream slots

Status: implemented

Repository-structure details in this note are superseded by the [standalone wrapper plan](../../proposed/architecture/2026-08-19-dsh-edge-standalone-wrapper.md). The Edge-owned client-plugin decision remains in force.

English | [中文](2026-08-18-edge-client-plugin.zh.md)

## Problem

The assembled upstream Web client exposes no place to identify the deployed `dsh-edge` build, distinguish the free and isolated runtimes, or end the owner session. Putting those controls into the upstream settings source would make every upstream sync carry an Edge-specific UI fork.

## Decision

Add `dsh-edge-client-ui` as a private standard client plugin owned by the `pawaca/dsh-edge` fork. The unscoped name, author, source repository, and exact release-family exclusion distinguish it from official `@deepseek-ai` packages while keeping the implementation on upstream plugin contracts. It uses the existing runtime, locale, `settings.section`, injected snapshot-store, and shared primitives contracts. The Edge assembler explicitly appends this package to its deployment roster; the upstream Web bundle patch remains unchanged, so the native deployment never sees the page.

The Worker reads the Edge package version and its recorded upstream base as build inputs and projects them through `/api/health`; `host.describe` uses the same Edge metadata. The page fetches health only when mounted, compares the installed version with the public npm latest endpoint, and offers the executable CLI upgrade command when a newer release exists. Registry failure does not hide deployment facts. The browser never receives Cloudflare credentials or performs a deployment mutation. Owner logout reuses the existing same-origin authentication route. The owner-session card is rendered independently of deployment health so configuration errors cannot remove the sign-out path. Controller transitions preserve the same ownership boundary: health, clipboard, and logout completion each change only their owned fields, regardless of completion order.

## Alternatives considered

- **Modify the upstream settings shell:** this would duplicate deployment policy in a generic product surface and make upstream synchronization harder.
- **Build an app-local React island:** this would bypass the standard client loader, slot lifetime, locale, and snapshot-store contracts.
- **Upgrade from the browser:** this would require Cloudflare credentials or a privileged deployment service in the Worker, expanding the security boundary for a convenience action.
- **Publish update guidance ahead of the installer:** a future command is not an executable user contract, even when development builds currently hide it.

## Consequences

- Edge-specific UI remains isolated to one package and one explicit assembler roster entry.
- The private plugin cannot enter the upstream npm release family, and its manifest does not claim the DeepSeek scope or source repository.
- Installed-version, upstream-base, runtime, storage, and deployment facts have one truthful Worker projection.
- The [public installer](2026-08-18-public-edge-installer.md) owns npm publication and the upgrade command advertised by this page.

## Verification

Controller tests cover lazy health loading, npm version comparison, clipboard guidance, concurrent-load ordering, interleaved health/logout completion, logout, and malformed health. The assembled Edge browser snapshot opens the real Settings shell, selects the DSH Edge page, and pins its accessible release, runtime, storage, deployment, and owner-session presentation.
