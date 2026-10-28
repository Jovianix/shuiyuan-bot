# 水源 Pet

一个以 DSH Web 为运行核心、通过 Discourse MCP 参与水源短对话的宠物。首期用 `dsh-soul-md` 加载「大肥鱼」性格卡，每次调用建立独立会话；插件负责发现、上下文、SQLite 队列和投递。

开发采用本机 TypeScript 测试、Docker 运行 DSH。本机无需安装 DSH。当前默认是 `mode: "draft"`、`scan: false`，手动选择帖子生成草稿，不会发到论坛。

## 本机开发

需要 Node.js 24；容器镜像固定 Node 24.22.0。依赖和 MCP 补丁从锁文件安装：

```sh
npm ci
npm test
```

测试使用模拟论坛与模型，不读取凭据、不调用外部服务。修改插件后用 `npm run build` 编译；修改 MCP 补丁的方法见 [补丁说明](patches/README.md)。

## 启动开发容器

准备三个本地文件，均已从 Git 和 Docker 构建上下文中排除：

- `secrets/discourse-profile.json`：水源 User API Key 配置，可用 `npm run auth` 初始化，文件权限设为 `600`。
- `secrets/deepseek-api-key`：只放 DeepSeek Key，文件权限设为 `600`。
- `config/pet.json`：复制 [配置示例](config/pet.example.json)，填写账号用户名和稳定的用户 ID。插件会用凭据读取当前登录身份，核对两者一致。

Soul 内容在 [config/soul.md](config/soul.md)，是这份卡片的来源。容器每次启动都比较它与 Profile 中实际使用的卡片：卡片仍是上次从镜像导入的那一份时，直接更新为 `soul.md` 的新内容；在 DSH Web 里改过的卡片保持不动，只输出一条警告。要让镜像的 Soul 强制覆盖 Web 里的修改，设置 `PET_SOUL_UPDATE=1` 启动一次，随后移除。首次启动写入的 hash 记录在数据卷的 `pet-soul-seed.json`。

```sh
docker compose up -d --build
docker compose exec pet node scripts/pet-control.mjs status
```

Web 地址为 `http://localhost:3080`，带访问 token 的入口由 `docker compose logs pet` 显示。宿主机只绑定 `127.0.0.1:3080`；远程开发时使用 SSH 端口转发。不要把带 token 的地址公开分享。容器以 UID 1000 运行，挂载的凭据文件需要允许该 UID 读取。

## 生成与查看草稿

手动入口接受帖子 ID，而非主题 ID 或楼层号。手动草稿允许读取没有唤起关键词的普通帖子，方便联调；它始终以草稿模式入队。

```sh
docker compose exec pet node scripts/pet-control.mjs draft POST_ID
docker compose exec pet node scripts/pet-control.mjs tasks
docker compose exec pet node scripts/pet-control.mjs task TASK_ID
```

`task` 输出上下文来源、DSH 会话 ID、最终正文和状态。在 DSH Web 中可以查看对应会话。相同源帖重复提交返回原任务，不会再次生成。失败任务可用 `retry TASK_ID` 重试，重试也只产生草稿；发送结果不明的任务不能通过这个入口重发。

`pause` / `resume` 暂停、恢复新调用接纳；已排队任务继续处理。`scan` 执行一次发现扫描，`reconcile` 核对未知发送。控制入口是容器内权限为 `600` 的 Unix socket，不单独开放管理端口。

## 开启持续监听与回复

将本地配置的 `scan` 改成 `true`，再 `docker compose up -d --force-recreate`，会按默认 60 秒间隔、每次一个请求读取账号的活动流（本人发帖与 mentions）。任何人（包括账号本人）都以 `@账号 【大肥鱼】` 调用，两者之间可以有空白，前面可以先引用其他内容；单独的 mention 或单独的 `【大肥鱼】` 不触发。引用、代码、链接目标和私信中的调用文本不触发。每条新活动只读一次所在主题的附近楼层，这次读取同时判断是否召唤并取得上下文；只有召唤会存入本地，去重按与上一轮的帖子 ID 增量比较。首次扫描只记录基线、跳过历史帖子；停机重启后最多追回 3 小时内的调用。旧帖编辑不保证被发现。

持续监听可以一直保持 `mode: "draft"`。真实发布只需把 `mode` 改成 `"reply"` 并重建容器，之后任何主题里的召唤都会回复；切换模式不会发送旧草稿。早期版本曾在主题 `447150` 完成一次本人调用的真实发帖验收；当前版本的召唤格式、增量监听和回帖格式尚未在真实论坛上验收。

回复内容在调用帖、直接父帖和显式引用之间分配默认 12,000 字符预算，最多补读 4 条关联帖。模型没有论坛写入、命令执行或 Soul/记忆写入工具；最终发送由插件固定目标，并在发送前用一次读取确认调用帖仍在、位置和正文未变。每条回复末尾附“（内容由 AI 生成，仅供参考）”和一个渲染后不可见的 `<!-- shuiyuan-pet 随机串 -->` 标记：标记让 Pet 认出自己的帖子、永不唤起自己，随机串避免两条相同回复被论坛当作重复内容拒绝；回复中的 `【大肥鱼】` 也会去掉括号。回复模式下，生成多次失败或论坛明确拒绝（如正文过短）时，Pet 会改发一条简短的失败提示；提示也发不出去才记为 `failed`，每个任务最多发一次提示；超时或断连可能已成功发帖，此类任务停在 `delivery_unknown`，不会自动重发，后台每 5 分钟核对一次。核对只读取最近 50 层，找不到唯一匹配时继续保留未知状态。

## 数据、更新与验证

Compose 命名卷 `pet-data` 保存 DSH 的角色卡、会话和插件 SQLite 状态。`docker compose down` 保留数据；`down -v` 会删除数据，不用于普通更新。运行时代码在镜像中，Profile 的 `node_modules` 链接到镜像依赖，不把旧插件依赖留在数据卷里。

同一数据卷由容器入口的进程锁保护，只运行一个实例；插件在同一进程内重载时先停掉旧实例。正常退出先停止接纳和工作任务，再关闭 MCP、持久化状态和 DSH；强制退出后按数据库与 DSH 日志恢复。升级前停旧实例并备份整个卷，涉及 DSH/Soul 版本变化时检查格式兼容性；首次确认迁移可通过 Compose 环境变量 `PET_ACCEPT_RUNTIME_UPDATE=1` 放行，随后移除。不要只回退镜像而忽略数据格式变化。

只读检查经插件自己的论坛适配层读取活动流、召唤帖附近楼层和发送前复查所用的单帖，在宿主机（使用仓库里的凭据）或容器里都能运行，只发 GET、间隔 5 秒。持久化检查只读容器内的本地文件。二者都不发帖：

```sh
node scripts/check-pet-readonly.mjs
docker compose exec pet node scripts/check-pet-readonly.mjs
docker compose exec pet node scripts/check-pet-container.mjs TASK_ID
docker compose restart
docker compose exec pet node scripts/check-pet-container.mjs TASK_ID
```

设计、验证记录和开发路线保存在本地 `docs/`，不纳入版本库。
