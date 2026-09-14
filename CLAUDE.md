# Claude Code instructions

Read and follow [`AGENTS.md`](AGENTS.md) before changing this repository. `AGENTS.md` is the single source of truth for architecture, testing, review, security, and release rules; this real file exists so Claude Code discovers that authority without duplicating it.

**Database cost reminder:** Before any database change or recovery operation, follow [Durable Object database budgets](AGENTS.md#durable-object-database-budgets). This includes migrations, deletion, retries, startup, and ordinary requests. DELETE also consumes the daily write allowance; SQL call counts and successful data checks do not establish quota safety.
