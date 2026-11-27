# moocflow

基于 GitHub Actions 周期化运行，云端自动检测中国大学 MOOC（icourse163.org）各任务（测验/作业/考试）的截止时间，临近截止时提醒用户。姊妹项目 [MOOC_reminder](https://github.com/)（浏览器插件）负责在浏览器里实时提醒；本项目负责离线兜底。

## 工作原理

检测与发送解耦为两个独立步骤，通过约定文件 `reminders.json` 传递：

1. 每天定时（北京时间 08:00 / 18:00）由 GitHub Actions 触发 workflow
2. **步骤一（检测）** `scripts/check.mjs`：读取 `MOOC_COURSES`（仓库 Variable 或本地环境变量）里的课程 URL，解析为课程列表（URL 解析器移植自参考项目，三种路由通吃、排除论坛帖等伪课程链接），再用你提供的 Cookie 调用 `courseBean.getLastLearnedMocTermDto.rpc` 拉取整课 DTO，解析出全部测验/作业/考试及其截止时间、完成状态（SPOC 会自动解析关联的源课程，路由 term 与源课程 term 的内容都会抓取合并）。对「启用互评且已提交、成绩未公布」的作业，还会通过 `MocEvaluateBean.getEvaluateStatus.dwr`（见 `src/evaluate.mjs`）查询互评/自评完成状态——**互评与自评都完成的作业视为互评义务已履行，不再产生互评提醒**；userId 主来源为 Cookie 的 `NETEASE_WDA_UID`，缺失时回退到课程页 HTML 内嵌的 `webUser.id`。状态查询失败不影响提醒，退化为纯时间提醒。最后把「N 小时内即将截止」和「已过期未完成」的事件写入 `reminders.json`（格式见 `src/report.mjs`）
3. **步骤二（发送）** `scripts/notify.mjs`：读取 `reminders.json`，按 `NOTIFY_CHANNEL` 分发到 `src/channels/` 下对应渠道发送

### 通知渠道

渠道实现统一放在 `src/channels/`，按方式名命名，用 `NOTIFY_CHANNEL` 切换：

| 方式 | 模块 | 原理 | 所需配置 |
|---|---|---|---|
| `github`（默认） | `channels/github.mjs` | 向你手动创建的提醒 issue 追加评论；你是该 issue 的参与者，GitHub 会把评论通知发到你账号的通知邮箱 | 零配置（`GITHUB_TOKEN`/`GITHUB_REPOSITORY` 由 Actions 自动提供；issue 编号非必填，默认 1） |
| `mail` | `channels/mail.mjs` | SMTP 邮件 | `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`NOTIFY_TO` 等 |
| `cnb`（**已弃用**） | `channels/cnb.mjs` | 向 CNB 仓库 issue 发布/更新提醒评论。**2026-11-15 实测弃用：评论能正常发布，但不会触发邮件/微信等任何站外通知**（官方文档亦无此承诺），仅剩平台内留痕价值；CNB 用户请改用 `mail` 或流水线内 WPush/IM 插件 | `CNB_TOKEN`/`CNB_REPO_SLUG` 由 CNB 流水线自动注入，无需额外 token |
| `gitlab` | `channels/gitlab.mjs` | 向 GitLab / 极狐 GitLab 仓库 issue 追加评论；issue 参与者会收到 "New comment" 通知（邮件/站内） | `GITLAB_TOKEN`（个人访问令牌，scope=`api`）；项目 ID/API 地址由 CI 自动提供 |
| `gitee` | `channels/gitee.mjs` | 向 Gitee 仓库 issue 追加评论（评论会触发站内信；**邮件默认关闭，需收件人自行开启**） | `GITEE_TOKEN`（个人访问令牌）+ `GITEE_REPO_SLUG`（`owner/repo`） |
| `wechat` | `channels/wechat.mjs` | 聚合渠道：按 `WECHAT_CHANNELS` 显式顺序在子渠道间 fallback，推送到个人微信 | `WECHAT_CHANNELS`（顺序，必填）+ 所选子渠道的 key |
| `qq` | `channels/qq.mjs` | 聚合渠道：按 `QQ_CHANNELS` 显式顺序在子渠道间 fallback，推送到 QQ | `QQ_CHANNELS`（顺序，必填）+ 所选子渠道的配置 |

**wechat / qq 渠道（聚合 + 子渠道 fallback）**：`NOTIFY_CHANNEL=wechat` 或 `qq` 时，按 `WECHAT_CHANNELS` / `QQ_CHANNELS`（逗号分隔的子渠道顺序，必填）依次尝试已配置的子渠道：成功即止；某个子渠道失败（网络/HTTP 错误）打印警告并自动尝试下一个；全部失败才让 step 失败。顺序中只激活配置了对应 key 的子渠道，未配置的自动跳过。

| 子渠道 | 聚合渠道 | 环境变量 | 说明与已知风险 |
|---|---|---|---|
| `serverchan`（Server酱 Turbo） | wechat | `SERVERCHAN_SENDKEY` | 关注「方糖」服务号接收；免费 5 条/天（失败也计数） |
| `pushplus` | wechat + qq | `PUSHPLUS_TOKEN` | 微信渠道需**实名**（实名流程收费或开一个月会员替代），200 次/天；QQ 渠道用其共享机器人（扫码加好友绑定即可，无需自建），但**仅展示标题摘要**，正文不显示 |
| `wxpusher` | wechat | `WXPUSHER_SPT` 或 `WXPUSHER_APP_TOKEN`+`WXPUSHER_UID` | 免费无每日条数限制；SPT 极简推送免建应用（扫官方二维码即得），标准推送需建应用+取 UID；多个接收方逗号分隔 |
| `qmsg`（Qmsg酱） | qq | `QMSG_KEY`（可选 `QMSG_GROUP` 指定已绑定群） | 加其机器人好友并绑定；免费 500 条/日；**消息禁止 URL（代码已自动剥离课程链接）**；2026-08 曾整体停运约 2-3 个月后重启，建议不作唯一通道 |
| `qqbot`（QQ 官方机器人） | qq | `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` / `QQ_BOT_GROUP_OPENID` | 官方合规、无封号风险；`group_openid` 只能从群事件（群里 @机器人一次）中获取——本地跑一次临时回调脚本采集后永久复用，CI 之后纯 HTTP 发送；群主需开启「机器人主动发言」开关 |

**github 渠道的首次设置**（一次性，约 2 分钟）：

1. 在仓库里手动创建一个 issue（建议标题「📬 MOOC 提醒」）——注意要由**你本人**创建，这样你才是参与者、评论才会通知到你
2. 确认 issue 编号（URL 末尾数字）：新建仓库的第一个 issue 编号必然是 `1`，此时无需配置；若不是 `1`，把它存为仓库 Variable：Settings → Secrets and variables → Actions → Variables → `REMINDER_ISSUE_NUMBER`
3. 保持 GitHub 账号的通知设置中 "Participating and @mentions" 邮件通知开启（默认开启）

> 为什么不用 `GITHUB_TOKEN` 直接 @你？因为 GitHub 会压制 `github-actions[bot]` 的 @mention 通知，但**不压制** thread 参与者收到的评论通知——所以由你建 issue、bot 只评论，就能绕开压制且零 secret 管理。邮件延迟几分钟属正常；若在网页上先读了通知，邮件可能不发。

每次发布新评论后，渠道会删除超过 `COMMENT_RETENTION_DAYS`（默认 7 天）的旧 bot 评论，避免 issue 无限变长；`0` 表示只保留最新一条。删除不会撤回已经发出的通知邮件，清理失败也只记日志、不影响提醒送达。

**新增渠道**（钉钉/Telegram/PushPlus 等）：在 `src/channels/` 新建 `<名字>.mjs`，实现统一契约（`name` / `isConfigured` / `deliver` / `renderPreview`，见 `mail.mjs` 头注释），在 `channels/index.mjs` 注册一行即可，检测逻辑与其他渠道零改动。

**新增代码托管平台的 issue 通知渠道**（Gitea/GitLab/Gitee 等）：平台的 issue 评论 API 差异（路径、鉴权头、bot 识别、字段映射）收敛为 `src/channels/issue-factory.mjs` 的平台描述对象，发布、翻页清理、渲染（`src/channels/render.mjs`）等通用流程零改动，参考 `github.mjs` / `cnb.mjs` 写一个描述对象并注册即可。工厂按平台能力自动选择策略：有 `updateRequest`（CNB 无删除接口）就覆盖更新同一条评论；有 `deleteRequest`（GitHub）就新建并按保留期清理；两者都没有就每次新建。各平台渠道彼此并列、由用户用 `NOTIFY_CHANNEL` 显式选择，不做平台自动探测。仓库坐标与令牌的环境变量解析在 `src/repo-env.mjs`（平台原生变量优先，通用别名 `REPO_SLUG`/`REPO_TOKEN` 兜底）；Cookie 写回 Secret 的平台实现在 `src/secrets.mjs`（`COOKIE_REFRESH_MODE=2`/`3` 用，当前仅 GitHub）。

### CNB 接入（cnb.cool）

> [!WARNING]
> **`cnb` issue 通知渠道已弃用（2026-11-15 实测）**：提醒评论能正常发布，但实测**不会触发邮件、微信等任何站外通知**（CNB 官方文档也没有此承诺），渠道仅剩平台内留痕价值。在 CNB 部署请把 `NOTIFY_CHANNEL` 改为 `mail` 并配置 SMTP，或改用 CNB 插件市场的 WPush / 钉钉 / 飞书 / 企微插件。下文的 issue 配置仅为兼容已部署用户而保留。

仓库根目录的 `.cnb.yml` 已配置好定时流水线（仅 crontab 触发，不随 push 运行）：

1. **导入仓库**：在 CNB 创建仓库并导入本项目（CNB 读取的是 `main` 分支的 `.cnb.yml`；默认分支不同请改文件里的分支键）。
2. **建提醒 issue**：在 CNB 仓库里手动创建一个 issue；编号复用 `REMINDER_ISSUE_NUMBER`（非必填，默认 `1`），不是 `1` 时改 `.cnb.yml` 的 `env`。
3. **配置敏感信息**：CNB 没有 GitHub Secrets 那种仓库级密钥，官方做法是建一个「密钥仓库」（类型选密钥仓库，只能网页编辑），把 `MOOC_COOKIE`、`SMTP_*` 等写成键值对文件，然后取消 `.cnb.yml` 里 `imports:` 的注释并填入该文件 URL。非敏感项（如 `MOOC_COURSES`）直接写在 `env:` 里。
4. **确认定时任务**：推送后到仓库「云原生构建 → 定时任务」确认同步成功（cron 为 `54 7,17 * * *`，CNB 固定使用北京时间，无需换算 UTC）。
5. **通知方式**：`.cnb.yml` 模板默认值仍是 `NOTIFY_CHANNEL: cnb`，但该渠道**已弃用**（实测评论不触发任何邮件/微信通知，见上方 WARNING）——推荐改成 `mail` 并配置 SMTP，或使用 CNB 插件市场的 WPush/IM 插件。

> CNB issue 评论没有删除接口，`cnb` 渠道默认（`CNB_ISSUE_UPDATE_MODE=1`）覆盖更新最近一条自己发布的提醒评论，因此 `COMMENT_RETENTION_DAYS` 对它无效；把 `CNB_ISSUE_UPDATE_MODE` 设为 `0` 则每次只发新评论、不修改旧评论（issue 会逐渐变长）。本地调试时设置的 `CNB_TOKEN` 若对应用户不是 `cnb`，需把 `CNB_BOT_LOGIN` 设为该用户名，否则识别不到历史评论、每次都会新建。

### GitLab / 极狐 GitLab 接入

仓库根目录的 `.gitlab-ci.yml` 只允许**定时**与**页面手动运行**触发，push 不会产生流水线：

1. **导入仓库**：在 GitLab（极狐为 jihulab.com）创建项目并导入本项目，默认分支为 `main`。
2. **建提醒 issue**：在项目里手动创建一个 issue；编号复用 `REMINDER_ISSUE_NUMBER`（非必填，默认 `1`），不是 `1` 就在 CI/CD Variables 里设置。
3. **创建访问令牌**：极狐 SaaS 免费版**不能用项目访问令牌**（付费功能），请创建**个人访问令牌**（User Settings → Access Tokens），scope 勾选 `api`，令牌用户需是项目成员（建议 Developer）。设置过期时间并安排轮换。
4. **配置 CI/CD Variables**（Settings → CI/CD → Variables）：`GITLAB_TOKEN`（上一步的 PAT，勾选 Masked）、`MOOC_COOKIE`（勾选 Masked）、`MOOC_COURSES` 等；改用 `mail` 时再配 `SMTP_*`/`NOTIFY_TO`。
5. **创建定时计划**：Build → Pipeline schedules → New schedule，Cron 填 `54 7,17 * * *`，时区选 `Asia/Shanghai`，目标分支 `main`。也可用 API；仓库里的 `.gitlab-ci.yml` 无法声明定时计划。
6. **验证**：Build → Pipelines → Run pipeline 手动跑一次。

> `CI_JOB_TOKEN` **不能**发 issue 评论（官方权限清单里只有只读的 MR notes），必须用上面的 PAT。`gitlab` 渠道沿用与 github 相同的“发新评论 + 按 `COMMENT_RETENTION_DAYS` 清理旧评论”；与 GitHub 不同的是，GitLab 的删除权限只覆盖自己的 note，清理失败只记日志、不影响送达。默认只按正文签名识别历史评论；若使用独立 bot 账号的令牌，可设 `GITLAB_BOT_LOGIN` 限定作者名，更精确。

### Gitee Go 接入

> ⚠️ **必须使用私有仓库（private）**：Gitee Go 没有密文变量，`GITEE_TOKEN`、`MOOC_COOKIE`、`SMTP_*` 都会以明文写进 `.workflow/*.yml`；公开仓库等于公开凭据。

仓库根目录的 `.workflow/moocflow-reminder.yml` 是 Gitee Go 的流水线定义（自有 DSL，与 GitHub Actions 不兼容）：

1. **导入仓库**：在 Gitee 创建仓库并导入本项目。Gitee Go 读取 `.workflow/*.yml`；如果页面没有自动识别，请在「流水线」里新建并选择该 YAML。
2. **建提醒 issue**：在仓库里手动创建一个 issue；编号复用 `REMINDER_ISSUE_NUMBER`（非必填，默认 `1`）。
3. **创建访问令牌**：设置 → 安全设置 → 私人令牌，scope 至少勾选 `issues` + `notes`（Gitee 未逐接口标注 scope，需实测）。**Gitee Go 没有密文变量**，令牌只能明文写进 `.workflow` 的 `variables`——务必使用**私有仓库**、专用、最小权限、可轮换的令牌。
4. **补全变量**：`GITEE_REPO_SLUG`（`owner/repo`，必须显式填，Gitee Go 的 `GITEE_REPO` 不含 owner）、`MOOC_COURSES`、`MOOC_COOKIE`，改用 `mail` 时再配 `SMTP_*`/`NOTIFY_TO`。
5. **确认定时**：一条流水线只支持一个 cron 表达式，文件里用 `54 7,17 * * ?` 覆盖每天两次。**时区官方未注明**，上线前用“5 分钟后”的表达式实测一次；若实际按 UTC 触发，改成 `54 23,9 * * ?`。
6. **验证**：在流水线页面手动运行一次。

> **Node 版本限制**：Gitee Go 的 `build@nodejs` 官方只支持到 Node 15.12.0，而本项目需要 Node 20+（依赖全局 `fetch`）。workflow 里因此**在构建时下载 Node 22**（与 GitHub/CNB/GitLab 的版本保持一致，优先 npmmirror）再运行，属实验性做法；如果构建环境无法出网下载，请改用自有主机组（`shell@agent`）或 `mail` 渠道配合其他 CI。社区还反馈“纯定时流水线可能无法保存，需同时勾选 Push 事件并推送一次”，遇到时按提示处理即可。

> Gitee 的通知矩阵里「任务被评论」站内信默认开启，但**邮件默认关闭**，每个收件人都要自己去通知设置里勾选；API 创建的评论是否触发通知官方未文档化。需要可靠送达时，建议同时配置仓库 WebHook 的「评论」钩子到钉钉/飞书群机器人，或直接用 `mail` 渠道。`gitee` 渠道的评论清理语义与 github 相同（`COMMENT_RETENTION_DAYS` 生效）。

### 阿里云云效 Flow 接入

模板在 `ci/yunxiao-flow.yml`（云效没有仓库内自动识别的 CI 文件约定，需要复制到 Flow 的 YAML 编辑器）：

1. **新建流水线**：云效 → 流水线 → 新建 → YAML 化编排，粘贴模板。
2. **选代码源**：`sources.repo.type` 支持 `codeup` / `github` / `gitee` / `gitlab` / `git`。私有仓库要配服务连接。
3. **配私密变量**：云效 YAML 的 `variables` **不支持私密变量**，`MOOC_COOKIE`、`SMTP_PASS`（以及 GitHub/Gitee 渠道的 `REPO_TOKEN`）必须放进**变量组**，再把变量组 ID 填到 `variableGroups`。
4. **选通知渠道**：
   - 仓库在 **Codeup**：云效没有仓库议题，`NOTIFY_CHANNEL` 只能是 `mail`（配 `SMTP_*` / `NOTIFY_TO`）。
   - 仓库在 **GitHub / Gitee / GitLab**：可改成 `github` / `gitee` / `gitlab`，并在变量组里配 `REPO_TOKEN` + `REPO_SLUG`（或平台原生变量）。
5. **配定时**：云效**没有 cron 表达式**，只能在控制台「触发设置 → 周期触发 / 单次触发」里配。想要准确的每天两次，建议建两条单次触发（07:54 / 17:54）；周期触发是“时间段 + 间隔”模型，会多跑。上线前用 5 分钟后的时间实测时区。
6. **验证**：手动运行一次。

> 云效免费版 3000 核分/月、并发 3，每天两次几分钟的小任务占用约 20%。模板用 `Command` 步骤在运行时下载 Node 22（公共集群的 NodeBuild 版本未在公开文档中确认）；若公共集群不能出网，需改用自定义镜像或私有构建集群。Flow 自带的消息通知插件（钉钉/邮件/企微/飞书/Webhook）只报流水线状态，**不能写议题评论**。

### Cookie 自动刷新（可选）

`COOKIE_REFRESH_MODE` 控制检测到 Cookie 失效时的行为：

| 值 | 行为 |
|---|---|
| `0` | 保持旧行为：不刷新，全部课程因鉴权失败时直接报错 |
| `1`（默认） | 用 Cookie 里的 `STUDY_PERSIST` 静默重登；刷新后完成本次拉取和提醒，但**不保存**新 Cookie |
| `2` | 同 `1`，并用 `MOOC_REFRESH_PAT` 调 GitHub API 覆盖保存 `MOOC_COOKIE` Secret |
| `3` | 同 `2`，但用 GitHub App 安装令牌（`actions/create-github-app-token`）代替 PAT 写回 |

触发条件：只有在“**所有实际拉取的课程都返回鉴权失败**”时才刷新；单门课程失败、网络错误、课程配置问题都不会触发。

刷新发生时，提醒通知的课程列表下方会附带一条说明：模式 1 提示仓库 Secret 中的 Cookie 仍是已失效的旧值、需手动更新；模式 2 提示新 Cookie 已在本次运行中写回 Secret；模式 3 提示已通过 GitHub App 写回。

刷新链路（2026-11-02 实测）：

```
GET https://www.icourse163.org/  (Cookie 中带 STUDY_PERSIST)
  → 302 /passport/logingate/changeCookie.htm?type=study&returnUrl=...
  → 200 Set-Cookie: 新的 STUDY_SESS、轮换后的 STUDY_PERSIST、STUDY_INFO
```

在 Actions 中，非敏感配置（`COOKIE_REFRESH_MODE`、`MOOC_APP_ID`、`MOOC_COOKIE_SECRET_NAME`、`DUE_WINDOW_HOURS`、`OVERDUE_DAYS`、`NOTIFY_CHANNEL`、`REMINDERS_FILE`、`SMTP_SECURE`、`REMINDER_ISSUE_NUMBER`、`COMMENT_RETENTION_DAYS`）放在仓库 **Variables**；Cookie、PAT、App 私钥以及 mail 渠道的 SMTP 项按现有 workflow 放在 **Secrets**（见步骤 3）。这些 Variable 留空时都回退到 `src/config.mjs` 的默认值。

模式 2 的 PAT 要求：

- 使用 **Fine-grained personal access token**；
- 只授权目标仓库；
- Repository permissions 中把 **Secrets** 设为 **Read and write**；
- 存为仓库 Secret `MOOC_REFRESH_PAT`；
- 本地运行模式 2 时还需设置 `GITHUB_REPOSITORY=owner/repo`（Actions 中自动提供；平台无关别名 `REPO_SLUG` 同样有效）。

模式 3 的 GitHub App 要求（**每个用户自建 App**，私钥不可共享）：

1. 个人 Settings → Developer settings → GitHub Apps → New GitHub App；Webhook 可关闭；
2. Repository permissions 中把 **Secrets** 设为 **Read and write**；
3. 安装（Install App）到自己的这个仓库，只选该仓库；
4. 仓库 Variable `MOOC_APP_ID` 填 App ID（数字），仓库 Secret `MOOC_APP_PRIVATE_KEY` 填私钥 `.pem` 全文；
5. workflow 仅在 `COOKIE_REFRESH_MODE=3` 时执行 `actions/create-github-app-token@v2` 生成安装令牌（1 小时有效，任务结束即吊销），通过 `MOOC_REFRESH_APP_TOKEN` 传给检测脚本，无需手动维护 token。

模式 3 依赖 workflow 里的取令牌步骤，因此只在 GitHub Actions 中可用；本地运行模式 3 需自行提供有效的 `MOOC_REFRESH_APP_TOKEN`。

> PAT / App 私钥都能修改仓库 Secret，权限较高，请只授权本仓库。不要把自己 App 的私钥交给别人——它会对该 App 的所有安装生效。模式 2/3 失败（凭据缺失/无权限）时脚本会直接报错，不会静默跳过保存。

## 使用步骤

1. 在你的 fork 中进入 **Settings → Secrets and variables → Actions → Variables**，新建 `MOOC_COURSES`，值为课程页 URL；**多门课程用分号 `;` 分隔**（也接受换行分隔）。URL 后可用 ` # 名称` 起显示名：

   ```
   https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444 # 概率论与数理统计; https://www.icourse163.org/learn/BIT-268001?tid=1460270441
   ```

   支持三种链接写法（复制浏览器地址栏原样粘贴）：`/learn/学校-课程号?tid=…`（旧 MOOC）、`/mooc/learn/学校-课程号/…?tid=…`（2026-10 新路由）、`/spoc/learn/…`（SPOC）。URL 后可用 ` # 名称` 起显示名，省略则用课程数据里的真实名称。运行时自动解析，坏行/重复行会跳过并记 warning。

   课程列表只存在仓库设置里，不产生提交，因此改完仍可直接 Sync fork。

2. 在浏览器登录 icourse163.org 后，F12 → Network 复制对 `www.icourse163.org` 请求的**完整 Cookie 串**（必须包含 `NTESSTUDYSI`、`STUDY_SESS` 与身份 Cookie；只带 NTESSTUDYSI 会返回空数据）。如果要启用自动刷新，串里还必须包含 `STUDY_PERSIST`。

3. 按所选通知渠道完成配置（见上表；github 渠道做三步一次性设置即可，mail 渠道再添加以下 Secret）：

   | Secret | 说明 |
   |---|---|
   | `MOOC_COOKIE` | 上一步的完整 Cookie 串（两种渠道都必须） |
   | `MOOC_REFRESH_PAT` | 仅 `COOKIE_REFRESH_MODE=2` 需要：Fine-grained PAT，需目标仓库的 Secrets 读写权限 |
   | `MOOC_APP_PRIVATE_KEY` | 仅 `COOKIE_REFRESH_MODE=3` 需要：自建 GitHub App 的私钥 `.pem` 全文（App ID 放 Variable `MOOC_APP_ID`） |
   | `SMTP_HOST` / `SMTP_PORT` | SMTP 服务器（如 QQ 邮箱 `smtp.qq.com` / `465`） |
   | `SMTP_USER` / `SMTP_PASS` | SMTP 账号与授权码（不是登录密码） |
   | `SMTP_FROM` | 可选，发件人地址，默认同 SMTP_USER |
   | `NOTIFY_TO` | 收件人邮箱，多个用逗号分隔 |

   `SMTP_SECURE` 是仓库 Variable（不是 Secret），留空时按端口推断。

4. 手动触发 workflow（Actions → mooc deadline reminder → Run workflow）验证，之后即可全自动运行。

## 本地运行 / 测试

```bash
npm install
npm test                 # 单元测试（DTO 解析、事件分类、提醒文档、通知渠道、URL 解析等）
MOOC_COURSES="https://... # 课程名; https://..." MOOC_COOKIE="..." node scripts/check.mjs        # 步骤一：检测（默认模式 1，失效时自动刷新，仅本次使用）
COOKIE_REFRESH_MODE=1 MOOC_COURSES="https://..." MOOC_COOKIE="..." node scripts/check.mjs  # 模式 1：失效时刷新，仅本次使用
node scripts/notify.mjs                          # 步骤二：默认 github 渠道（未配 token 时打印 markdown 预览）
NOTIFY_CHANNEL=mail node scripts/notify.mjs      # 步骤二：mail 渠道（未配 SMTP 时打印文本预览）
```

## 环境变量

代码中的默认值统一由 `src/config.mjs` 的 `DEFAULTS` 定义；修改后需同步本表。

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOOC_COOKIE` | 必填（检测步骤） | 完整浏览器 Cookie 串（自动刷新需要其中包含 `STUDY_PERSIST`） |
| `COOKIE_REFRESH_MODE` | `1` | Cookie 更新方式：`0` 不刷新 / `1` 刷新但仅本次使用 / `2` 刷新并写回 Secret（PAT） / `3` 刷新并写回 Secret（GitHub App） |
| `MOOC_REFRESH_PAT` | 模式 `2` 必填 | Fine-grained PAT，目标仓库 Secrets 读写权限 |
| `MOOC_REFRESH_APP_TOKEN` | 模式 `3` 自动生成 | GitHub App 安装令牌（workflow 生成，1 小时有效）；本地运行模式 `3` 时需手动提供 |
| `MOOC_APP_ID` | 模式 `3` 必填（Variable） | 自建 GitHub App 的 App ID（数字） |
| `MOOC_APP_PRIVATE_KEY` | 模式 `3` 必填（Secret） | 自建 GitHub App 的私钥 `.pem` 全文 |
| `MOOC_COOKIE_SECRET_NAME` | `MOOC_COOKIE` | 模式 `2`/`3` 要覆盖保存的 Secret 名称 |
| `MOOC_COURSES` | 必填（检测步骤） | 课程列表（仓库 Variable 或本地环境变量）；多门用分号或换行分隔 |
| `DUE_WINDOW_HOURS` | `48` | 即将截止提醒窗口（小时） |
| `OVERDUE_DAYS` | `3` | 已过期任务仍在提醒范围内的天数 |
| `REMINDERS_FILE` | `reminders.json` | 两步骤间传递的提醒文档路径（两步需一致） |
| `NOTIFY_CHANNEL` | `github` | 通知方式：`github` / `mail` / `cnb`（已弃用，实测不触发站外通知） / `gitlab` / `gitee` / `wechat` / `qq`；留空默认 `github` |
| `REMINDER_ISSUE_NUMBER` | `1` | 手动创建的提醒 issue 编号（非必填；github / cnb / gitlab / gitee 渠道共用） |
| `COMMENT_RETENTION_DAYS` | `7` | github / gitlab / gitee 渠道旧评论保留天数；`0` 表示只保留最新一条（cnb 渠道无删除接口，此项无效） |
| `REPO_TOKEN` / `REPO_SLUG` | 可选 | 平台无关别名（等价 `GITHUB_TOKEN` / `GITHUB_REPOSITORY`，CNB 下可代替 `CNB_TOKEN` / `CNB_REPO_SLUG`，云效 + GitHub/Gitee 仓库时也用它）；平台原生变量优先 |
| `COOKIE_SECRET_STORE` | `github` | 模式 `2`/`3` 的 Secret 写回实现（预留，见 `src/secrets.mjs`）；未知取值报错 |
| `CNB_TOKEN` | CNB 流水线自动注入 | CNB 临时令牌（`repo-notes:rw`）；本地调试时用个人访问令牌 |
| `CNB_REPO_SLUG` / `CNB_API_ENDPOINT` | CNB 流水线自动注入 | 仓库路径（`group/repo`）与 API 地址；本地调试时手动设置 |
| `CNB_TOKEN_USER_NAME` | CNB 流水线自动注入 | 令牌用户名（固定 `cnb`），用于识别自己发布的评论 |
| `CNB_BOT_LOGIN` | 同 `CNB_TOKEN_USER_NAME` | 可选；本地调试时覆盖"自己"的用户名 |
| `CNB_ISSUE_UPDATE_MODE` | `1` | CNB 渠道评论更新方式：`1` 覆盖更新最近一条自己的提醒评论（默认）；`0` 每次只发新评论、不修改旧评论（issue 会逐渐变长） |
| `CNB_WEB_ENDPOINT` | `https://cnb.cool` | 可选；仅用于拼接提醒评论的展示链接 |
| `GITLAB_TOKEN` | gitlab 渠道必填 | 个人访问令牌，scope=`api`（`CI_JOB_TOKEN` 不可用）；本地调试可用 `REPO_TOKEN` 代替 |
| `CI_PROJECT_ID` / `CI_API_V4_URL` / `CI_PROJECT_URL` | GitLab CI 自动注入 | 项目 ID、API 地址（如 `https://jihulab.com/api/v4`）、项目页面地址 |
| `GITLAB_PROJECT` | 同 `CI_PROJECT_ID` | 可选；本地调试时指定项目 ID 或 `group/project` 路径 |
| `GITLAB_API_URL` | 同 `CI_API_V4_URL` | 可选；本地调试时指定 API 地址（极狐为 `https://jihulab.com/api/v4`） |
| `GITLAB_PROJECT_URL` | 同 `CI_PROJECT_URL` | 可选；本地调试时用于拼接 issue 展示链接 |
| `GITLAB_BOT_LOGIN` | 不设置 | 可选；限定"自己"的评论作者名。不设置时只按正文签名识别 |
| `GITEE_TOKEN` | gitee 渠道必填 | 个人访问令牌，scope 建议 `issues` + `notes`；本地调试可用 `REPO_TOKEN` 代替 |
| `GITEE_REPO_SLUG` | gitee 渠道必填 | 仓库路径 `owner/repo`（Gitee Go 的 `GITEE_REPO` 不含 owner）；也可用含 `/` 的 `GITEE_REPO` 或 `REPO_SLUG` |
| `GITEE_API_URL` / `GITEE_WEB_URL` | `https://gitee.com/api/v5` / `https://gitee.com` | 可选；私有化或镜像实例时覆盖 |
| `GITEE_BOT_LOGIN` | 不设置 | 可选；限定"自己"的评论作者名。不设置时只按正文签名识别 |
| `SMTP_HOST` | mail 渠道必填 | SMTP 服务器 |
| `SMTP_PORT` | `465` | SMTP 端口 |
| `SMTP_SECURE` | 端口为 `465` 时 `true` | 是否使用 TLS；留空按端口推断 |
| `SMTP_USER` / `SMTP_PASS` | mail 渠道必填 | SMTP 账号与授权码（不是登录密码） |
| `SMTP_FROM` | 同 `SMTP_USER` | 发件人地址 |
| `NOTIFY_TO` | mail 渠道必填 | 收件人地址，多个用逗号分隔 |
| `WECHAT_CHANNELS` | wechat 渠道必填 | 微信子渠道发送顺序，逗号分隔（如 `serverchan,wxpusher,pushplus`）；只列想启用的子渠道，未配置 key 的自动跳过 |
| `QQ_CHANNELS` | qq 渠道必填 | QQ 子渠道发送顺序，逗号分隔（如 `qmsg,qqbot,pushplus`） |
| `SERVERCHAN_SENDKEY` | serverchan 子渠道必填 | Server酱 SendKey（sct.ftqq.com 获取；免费 5 条/天，失败的请求也计入） |
| `PUSHPLUS_TOKEN` | pushplus 子渠道必填 | PushPlus token（微信渠道需实名后才有额度；QQ 渠道用共享机器人） |
| `WXPUSHER_SPT` | wxpusher 子渠道可选 | WxPusher SPT 极简推送令牌（免建应用）；多个接收方逗号分隔，与标准推送二选一 |
| `WXPUSHER_APP_TOKEN` / `WXPUSHER_UID` | wxpusher 子渠道可选 | WxPusher 标准应用推送；UID 多个逗号分隔 |
| `QMSG_KEY` | qmsg 子渠道必填 | Qmsg酱 API key（先加其机器人好友并绑定）；`QMSG_GROUP` 可选指定已绑定群号 |
| `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` | qqbot 子渠道必填 | QQ 开放平台机器人的 AppID 与 AppSecret |
| `QQ_BOT_GROUP_OPENID` | qqbot 子渠道必填 | 群 openid（群成员 @机器人触发事件后从回调 payload 采集，本地一次性采集即可），多个群逗号分隔 |

## 已知边界

- Cookie 会过期：模式 `0` 下提醒突然变空/报 `result 为空` 时需要重新抓一次 Cookie 更新 Secret；模式 `1`/`2`/`3` 会在全部课程鉴权失败时尝试用 `STUDY_PERSIST` 自动重登
- 自动刷新依赖 `STUDY_PERSIST`；如果它也失效（例如 30 天到期、改密、主动登出），仍需手动更新 Cookie
- 未做跨次运行的去重（v1 每次运行窗口内的任务都会再提醒一次），提醒频率 = 运行频率
- SPOC 课程会额外读取公开课程介绍页来定位关联的源课程；如果平台页面改版导致解析失败，日志会给出警告并退化为只抓路由 term
- 测验的「已用尽尝试次数」或「得分>0」才视为完成；剩余尝试次数且未得分的测验会继续提醒（防止漏刷题）
- 互评完成检测走 `MocEvaluateBean.getEvaluateStatus.dwr`（2026-11 实测逆向）：Cookie 主来源 `NETEASE_WDA_UID` 是统计 Cookie，个别浏览器环境可能没有——缺失时回退课程页 HTML 解析 `webUser.id`，两者都拿不到则跳过检测、保持纯时间提醒；SPOC 课程该 DWR 接口可用性未实测，失败同样退化为纯时间提醒；接口按显式 `(testId, userId)` 查询、不校验会话，若平台后续收紧鉴权，检测会静默退化为提醒（宁多不漏），可从日志「互评状态查询：N 份待查，成功 M 份」观察
- `cnb` 渠道**已弃用**（2026-11-15 实测）：issue 评论能发布，但不会触发邮件/微信等任何站外通知，只在平台内留痕；需要可靠送达请用 `mail`
- `gitlab` 渠道依赖个人访问令牌（极狐 SaaS 免费版不支持项目访问令牌），令牌默认最长 365 天，需安排轮换；CI_JOB_TOKEN 无写评论权限
- `gitee` 渠道的令牌在 Gitee Go 中没有密文变量可放，只能明文保存，**因此必须使用私有仓库**；且 build@nodejs 最高只支持 Node 15，workflow 需在运行时下载 Node 22，构建环境必须能出网
- 云效 Codeup 仓库没有议题对象，**没有对应的 issue 渠道**；Codeup 用户只能使用 `mail`。仓库在 GitHub/Gitee、仅把 CI 放云效时，现有 `github`/`gitee` 渠道仍可用
- github 渠道的通知邮件由 GitHub 派发，到达时间不可控；追求即时/可靠送达用 `mail` 渠道
- `wechat` / `qq` 渠道的 fallback 只兜"单次发送失败"：某个子渠道服务整体停运（如 Qmsg酱 2026-08 停运 2-3 个月）会依次耗尽所有子渠道后让 step 失败，不会静默丢失，但当日提醒不会送达——重要场景叠加 `mail` 双保险需自行把 NOTIFY_CHANNEL 切回 mail
- `pushplus` 未实名不能发送（实名流程收费，或开一个月会员免费实名）；额度政策可能变化，落地前复核
- `qmsg` 消息禁止出现 URL（代码已自动剥离课程链接，只留文字提醒）；其内容审核对违规消息可能封 key
- `qqbot` 依赖群主开启「机器人主动发言」开关；QQ 开放平台政策有波动（2025-04 曾移除主动消息、2026-06 以群主授权形式恢复），个人主体机器人暂不支持公开使用
- GitHub Actions 境外网络访问国内推送端点（sctapi/pushplus/zjiecode/qmsg/qq API）可能偶发变慢或失败，fallback 链 + 保留 `mail` 兜底可提高送达率
- 低活跃仓库的定时 workflow 可能被 GitHub 静默跳过（不排队、无运行记录）；若 Actions 页长期没有定时运行痕迹，先手动 Run workflow 验证配置本身无误
