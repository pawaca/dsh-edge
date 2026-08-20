# Agent Note: dsh-edge independent package attribution

Status: implemented

[English](2026-08-18-dsh-edge-independent-package-attribution.md) | 中文

## Problem

`dsh-edge` npm 包曾逐字复制仓库根目录的 `LICENSE`，因此其主许可证声明把独立维护的 Edge 适配归为 DeepSeek 版权所有。但如果直接删掉该声明，又会产生相反的错误：包中包含并改造了 DeepSeek Harness 代码和组装后的 Web 资源，必须保留上游条款。

## Decision

`apps/dsh-edge/LICENSE` 是 pawaca 为独立创作的 Edge 适配所作的 MIT 声明。包 README 双语文档与生成的第三方声明明确指出：`dsh-edge` 是独立社区项目，与 DeepSeek 没有隶属关系，也未获得其官方背书。

`apps/dsh-edge/scripts/legal-files.mjs` 根据仓库根目录的法律文件生成包许可证与声明。生成的声明完整复现上游 DeepSeek Harness 的 MIT 声明及其依赖清单，而包许可证只替换版权所有者。pre-commit 的 notices 任务会重新生成两份文件，`prepack` 会拒绝陈旧产物，安装包 smoke 则会拒绝归 DeepSeek 所有的包许可证或缺失的上游归属。

仓库根目录的 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 继续作为不作修改的上游权威文件。Fork 特有的归属内容只放在 `apps/dsh-edge/` 下，从而限制同步上游无关文件时的冲突。

[公开 Edge 安装器记录](../architecture/2026-08-18-public-edge-installer.md)负责 npm artifact 的内容与发布路径。本记录只负责该 artifact 内的归属边界，以及法律文件的生成与校验。

## Alternatives considered

**继续复制根许可证。**这样能保留上游文本，却会错误地把 Edge 包呈现为 DeepSeek 所有，并让 npm 产物看起来像官方发布。

**替换所有 DeepSeek 声明。**这样能澄清 fork 的所有权，却会丢失 MIT 上游分发要求副本保留的版权与许可声明。

**手工维护独立法律文件。**这样不需要生成器集成，但依赖披露与上游许可证可能在没有发布检查报错的情况下偏离源码分发版本。

## Consequences

发布包在保留 DeepSeek Harness 归属和条款的同时具有明确的独立身份。声明文件会有意重复上游依赖清单，因此比针对单个包重新筛选的清单更大；从根权威文件生成它，是以完整且受新鲜度检查的披露为先，避免再维护一套依赖分类器。
