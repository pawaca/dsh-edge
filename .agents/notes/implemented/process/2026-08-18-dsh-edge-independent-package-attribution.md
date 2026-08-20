# Agent Note: dsh-edge independent package attribution

Status: implemented

English | [中文](2026-08-18-dsh-edge-independent-package-attribution.zh.md)

## Problem

The `dsh-edge` npm package copied the repository-root `LICENSE` byte for byte, so its primary license notice assigned the independently maintained Edge adaptation to DeepSeek. Replacing that notice without carrying the upstream terms would create the opposite error because the package includes and adapts DeepSeek Harness code and assembled Web assets.

## Decision

`apps/dsh-edge/LICENSE` is pawaca's MIT notice for the independently authored Edge adaptation. The package README pair and generated third-party notices identify `dsh-edge` as an independent community project that is not affiliated with or endorsed by DeepSeek.

`apps/dsh-edge/scripts/legal-files.mjs` derives the package license and notices from the repository-root legal authorities. The generated notices reproduce the complete upstream DeepSeek Harness MIT notice and its dependency inventory, while the package license changes only the copyright holder. The pre-commit notices job regenerates both authorities, `prepack` rejects stale output, and the installed-package smoke rejects either a DeepSeek-owned package license or missing upstream attribution.

The repository-root `LICENSE` and `THIRD_PARTY_NOTICES.md` remain the unchanged upstream authorities. Fork-specific attribution stays under `apps/dsh-edge/`, limiting conflicts when upstream changes unrelated project files.

The [public Edge installer note](../architecture/2026-08-18-public-edge-installer.md) owns the npm artifact contents and release path. This note owns only the attribution boundary and the derivation and validation of the legal files within that artifact.

## Alternatives considered

**Keep copying the root license.** This preserves the upstream text but falsely presents the Edge package as DeepSeek-owned and makes the npm artifact look official.

**Replace every DeepSeek notice.** This clarifies the fork's ownership but discards the copyright and permission notice that the MIT-licensed upstream distribution requires copies to retain.

**Maintain independent legal files by hand.** This avoids generator integration but lets dependency disclosures and the upstream license drift from the source distribution without a failing release check.

## Consequences

The published package has an unambiguous independent identity while retaining DeepSeek Harness attribution and terms. Its notice file intentionally repeats the upstream dependency inventory and therefore remains larger than a package-specific dependency list; deriving it from the root authority favors complete, freshness-checked disclosure over a second dependency classifier.
