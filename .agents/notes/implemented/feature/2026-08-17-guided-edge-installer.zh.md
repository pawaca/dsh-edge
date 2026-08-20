# Agent Note: 通过一条引导式命令安装 dsh-edge

Status: implemented

[English](2026-08-17-guided-edge-installer.md) | 中文

上传后的成功边界由[不在 CLI 探测 Edge 部署，直接完成交接](../simplification/2026-08-18-edge-install-handoff-without-probing.md)进一步明确。

## 问题

一个个人 `dsh-edge` 实例需要一个 Worker、两项 secret、两种运行时配置之一、一项 Cloudflare 账户选择，以及安全交接已部署 target 与访问详情。把这些事项拆成多段 dashboard 与 Wrangler 操作，会让 Free 与 isolated 安装逐渐分化，也可能把 secret 留在 shell history 中，并让 Cloudflare Builds 与绑定的源码仓库看起来像产品依赖，尽管运行时并不使用它们。

Free 运行时还可以使用 Wrangler 的临时 preview account。如果强制用户先注册账户再试用产品，就会失去这项优势；但 Worker Loader 配置不支持该资源，因此也不能向它提供临时账户。

## 决策

平台说明：下文的 `0600` mode 保证适用于 POSIX 主机。Windows 上 Node 暴露的是合成 POSIX mode bit，而不是继承的 NTFS ACL，因此每次安装的文件会改为继承当前用户临时目录的 ACL。两个平台都会在报告成功前删除 credential 文件、私有配置及其所在的临时工作目录。

`dsh-edge install` 是面向用户的操作，源码 checkout 则以 `install:cloudflare` 作为入口。它会先选择运行时。`Free — Direct Shell` 接受临时账户、检测到的账户，或通过浏览器登录和注册。`Isolated — Dynamic Worker` 不提供临时账户，并明确说明它需要 Workers Paid；该订阅不同于 Cloudflare Pro 网站套餐。Wrangler 没有提供可靠的 Worker Loader entitlement 预检查询，因此由 Cloudflare 最终判断账户是否具备该权限。

随后，安装器会选择确切的 Worker 名称，并检查已有部署。只有用户明确选择更新后，它才会复用已有名称。从 Wrangler 解析出的账户 metadata 必须非空且不包含 C0、DEL 或 C1 终端控制字符，才能进入 prompt label、option value 或子进程环境。安装器默认生成随机 owner access key，也接受满足运行时字节约定的隐藏自定义输入，并通过隐藏输入收集 DeepSeek key。上传前的确认会汇总运行时、账户、Worker 名称与费用。临时路径还会单独展示 Cloudflare 服务条款与隐私政策，并要求明确接受。

Wrangler 通过权限模式为 `0600` 的私有临时 secret 文件接收两项 credential。每个 Wrangler 子进程只会收到 allowlist 内的操作系统、terminal、locale、proxy 与 certificate 变量，并只补回当前命令选中的 Cloudflare authentication input；其他 ambient credential 与 Node 注入选项会被排除。临时安装还会移除 Cloudflare credential 与配置来源，并使用隔离的 Wrangler 配置目录，防止现有本地登录接管这次部署。Wrangler 的结构化输出提供公开 Worker 目标与 release metadata；捕获的诊断内容与 metadata 文件都会在解析前限制为 2 MiB 有效 UTF-8。交互式 authentication 输出保持可见；除非用户选择 `--verbose`，部署输出会被捕获并收敛到一个进度提示。Interactive stdout 与 stderr 在转发前分别通过 chunk-safe terminal filter：只保留普通文本、tab、newline 与 carriage return，所有 SGR/ANSI sequence、C0/C1 控制字符、Unicode 双向文本控制字符、OSC string、cursor command 与其他 escape sequence 都会被移除。Account label、identifier、email metadata、claim URL 与会显示的 owner access key 也会拒绝同一类终端欺骗控制字符。当输出目标较慢时，对应子进程 stream 会暂停并等待 `drain`；同步 write 失败、异步 `EPIPE` 或输出目标提前关闭时，安装器会终止并 join Wrangler 进程树，然后通过正常的 credential cleanup 路径报错。同一个受控输出边界会一直覆盖 Clack prompt、恢复卡片与最终状态，直到私有目录 cleanup 完成。它会跟踪异步 write 及输出目标提前 close 或 error；信号中断会直接销毁已阻塞的 stdout destination，而不只是释放 wrapper callback，随后通过另一条受控 stream 输出上传后的恢复信息。对于交互式认证等非部署命令，即使 Wrangler 以 status 0 退出，output failure 也会导致失败；只有部署会为 credential recovery 保留这两个并存结果。捕获的诊断文本在进入 installer error 前也会通过同一套纯文本过滤。被拒绝的上传会报告为未安装；临时账户 claim URL 仍可恢复，但未使用的 owner key 不会被呈现为 active。安装器不会请求所得 target；它只接受结构化输出中无 credential、位于 `*.workers.dev` 下的 HTTPS root origin，再把该 URL 与 owner key 交给用户。无论成功、失败还是进程被中断，安装器都会先删除临时文件，再输出成功，并在 await cleanup 边界之后重新检查中断。如果最终目录清理在成功上传后失败，安装器会输出恢复信息并失败，而不会先宣告成功；如果清理失败发生在另一个错误或中断之后，它会单独警告，同时保留主要错误与退出语义。如果 Wrangler 已经上传 Worker，但 credential cleanup、output forwarding、结构化输出解析、claim 校验或中断导致安装无法报告成功，恢复卡片会在命令按原失败退出前输出已经生效的 owner key 与当时已知的 URL。当其中一条输出 stream 导致失败时，该卡片会绕过 Clack，并通过另一条受控输出边界排队写入。只有底层 destination 的异步 write callback 成功后才会记录为已送达；发生 output failure 后，仍可用的 stream 会获得一个有上限的 drain 窗口，届时仍阻塞的 write 会被取消。如果备用 stream 也失败，该错误会被隔离，以便目录 cleanup 继续执行。Wrangler exit status、output failure 与并发 abort state 会独立保留，因此 status 0 close 仍会先进入这条恢复路径，再报告中断或 output failure。SIGHUP、SIGINT 与 SIGTERM 会取消尚未完成的 prompt，或通过 Execa managed descendant-tree spawn 终止 Wrangler，并分别保留退出状态 129、130 与 143：POSIX 使用隔离的 process group、SIGTERM 到 SIGKILL escalation 与明确的 group-liveness join；Windows 等待 `taskkill /T /F`。只有整棵进程树静止后才会开始 cleanup。临时安装还要求 Wrangler 返回 bearer claim URL，并将该 URL 与 60 分钟保留期限一起输出。

