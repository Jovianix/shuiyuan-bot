---
name: redeploy
description: 重新上线水源 Pet 容器：记录基线、按需备份数据卷、重建镜像、重启并核对恢复状态。只在人明确要求时执行，不自动触发。
---

# redeploy

把改动后的代码安全地送上正在运行的 Pet 实例，并在重启后核对状态。**由人触发，不自动执行。**

## 适用场景

- 更新了插件源码、DSH 运行时依赖或 Docker 配置，需要让运行中的实例跑上新代码。
- 从崩溃、强制退出或异常重启中恢复，需要确认任务状态自洽。

不适用：首次部署（见 README「启动开发容器」）、修改 `config/pet.json`、切换草稿与回复模式——本技能不碰配置。

## 硬性约束

- **不执行** `docker compose down -v`，不删除 `pet-data` 卷。
- **不修改** `config/pet.json`，不切换 `mode` 或 `scan`。
- **不打印** `secrets/` 下任何文件的内容；不输出日志中带 token 的 DSH Web 地址（日志只取 `shuiyuan-pet ready`、`Tethered to site` 两行）。
- **不提交、不推送**任何改动。
- 构建完成后**停下来等确认**再重启：回复模式下重启等于开始对外发言。
- 任何一步失败就停下说明原因，不绕过闸门（不用 `--force`、不改数据库）。

## 1. 记录基线（只读）

```bash
git rev-parse HEAD
git status --porcelain
docker compose ps
docker compose exec pet node scripts/pet-control.mjs status
```

要求：

- 工作区有未提交改动时停下询问，不要自动 stash。
- 记录 `mode`、`scan` 与各状态任务计数，作为重启后的对照。
- 记录 `delivery_unknown` 的数量——它决定第 5 步是否要手工核对。

## 2. 判断本次更新是否触及数据格式

```bash
git diff <基线提交>..HEAD -- deploy/runtime/package.json
git diff <基线提交>..HEAD -- plugins/shuiyuan-pet/src/store.ts
```

| 变化 | 含义 | 处理 |
|---|---|---|
| `deploy/runtime/package.json` 有改动 | DSH / Soul 运行时版本变化 | 必须备份；启动时需要放行运行时迁移（见第 4 步） |
| `store.ts` 中 `CREATE TABLE`、列定义有改动 | 数据库结构变化 | 停下报告「旧卷可能需要迁移」，由人决定，不要自动继续 |
| 两者都没有 | 普通代码更新 | 可跳过备份，但仍建议首次尝试时备份 |

另外检查 `delivery_unknown` 是否大于 0：停机超过 30 分钟后，自动核对不会覆盖这些任务。

## 3. 备份数据卷（第 2 步判定需要，或人要求时）

服务停止时备份，避免拿到写了一半的 SQLite：

```bash
docker compose stop
docker compose run --rm --no-deps --entrypoint tar pet \
  -czf - -C /data . > runtime/pet-data-$(date +%Y%m%d-%H%M%S).tgz
tar -tzf runtime/pet-data-*.tgz | wc -l
chmod 600 runtime/pet-data-*.tgz
```

条目数为 0 说明备份失败，停下报告。`runtime/` 已在 `.gitignore` 中。

## 4. 构建并重启

```bash
git pull --ff-only        # 生产环境；本机更新跳过
docker compose build
```

**在此停下，向人确认是否可以重启。** 确认后：

```bash
docker compose up -d
```

如果第 2 步判定运行时版本变化，首次启动需要放行迁移：

```bash
PET_ACCEPT_RUNTIME_UPDATE=1 docker compose up -d
```

> 该变量只有在 `compose.yaml` 的 `environment:` 中声明才会传入容器（例如
> `PET_ACCEPT_RUNTIME_UPDATE: "${PET_ACCEPT_RUNTIME_UPDATE:-0}"`）。若未声明，改用：
> `docker compose run -d --rm --service-ports --name pet-migrate -e PET_ACCEPT_RUNTIME_UPDATE=1 pet`，
> 迁移完成后 `docker stop pet-migrate`，再以普通方式 `docker compose up -d`。
> 迁移只放行一次，之后不要再带这个变量启动。

## 5. 重启后核对

```bash
docker compose ps                                   # 等到 healthy，最多 90 秒
docker compose exec pet node scripts/pet-control.mjs status
docker compose logs --no-log-prefix pet | grep -E "shuiyuan-pet ready|Tethered to site"
```

判定标准：

- 容器 `Up (healthy)`。若 90 秒仍未 healthy，停下并报告 `docker compose logs pet` 中与该插件相关的错误行。
- `errors` 为空。非空时报告 `error:<kind>` 的内容（可能来自 connect / scan / worker / reconcile）。
- `mode`、`scan` 与第 1 步一致——不一致说明配置被改过，停下报告。
- `sent` 与草稿计数不低于基线；`delivery_unknown` 比基线多，说明重启时有在途发送，执行一次全量核对：

  ```bash
  docker compose exec pet node scripts/pet-control.mjs reconcile
  ```

  仍无法确认的任务保持未知状态，不重发、不推断失败。

只读检查（可选，约 5 个 GET 请求，不发帖）：

```bash
docker compose exec pet node scripts/check-pet-readonly.mjs
```

## 6. 汇报

- 更新前 / 后的提交。
- 是否触发运行时闸门、是否做了备份及备份路径。
- 各项任务计数的变化，特别是 `delivery_unknown`。
- 需要人工跟进的事项（结构迁移、无法核对的未知发送）。
- 本次是否实际重启：若在第 4 步停下未确认，要明确说明实例仍在跑旧代码。

## 回滚

镜像标签会被重新构建覆盖，**不能靠镜像标签回滚**。正确做法：

```bash
git checkout <上一个提交>
docker compose build
docker compose up -d
```

若本次更新涉及运行时版本或数据库结构变化，回滚镜像不等于回滚数据：用第 3 步的备份恢复卷后再启动，并确认数据格式与新镜像兼容。

## 恢复语义（核对时的依据）

| 重启前状态 | 重启后 | 是否会重复回答 |
| --- | --- | --- |
| `sent` | 原样保留，`sent_id` 指向已发出的楼层 | 不会：任务唯一键 `(site, pet_id, source_id)` 阻止同一召唤再建任务 |
| `draft_ready` | 原样保留，草稿正文即最终原文 | 不会：直接发送已存草稿，不重新生成 |
| `generating` | 到 DSH 会话存档找该回合；已完成则转为草稿，未完成才重新排队 | 不会重复发帖；未完成时措辞可能与上次不同 |
| `sending` | 转为 `delivery_unknown`，读该主题近期本人发帖核对 | 不会：从不自动重发 |
| 扫描进度 | 基线与已读 ID 存在 `meta` 表，重启后不会把旧召唤当新召唤 | 不会 |
