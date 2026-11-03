# moocflow

基于 GitHub Actions 周期化运行，云端自动检测中国大学 MOOC（icourse163.org）各任务（测验/作业/考试）的截止时间，临近截止时提醒用户。姊妹项目 [MOOC_reminder](https://github.com/)（浏览器插件）负责在浏览器里实时提醒；本项目负责离线兜底。

## 工作原理

检测与发送解耦为两个独立步骤，通过约定文件 `reminders.json` 传递：

1. 每天定时（北京时间 08:00 / 18:00）由 GitHub Actions 触发 workflow
2. **步骤一（检测）** `scripts/check.mjs`：读取 `MOOC_COURSES`（仓库 Variable 或本地环境变量）里的课程 URL，解析为课程列表（URL 解析器移植自参考项目，三种路由通吃、排除论坛帖等伪课程链接），再用你提供的 Cookie 调用 `courseBean.getLastLearnedMocTermDto.rpc` 拉取整课 DTO，解析出全部测验/作业/考试及其截止时间、完成状态（SPOC 会自动解析关联的源课程，路由 term 与源课程 term 的内容都会抓取合并），把「N 小时内即将截止」和「已过期未完成」的事件写入 `reminders.json`（格式见 `src/report.mjs`）
3. **步骤二（发送）** `scripts/notify.mjs`：读取 `reminders.json`，按 `NOTIFY_CHANNEL` 分发到 `src/channels/` 下对应渠道发送

### 通知渠道

渠道实现统一放在 `src/channels/`，按方式名命名，用 `NOTIFY_CHANNEL` 切换：

| 方式 | 模块 | 原理 | 所需配置 |
|---|---|---|---|
| `github`（默认） | `channels/github.mjs` | 向你手动创建的提醒 issue 追加评论；你是该 issue 的参与者，GitHub 会把评论通知发到你账号的通知邮箱 | 零配置（`GITHUB_TOKEN`/`GITHUB_REPOSITORY` 由 Actions 自动提供；issue 编号非必填，默认 1） |
| `mail` | `channels/mail.mjs` | SMTP 邮件 | `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`NOTIFY_TO` 等 |

**github 渠道的首次设置**（一次性，约 2 分钟）：

1. 在仓库里手动创建一个 issue（建议标题「📬 MOOC 提醒」）——注意要由**你本人**创建，这样你才是参与者、评论才会通知到你
2. 确认 issue 编号（URL 末尾数字）：新建仓库的第一个 issue 编号必然是 `1`，此时无需配置；若不是 `1`，把它存为仓库 Variable：Settings → Secrets and variables → Actions → Variables → `REMINDER_ISSUE_NUMBER`
3. 保持 GitHub 账号的通知设置中 "Participating and @mentions" 邮件通知开启（默认开启）

> 为什么不用 `GITHUB_TOKEN` 直接 @你？因为 GitHub 会压制 `github-actions[bot]` 的 @mention 通知，但**不压制** thread 参与者收到的评论通知——所以由你建 issue、bot 只评论，就能绕开压制且零 secret 管理。邮件延迟几分钟属正常；若在网页上先读了通知，邮件可能不发。

每次发布新评论后，渠道会删除超过 `COMMENT_RETENTION_DAYS`（默认 7 天）的旧 bot 评论，避免 issue 无限变长；`0` 表示只保留最新一条。删除不会撤回已经发出的通知邮件，清理失败也只记日志、不影响提醒送达。

**新增渠道**（钉钉/Telegram/PushPlus 等）：在 `src/channels/` 新建 `<名字>.mjs`，实现统一契约（`name` / `isConfigured` / `deliver` / `renderPreview`，见 `mail.mjs` 头注释），在 `channels/index.mjs` 注册一行即可，检测逻辑与其他渠道零改动。

**新增代码托管平台的 issue 通知渠道**（Gitea/GitLab/Gitee 等）：平台的 issue 评论 API 差异（路径、鉴权头、bot 识别、字段映射）收敛为 `src/channels/issue-factory.mjs` 的平台描述对象，发布、翻页清理、渲染（`src/channels/render.mjs`）等通用流程零改动，参考 `github.mjs` 写一个描述对象并注册即可。各平台渠道彼此并列、由用户用 `NOTIFY_CHANNEL` 显式选择，不做平台自动探测。仓库坐标与令牌的环境变量解析在 `src/repo-env.mjs`（平台原生变量优先，通用别名 `REPO_SLUG`/`REPO_TOKEN` 兜底）；Cookie 写回 Secret 的平台实现在 `src/secrets.mjs`（`COOKIE_REFRESH_MODE=2` 用，当前仅 GitHub）。

### Cookie 自动刷新（可选）

`COOKIE_REFRESH_MODE` 控制检测到 Cookie 失效时的行为：

| 值 | 行为 |
|---|---|
| `0` | 保持旧行为：不刷新，全部课程因鉴权失败时直接报错 |
| `1`（默认） | 用 Cookie 里的 `STUDY_PERSIST` 静默重登；刷新后完成本次拉取和提醒，但**不保存**新 Cookie |
| `2` | 同 `1`，并用 `MOOC_REFRESH_PAT` 调 GitHub API 覆盖保存 `MOOC_COOKIE` Secret |

触发条件：只有在“**所有实际拉取的课程都返回鉴权失败**”时才刷新；单门课程失败、网络错误、课程配置问题都不会触发。

刷新发生时，提醒通知的课程列表下方会附带一条说明：模式 1 提示仓库 Secret 中的 Cookie 仍是已失效的旧值、需手动更新；模式 2 提示新 Cookie 已在本次运行中写回 Secret。

刷新链路（2026-11-02 实测）：

```
GET https://www.icourse163.org/  (Cookie 中带 STUDY_PERSIST)
  → 302 /passport/logingate/changeCookie.htm?type=study&returnUrl=...
  → 200 Set-Cookie: 新的 STUDY_SESS、轮换后的 STUDY_PERSIST、STUDY_INFO
```

在 Actions 中，非敏感配置（`COOKIE_REFRESH_MODE`、`MOOC_COOKIE_SECRET_NAME`、`DUE_WINDOW_HOURS`、`OVERDUE_DAYS`、`NOTIFY_CHANNEL`、`REMINDERS_FILE`、`SMTP_SECURE`、`REMINDER_ISSUE_NUMBER`、`COMMENT_RETENTION_DAYS`）放在仓库 **Variables**；Cookie、PAT 以及 mail 渠道的 SMTP 项按现有 workflow 放在 **Secrets**（见步骤 3）。这些 Variable 留空时都回退到 `src/config.mjs` 的默认值。

模式 2 的 PAT 要求：

- 使用 **Fine-grained personal access token**；
- 只授权目标仓库；
- Repository permissions 中把 **Secrets** 设为 **Read and write**；
- 存为仓库 Secret `MOOC_REFRESH_PAT`；
- 本地运行模式 2 时还需设置 `GITHUB_REPOSITORY=owner/repo`（Actions 中自动提供；平台无关别名 `REPO_SLUG` 同样有效）。

> PAT 能修改仓库 Secret，权限较高，请只授权本仓库并定期轮换。模式 2 失败（PAT 缺失/无权限）时脚本会直接报错，不会静默跳过保存。

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
| `COOKIE_REFRESH_MODE` | `1` | Cookie 更新方式：`0` 不刷新 / `1` 刷新但仅本次使用 / `2` 刷新并写回 Secret |
| `MOOC_REFRESH_PAT` | 模式 `2` 必填 | Fine-grained PAT，目标仓库 Secrets 读写权限 |
| `MOOC_COOKIE_SECRET_NAME` | `MOOC_COOKIE` | 模式 `2` 要覆盖保存的 Secret 名称 |
| `MOOC_COURSES` | 必填（检测步骤） | 课程列表（仓库 Variable 或本地环境变量）；多门用分号或换行分隔 |
| `DUE_WINDOW_HOURS` | `48` | 即将截止提醒窗口（小时） |
| `OVERDUE_DAYS` | `3` | 已过期任务仍在提醒范围内的天数 |
| `REMINDERS_FILE` | `reminders.json` | 两步骤间传递的提醒文档路径（两步需一致） |
| `NOTIFY_CHANNEL` | `github` | 通知方式：`github` / `mail`；留空默认 `github` |
| `REMINDER_ISSUE_NUMBER` | `1` | 手动创建的提醒 issue 编号（仓库 Variable，非必填） |
| `COMMENT_RETENTION_DAYS` | `7` | github 渠道旧评论保留天数；`0` 表示只保留最新一条 |
| `REPO_TOKEN` / `REPO_SLUG` | 可选 | github 渠道的平台无关别名（等价 `GITHUB_TOKEN` / `GITHUB_REPOSITORY`）；平台原生变量优先。供非 Actions 环境/其他托管平台复用同一套配置名 |
| `COOKIE_SECRET_STORE` | `github` | 模式 `2` 的 Secret 写回实现（预留，见 `src/secrets.mjs`）；未知取值报错 |
| `SMTP_HOST` | mail 渠道必填 | SMTP 服务器 |
| `SMTP_PORT` | `465` | SMTP 端口 |
| `SMTP_SECURE` | 端口为 `465` 时 `true` | 是否使用 TLS；留空按端口推断 |
| `SMTP_USER` / `SMTP_PASS` | mail 渠道必填 | SMTP 账号与授权码（不是登录密码） |
| `SMTP_FROM` | 同 `SMTP_USER` | 发件人地址 |
| `NOTIFY_TO` | mail 渠道必填 | 收件人地址，多个用逗号分隔 |

## 已知边界

- Cookie 会过期：模式 `0` 下提醒突然变空/报 `result 为空` 时需要重新抓一次 Cookie 更新 Secret；模式 `1`/`2` 会在全部课程鉴权失败时尝试用 `STUDY_PERSIST` 自动重登
- 自动刷新依赖 `STUDY_PERSIST`；如果它也失效（例如 30 天到期、改密、主动登出），仍需手动更新 Cookie
- 未做跨次运行的去重（v1 每次运行窗口内的任务都会再提醒一次），提醒频率 = 运行频率
- SPOC 课程会额外读取公开课程介绍页来定位关联的源课程；如果平台页面改版导致解析失败，日志会给出警告并退化为只抓路由 term
- 测验的「已用尽尝试次数」或「得分>0」才视为完成；剩余尝试次数且未得分的测验会继续提醒（防止漏刷题）
- github 渠道的通知邮件由 GitHub 派发，到达时间不可控；追求即时/可靠送达用 `mail` 渠道
- 低活跃仓库的定时 workflow 可能被 GitHub 静默跳过（不排队、无运行记录）；若 Actions 页长期没有定时运行痕迹，先手动 Run workflow 验证配置本身无误
