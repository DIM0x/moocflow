<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/moocflow-title-dark.svg">
    <img src="assets/moocflow-title.svg" alt="moocflow" width="380">
  </picture>
</h1>

<p align="center">基于 GitHub workflow 云端周期性检查中国大学 MOOC（icourse163.org）各类任务，截止时间临近时通过 GitHub 通知等途径提醒你。</p>

## 参考项目

[MOOC_reminder](https://github.com/furina061006/MOOC_reminder)  是一个轻量无后端的 Chrome / Edge 浏览器扩展，在浏览器内实时追踪 icourse163.org 上未完成的作业与考试，并在任务即将到期前提供桌面通知。

moocflow的任务读取与判断逻辑大量参考了此项目。

## 项目特性

- **零服务器、零运维**：完全运行在 GitHub Actions 上，按北京时间每天 08:00 / 18:00 自动执行，不需要公网服务器，也不需要电脑或浏览器常开。
- **MOOC 与 SPOC 全覆盖**：兼容三种课程链接写法；全量抓取测验、作业、考试；SPOC 自动抓取关联的源课程，不会只看到一半任务。
- **个性化配置**：开箱即用的同时，提醒窗口（默认 48 小时）、过期任务的提示天数、旧提醒评论的保留期、Cookie 刷新策略等可按需调整。
- **提醒直达 GitHub 通知**：可借助 GitHub issue 的通知邮件送达，不需要额外的推送服务。
- **可扩展的提醒方式**：检测与发送解耦，通知渠道以插件形式实现（内置 GitHub issue 评论与 SMTP 邮件），按统一接口新增渠道即可接入。
- **配置与代码分离**：课程列表、Cookie 等只保存在仓库的 Variables / Secrets 中，不产生提交，更新代码不受影响。
- **Cookie 自动续期**：Cookie 失效时可自动尝试静默重登，减少手动更新的频率。
- **隐私友好**：无后端，你的 Cookie 只保存在你自己的仓库 Secret 中；全部代码开源，可自行审计。
- **运行轻量**：为GitHub Action Runners减负。

## 快速开始

最简化配置仅需5步，一次配置60天自动运行。

### 1. Fork 本仓库

点击页面右上角的 **Fork**，以默认设置把仓库复制到你自己的账号下。

### 2. 创建一个提醒用的 issue

在 Fork 后的仓库中，点击 **Issues → New issue**，标题随意（例如「慕课提醒」，此标题会在你收到的邮件中显示），直接提交即可。
**这个 issue 必须由你本人创建**，这样后续评论的通知才会发到你。

创建后确认一下 issue 编号是 `1`（地址栏最后的数字：例如 `.../issues/1` 中的 `1`）。新建仓库的第一个 issue 编号必然是 `1`，正常情况下无需其他操作。

### 3. 准备 Cookie

1. 在浏览器中登录 [icourse163.org](https://www.icourse163.org)；

2. 按 `F12` 打开开发者工具，切到 **Network（网络）** 面板并刷新页面；

3. 点击发往 `www.icourse163.org` 的请求，在 **Request Headers** 中找到 `Cookie`，右键选择复制（需完整复制，包含 `NTESSTUDYSI`、`STUDY_SESS` 以及与登录身份相关的项）。

> [!CAUTION]
> 此 Cookie 有权限直接登录并操作你的慕课账号，且其中部分字段**可能没有有效的手动过期方式**，一旦泄露有可能无法将对方强制下线。
>
> 本项目已尽量避免泄露用户Cookie。配置时，请勿把 Cookie 粘贴到聊天工具、截图或公开 Issue 中，也不要自行保存Cookie副本；怀疑泄露时，请尝试重新登录及修改密码。

### 4. 填写仓库配置

进入你 Fork 后的仓库：**Settings → Secrets and variables → Actions**。

在 **Variables** 标签页新建：

| 名称 | 值 |
| --- | --- |
| `MOOC_COURSES` | 你的课程 URL，每行一个，在课程内任意页面复制均可 |

在 **Secrets** 标签页新建：

| 名称 | 值 |
| --- | --- |
| `MOOC_COOKIE` | 第 3 步复制的完整 Cookie 串 |

> 如果收不到提醒邮件，请确认 GitHub 账号的通知设置中 **Participating and @mentions** 处于开启状态（默认开启）。

### 5. 手动运行一次验证

进入 **Actions → mooc deadline reminder → Run workflow →确定**。运行成功后，你创建的 issue 中会出现一条提醒评论（没有需要提醒的任务时不会评论），之后就会按计划自动运行。

需要配置更多高级选项？访问 **[Wiki](https://github.com/DIM0x/moocflow/wiki)** 查看更多说明。

> [!IMPORTANT]
> 根据Github行为，每当仓库无提交活动满60天后，其workflow运行会暂时禁用。若需继续使用，请根据禁用提示邮件指引或手动前往Actions页面，点击一次启用按钮即可。

> [!TIP]
> 若提醒邮件中出现cookie过期提示，请及时重做上述步骤3更新cookie。

## 更新

如果你是通过 Fork 使用本项目，更新非常简单：打开你 Fork 后的仓库，点击 **Sync fork → Update branch** 即可同步最新代码。课程列表与 Cookie 保存在仓库设置中，同步更新不会覆盖它们。

## 贡献与反馈

欢迎一起把 moocflow 做得更好：

- **贡献代码**：修复 bug、改进任务抓取与截止判断，或者新增提醒方式。检测与发送已经解耦，在 `src/channels/` 下按统一接口实现新渠道（如钉钉、Telegram 等），再注册一行即可接入。做前先提交Issue，完成后提交 Pull Request 即可。
- **反馈问题**：遇到漏抓任务、误报、Action 运行失败等情况，欢迎到 [Issues](https://github.com/DIM0x/moocflow/issues) 提交。请尽量附上课程类型（MOOC / SPOC）、报错日志或截图，方便快速定位。
