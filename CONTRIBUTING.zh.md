# 参与贡献

[English](CONTRIBUTING.md) | 中文

欢迎为 `dsh-edge` 贡献代码。本项目由 pawaca 独立维护，是社区项目，并非 DeepSeek 官方仓库。

提交 Pull Request 前：

1. 阅读 [`AGENTS.md`](AGENTS.md)，了解所有权边界与兼容规则。
2. 把修改限制在 Edge wrapper 内；通用 Harness 改进应提交到上游，不要复制上游源码。
3. 同步更新中英文文档。
4. 运行 `pnpm run check`，并根据修改范围执行 standalone、integration、snapshot 或 package 的针对性检查。
5. 在 Pull Request 中说明用户影响、验证证据和任何保留的上游 patch。

安全敏感问题请私下联系维护者，不要在公开 Issue 中包含 secret 或可直接利用的细节。