发布打包会从经过测试的 workspace 源码构建 direct 与 isolated Worker artifact。npm package 把 Harness、Computer 与 just-bash package 作为构建时依赖；安装器会选择一个已发布 artifact，并通过 Wrangler `no_bundle` 上传，因此 npm 用户不会意外地从单独发布的上游 package 重新构建 Worker。安装会直接从准备好的包或 checkout 上传，不会创建或绑定 GitHub 仓库、Cloudflare Builds 项目或源码构建流水线。

## 考虑过的替代方案

- **把 Cloudflare Builds 作为主要设置方式：** 自动 build 对贡献者有用，但绑定仓库与配置 build variable 和运行一个个人实例无关。
- **为每种运行时提供一条命令：** 这会降低模式选择的可见性，也会让两个入口的账户、secret 与交接行为逐渐分化。
- **强制登录 Cloudflare：** 这样可以简化认证处理，但会失去 Free 运行时的临时账户试用路径。
- **通过命令参数或继承的环境变量传递 secret：** 两种方式都可能通过进程检查、shell history、诊断信息或非预期 credential source 泄露 secret。
- **上传前推断 Workers Paid：** Wrangler account metadata 无法证明 Worker Loader entitlement，因此本地猜测会拒绝有效账户，或承诺最终仍会被 Cloudflare 拒绝的上传。

## 后果

- 用户会先做出费用与隔离选择，再选择 Cloudflare 账户。临时安装只属于 Free 路径；isolated 安装失败时，会提供可操作的 Workers Paid 或 direct 模式选择。
- 明确更新已有 Worker 时，其 Durable Object 数据会保留。使用不同 Worker 名称可隔离 direct 与 isolated 模式，无需复制应用代码或配置所有权。
- DeepSeek key 与两项 secret value 都不会出现在命令参数或进度输出中。安装成功后会输出 owner key；若上传已生效但交接无法完成，也会在恢复卡片中输出它，避免用户失去访问权限。DeepSeek key 永远不会回显。
- 安装器成功表示 Wrangler 接受了上传并提供一个通过准入的 `workers.dev` target。Runtime health 作为显式诊断保留，而不是安装前置条件。
- 安装不依赖源码托管，也不要求用户侧构建应用。发布过程会生成可部署的 Worker artifact；安装约定仍是 `dsh-edge install` 和直接通过 Wrangler 上传。

## 验证

单元测试覆盖通过 package-bin symlink 启动、按运行时区分的账户选择、包括 C1 与双向文本控制字符在内的已认证且终端安全 Wrangler account parsing、Worker 名称与 secret 校验、子进程环境 allowlist、不含 secret 的命令、按 UTF-8 字节限制的诊断输出与 metadata 捕获、安静与 verbose 的部署输出、跨 chunk 的 interactive terminal filtering、output backpressure、受控的输出目标失败、保持打开但不再读取的 pipe cancellation、备用 stream 紧急恢复、status-0 authentication output failure、终端安全的结构化 target 与 claim URL parsing（包括拒绝非 `workers.dev` origin）、精确的 Worker 不存在分类、登录、取消已有名称、明确接受临时账户条款、临时账户隔离与清理、被拒绝上传的 claim 恢复、中断 prompt、真实 descendant process 的终止与 join、部署 cleanup、成功、主要失败与中断三种情况下的最终 cleanup 失败行为、最终 cleanup 期间的中断、包括 credential cleanup、successful-close interruption race 与 successful-close output-failure race 在内的上传后 owner key 恢复，以及 paid-plan recovery guidance。Keyless runnable example 会通过 PTY 驱动实际交付的 symlinked bin 与真实 Clack prompt，启动独立的 Wrangler fixture 进程、消费其结构化输出，并在不请求公开 Worker 的情况下完成真实交接。对应 snapshot 会记录完整的临时 Free 交互、隐藏 secret 输入、费用与条款确认、已 scrub 的子进程环境、通过准入的 target、认领期限、下一步与最终 credential。CI 会构建两种 release artifact、强制 Direct 压缩体积预算、在 workspace 外安装打包后的 npm tarball，并通过本地 Workers runtime 启动其中的 Direct artifact。
