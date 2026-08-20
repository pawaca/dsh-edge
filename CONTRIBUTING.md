# Contributing

English | [中文](CONTRIBUTING.zh.md)

Contributions to `dsh-edge` are welcome. This is an independent community project maintained by pawaca, not an official DeepSeek repository.

Before opening a pull request:

1. Read [`AGENTS.md`](AGENTS.md) for the ownership boundary and compatibility rules.
2. Keep changes inside the Edge wrapper; propose general Harness improvements upstream instead of copying upstream source.
3. Update English and Chinese documentation together.
4. Run `pnpm run check` and the focused standalone, integration, snapshot, or package checks required by the changed surface.
5. Explain the user impact, validation, and any retained upstream patch in the pull request.

Report security-sensitive issues privately to the maintainer rather than including secrets or exploit details in a public issue.
