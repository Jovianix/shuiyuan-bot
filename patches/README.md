# Discourse MCP 本地补丁

本项目固定使用官方 `@discourse/mcp@0.3.1`，通过
`@discourse+mcp+0.3.1.patch` 保存运行时代码修改。`patch-package@8.0.1`
在安装后的 `postinstall` 阶段应用补丁；应用失败会使安装失败。
补丁修改 npm 包中的 `dist` 文件，不需要另行编译 TypeScript。

## 安装与验证

```sh
npm ci
npm test
```

`npm test` 使用模拟响应，不需要凭据，也不访问水源。测试覆盖楼层缺号、
重复 ID、作者筛选、分页连续性、游标失效、回复正文补读和写入参数。
创建主题和回复只使用模拟 HTTP 请求测试。

已有本地 `secrets/discourse-profile.json` 时，可运行：

```sh
npm run check:mcp:patch
```

该检查显式关闭写入，临时启用 `topics,search,activity` 工具集，
并通过 `scripts/readonly-http.mjs` 限制为水源 GET 请求。
HTTP 请求串行执行，前一个响应读取完成后至少等待 5 秒，
包括 MCP 启动验证、工具内部请求和重试。输出只包含验证结果与必要的 ID，
不输出凭据或帖子正文。`npm run check:mcp` 也使用相同的请求限制。

如果安装时使用了 `--ignore-scripts`，需先执行 `npm run postinstall`
再启动 MCP。安装阶段本身不访问水源。

## 修复内容

| 工具 | 行为变化 |
| --- | --- |
| `discourse_search`、`discourse_search_posts` | 读取 `grouped_search_result` 内的分页标记；帖子搜索提供 `next_page`，达到既有 10 页上限时说明截断原因 |
| `discourse_read_topic` | 根据可见帖子 ID 流判断后续内容；增加 `highest_post_number`、`meta.next_post_number`；信息不足时 `has_more` 为 `null` |
| `discourse_read_topic_posts` | 使用主题响应中的 ID 流；去重、校验作者，按实际楼层过滤首楼；附近读取包含可见的目标楼层；保留主题 `archetype` |
| `discourse_get_user` | 省略用户名时只读查询当前凭据对应的账号身份，返回原有公开字段投影 |
| `discourse_filter_topics` | 提供 `meta.next_cursor`，保留上游页面尚未返回的条目 |
| `discourse_get_post_replies` | 可选 `include_raw: true`，批量补读直接回复或上级回复的正文 |
| `discourse_create_post` | 支持可选的 `reply_to_post_number`，单位是主题内楼层号 |
| `discourse_read_upload`（新增） | 只读读取一张上传图片：接受 `upload://`、`/uploads/`、`/secure-uploads/`；带凭据请求站点，手动跟随一次 HTTPS 重定向到存储且不带凭据；只返回 png/jpeg/gif/webp 的 base64，`max_bytes` 默认 5 MiB |
| 创建主题与回复 | 使用 `postNoRetry`，避免不确定的错误响应导致重复发帖 |

主题选择最多返回 50 条、执行 5 次请求；达到请求预算时，
`meta.truncated_reason` 为 `request_limit`。`post_ids` 模式只请求一次，
保留调用者顺序，忽略重复 ID。帖子不可见或在两次请求之间被删除时，
返回数量可以少于要求数量。

回复正文补读最多处理 50 条缺少正文的记录，增加不超过 4 次请求。
检查 `meta.raw_complete` 判断是否补齐；`reply_ids` 模式不支持补读正文。
新增参数仍受原有的只读、身份及服务端权限检查约束。

## 主题筛选游标

第一次请求例如：

```json
{
  "filter": "tag:日记 order:created",
  "per_page": 3
}
```

后续请求保持 `filter`、`view`、`top_period`、`per_page` 不变，
把响应的 `meta.next_cursor` 传入 `cursor`，并省略 `page`。
`next_cursor` 为 `null` 时结束。

`page` 仍表示上游页码。水源可能按 30 条分页，即使请求的 `per_page`
更小；此时直接增加 `page` 会跳过尚未返回的内容，应使用游标。
游标记录页码、页内位置和上一条 ID，并绑定站点及查询条件。
同页内新增内容时通过上一条 ID 定位；定位失败会明确报错。
这是活动列表的分页，不提供数据库快照语义，跨页采集仍应按主题 ID 去重。

分类条件在水源 `/filter.json` 上返回空的原因尚未定位，此补丁没有将
TopicsFilter 条件自动转换为搜索语法。分类搜索可使用
`discourse_search_posts` 的 `category:63` 等条件，注意帖子发表时间与主题
创建时间的区别。

## 修改与升级

1. 从锁定依赖和已应用补丁的安装开始，修改目标 `dist` 文件。
2. 更新 `tests/mcp-patch.test.mjs`，执行 `npm test`。
3. 执行 `npm run patch:mcp`，重新生成与官方原包之间的差异。
4. 执行 `npm ci` 后再次运行测试，确认补丁可从干净安装恢复。
5. 提交补丁、测试、说明及相应的 `package.json`、`package-lock.json`。

改动文件已移除指向旧源码映射的 `sourceMappingURL`，避免调试时定位到
补丁前的源码。工具的类型声明使用通用 `ToolDefinition`，参数 schema
在运行时注册，无需复制未改变的声明文件。

升级上游版本时逐项核对修复是否已被接纳，再移除对应修改或重新生成补丁。
补丁能够应用并不证明行为正确，升级后仍需要回归测试。
