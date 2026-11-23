# 提示词优化 · Prompt Polisher

> 一个 DeepSeek Harness（DSH）插件：把输入框里写得很粗糙的草稿，改写成更清晰、更结构化、可以直接发出去的 Prompt。先看差异，再决定是否替换输入框。

[English](#english) · [MIT License](#许可证)

## 功能

- 输入框左侧一个 ✦ 按钮，点开就是小窗，不改动输入框内容。
- **结合当前对话**：读取当前会话这一分支可见的最近几轮用户消息与助手回复，把「按第二种来」「刚才说的那块」解析成具体任务，只给一个推荐稿。
- **快速改写**：只看草稿本身，给出结构化 / 任务单 / 精简三个版本。
- 差异 / 全文两种视图；差异按 token 级别标出增删。
- 「替换输入框」写入前会校验：草稿、会话、模式、会话历史版本任一变化，旧结果即失效；正在校验或重新生成时按钮禁用。
- 输入框里有 `@` 引用卡片时，优先按原位置把引用映射进新文本；只要有一个引用无法保留，就禁用整段替换并说明原因，复制仍然可用。
- 改写只补结构，不编事实：缺失信息写成 `[文件夹路径]` 这类占位符；指代无法确定时只加一条「待确认：……」。
- 不做自动发送：是否发送始终由你按回车决定。

## 环境依赖

- 已安装并启用的 DeepSeek Harness（Web / Desktop 均可），版本需支持 Cordis 插件与 `conversation.input.left` 插槽。
- Node.js 20+（DSH 自带运行时即可）。
- 不需要额外 npm 依赖；插件本身零依赖。

## 安装

插件以本地 bundle 的形式安装。仓库里的 `package.json` 名称是 `@local/dsh-prompt-polisher`，`private: true`，不发布到 npm。

### 方式一：在 DSH 会话里安装（推荐）

把仓库克隆到任意目录，然后在 DSH 会话里把绝对路径交给 Agent：

```bash
git clone https://github.com/1kang12345/prompt-polisher.git
```

```
用 plugin_manager install_bundle 安装 D:\path\to\prompt-polisher
```

安装成功会看到 `application: applied`，并在 profile 的 `package.json` 中新增依赖与 bundle 条目。重启 DSH 或等待热加载后生效。

### 方式二：手动加入 profile

编辑 `~/.dsh/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": {
    "@local/dsh-prompt-polisher": "file:/absolute/path/to/prompt-polisher"
  },
  "dsh": {
    "bundles": ["@local/dsh-prompt-polisher"]
  }
}
```

然后在 profile 目录执行 `pnpm install`，重启 DSH。

> 修改 `index.js`（Host 半）后需要在 DSH 里重新加载插件；修改 `client.js`（Web 半）后刷新页面即可。

## 快速开始

1. 打开任意会话，在输入框写一句想做的事，例如：

   ```text
   帮我把这个文件夹的图片按日期改名，别弄坏原文件
   ```

2. 点输入框左侧的 ✦。
3. 小窗顶部会显示这一轮实际参考了什么：
   - `已参考最近 N 轮`
   - `已参考最近 N 轮（部分截断）`
   - `当前仅依据草稿`
   - `会话不可读取，已退回纯草稿`
4. 用「差异 / 全文」检查改写结果，点「替换输入框」写回，或点「复制」自己处理。
5. 勾选「停顿后快速改写」后，停止输入约 1.2 秒会自动用快速模式改写一次；自动模式只发草稿，不读会话。

## 两种模式

| 模式 | 读取内容 | 输出 |
| --- | --- | --- |
| 结合当前对话（默认） | 当前分支可见的最近 6 轮用户/助手文本，总预算 7000 字符 | 一个推荐稿 |
| 快速改写 | 只有当前草稿 | 结构化 / 任务单 / 精简三个版本 |

上下文被压缩时，用户提问优先保留；助手长回答保留开头、计划列表和结尾结论，并在小窗里标记「部分截断」，不会把裁剪过的上下文说成完整的。

## 目录结构

```text
prompt-polisher/
├── index.js            # Host 半：/health、/rewrite、/verify 路由，读会话、调模型、校验版本
├── client.js           # Web 半：composer 按钮、小窗、差异视图、写回草稿
├── package.json        # DSH bundle 声明与 exports
├── cordis.patch.yml    # 把插件插入 DSH 组合
├── locale/
│   ├── zh.json         # 插件市场中文标题/描述
│   └── en.json
├── icon.svg            # 插件图标
├── README.md
└── LICENSE
```

`docs/` 下是本地截图，已在 `.gitignore` 中排除，不随仓库发布。

## 配置项

插件没有设置界面，以下常量写在源码里，改动后重新加载插件生效：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTEXT_TURNS` | `6` | 最多参考的对话轮数 |
| `CONTEXT_CHAR_BUDGET` | `7000` | 送进模型的上下文总字符预算 |
| `MAX_DRAFT_CHARS` | `12000` | 单次草稿上限 |
| `MIN_DRAFT_CHARS` | `4` | 低于该长度不发起改写 |
| `REQUEST_TIMEOUT_MS` | `180000` | Host 侧单次请求超时 |
| 小窗宽度 | `240–560 px` | 跟随输入框卡片缩放 |

## 隐私与安全

- Host 只读取当前会话 `surface.nodes` 对应的可见文本消息，不读工具调用、附件内容，也不跨会话检索。
- 每个请求先过 `ctx.get('connection').admit()`（浏览器会话 cookie），再用 `sessions.get(sessionId)` 确认会话存在；两者都通过才读取历史。
- 插件不写文件、不落盘会话内容，也不含遥测。
- 会话 id 来自浏览器端，Host 只把它当定位符；DSH 的 `sessions` 服务没有跨用户的归属映射，因此同机另一浏览器若拿到会话 id 仍可读取该会话（单用户本地场景下的边界）。

## 已知边界

- 改写使用当前会话选中的模型与推理等级；输出 token 上限交给模型适配层。
- 模型返回 max-tokens 截断或非法 JSON 时按可重试错误处理，不会把半截内容写进输入框。
- 浏览器断开连接会中止 Host 侧仍在跑的模型请求。
- 引用保留依赖 `@` 引用在新文本里仍以字面出现；模型把路径改写/意译时会退回「禁用替换 + 可复制」。
- 只处理文本，不带附件、不读文件内容。

## 开发与验证

```bash
node --check index.js
node --check client.js
```

改动 Host 半后，在 DSH 里禁用再启用插件；改动 Web 半后刷新页面。建议至少手动过一遍：带 `@` 引用的替换、改草稿后的失效提示、切换会话后的旧结果清理。

## 贡献

- 提 Issue 时请附 DSH 版本、复现步骤、期望结果和实际结果。
- 提 PR 前跑一遍上面的语法检查，并说明是否改动了 `/rewrite` 的请求/响应字段。
- 不要提交 token、cookie、个人绝对路径或会话内容；`.gitignore` 已排除日志、临时截图和测试输出。

## 许可证

[MIT](LICENSE) © 2026 1kang12345

---

## English

A zero-dependency DeepSeek Harness plugin that rewrites the current composer draft into a clearer, executable prompt. It offers a context-aware mode (reads recent visible turns of the current branch and resolves references) and a draft-only quick mode (three variants). A floating panel shows a token-level diff; replacing the draft is explicit, version-checked, and blocked while a result is stale or an `@` reference cannot be preserved.

Install it as a local DSH bundle (see the Chinese section for commands), then click the ✦ button in the composer. MIT licensed.
