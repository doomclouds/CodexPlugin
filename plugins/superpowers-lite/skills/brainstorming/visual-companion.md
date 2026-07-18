# 视觉伴侣指南

在浏览器中展示原型、图示和选项的视觉头脑风暴伴侣。

## 何时使用

按问题判断，不要按整个会话判断。判断标准是：**用户看到它会不会比读文字更容易理解？**

内容本身是视觉问题时，**使用浏览器**：

- **UI 原型**——线框图、布局、导航结构、组件设计；
- **架构图**——系统组件、数据流、关系图；
- **并排视觉比较**——比较布局、配色或设计方向；
- **视觉打磨**——外观、间距、视觉层级；
- **空间关系**——以图示呈现的状态机、流程图、实体关系。

内容是文字或表格时，**使用终端**：

- **需求与范围问题**——“X 是什么意思？”、“哪些功能在范围内？”；
- **概念性的 A/B/C 选择**——从文字描述的方案中选择；
- **取舍列表**——优缺点、对比表；
- **技术决策**——API 设计、数据建模、架构方案选择；
- **澄清问题**——答案是文字而非视觉偏好的问题。

涉及 UI 的问题不一定是视觉问题。“你想要哪类向导？”是概念问题，用终端；“这些向导布局哪个更合适？”才是视觉问题，用浏览器。

## 工作原理

服务器监视一个 HTML 目录，并在浏览器中提供最新文件。你把 HTML 内容写入 `screen_dir`，用户在浏览器中查看并点击选项；选择会记录到 `state_dir/events`，供下一轮读取。

**内容片段与完整文档：** 如果 HTML 文件以 `<!DOCTYPE` 或 `<html` 开头，服务器会原样提供，只注入辅助脚本；否则服务器使用框架模板自动包装内容，补充页头、CSS 主题、连接状态与交互基础设施。**默认编写内容片段。** 只有需要完全控制页面时才写完整文档。

## 启动会话

只有当前运行环境能保持本地服务器存活并把 URL 暴露给用户时，才使用此伴侣。如果环境不支持，跳过伴侣并在终端继续头脑风暴；视觉工具不可用不应阻塞设计讨论。

```bash
# 用户批准伴侣后再启动。--open 会在首个画面出现时自动打开浏览器；
# --project-dir 会持久化原型，并允许复用端口重启。
scripts/start-server.sh --project-dir /path/to/project --open

# 返回：{"type":"server-started","port":52341,
#        "url":"http://localhost:52341/?key=ab12…",
#        "screen_dir":"/path/to/project/.superpowers/brainstorm/12345-1706000000/content",
#        "state_dir":"/path/to/project/.superpowers/brainstorm/12345-1706000000/state"}
```

保存响应中的 `screen_dir` 与 `state_dir`。使用 `--open` 后，推送首个画面时浏览器会自动打开；无需再让用户手动打开，但仍要提供 URL 作为无头或远程环境的后备。

**URL 包含会话密钥（`?key=…`）。** 服务器拒绝没有密钥的请求，所以必须把 `url` 字段中的**完整 URL**交给用户。不要删除查询字符串，也不要提供裸 `http://host:port`。密钥同时保护 HTTP 与 WebSocket，避免其他标签页或局域网设备读取画面、注入事件。首次加载后浏览器会通过 Cookie 记住密钥，因此刷新和 `/files/*` 资源无需重复密钥。

**查找连接信息：** 服务器把启动 JSON 写入 `$STATE_DIR/server-info`。后台启动而未捕获标准输出时，读取该文件获取 URL 与端口。使用 `--project-dir` 时，在 `<project>/.superpowers/brainstorm/` 下查找会话目录。

**注意：** 把项目根目录传给 `--project-dir`，使原型保存在 `.superpowers/brainstorm/` 并跨重启留存。不传时，文件写入 `/tmp` 并在停止时清理。如果 `.superpowers/` 尚未忽略，提醒用户把它加入 `.gitignore`。

**Codex：**

```bash
# Codex 会回收后台进程。脚本检测到 CODEX_CI 后自动切换到前台模式，
# 正常运行即可，不需要额外参数。
scripts/start-server.sh --project-dir /path/to/project --open
```

**平台无关降级：** 如果当前运行环境无法让本地服务器跨轮次存活，或无法把浏览器 URL 暴露给用户，就跳过视觉伴侣，继续使用文字讨论；不要让可视化能力阻塞头脑风暴。

浏览器无法访问 URL 时（远程或容器环境很常见），绑定非回环地址：

```bash
scripts/start-server.sh \
  --project-dir /path/to/project \
  --host 0.0.0.0 \
  --url-host localhost
```

使用 `--url-host` 控制返回 URL 中显示的主机名。

## 交互循环

1. **确认服务器仍存活**，再把 HTML 写入 `screen_dir` 的新文件：
   - **提到 URL 或推送画面前，必须确认服务器存活。** 检查 `$STATE_DIR/server-info` 存在且 `$STATE_DIR/server-stopped` 不存在。若已停止，使用相同 `--project-dir` 重启 `start-server.sh`；服务器会复用端口，用户已打开的标签页会自动重连，并在停机期间显示“已暂停”遮罩，无需发送新 URL。服务器空闲 4 小时后自动退出，可用 `--idle-timeout-minutes` 配置。
   - 使用语义化文件名，如 `platform.html`、`visual-style.html`、`layout.html`。
   - **不要复用文件名**，每个画面都使用新文件。
   - 使用文件创建工具，**不要使用 cat/heredoc**，避免把内容倾倒到终端。
   - 服务器自动提供最新文件。

2. **告诉用户将看到什么，然后结束当前轮次：**
   - 每一步都提醒 URL，而不是只在第一步提醒；
   - 简要描述画面，例如“主页有 3 个布局选项”；
   - 请用户在终端回复：“请查看后告诉我你的想法；也可以点击选择一个选项。”

3. **下一轮用户回复后：**
   - 如果 `$STATE_DIR/events` 存在，读取其中按 JSON 行记录的浏览器交互；
   - 与用户的终端文字合并，形成完整反馈；
   - 终端消息是主要反馈，`state_dir/events` 提供结构化补充。

4. **迭代或推进：** 如果反馈改变当前画面，写一个新文件，例如 `layout-v2.html`；当前步骤验证后才进入下一个问题。

5. **返回终端时卸载画面：** 下一步不需要浏览器时，推送等待画面，清除已经过期的内容：

   ```html
   <!-- 文件名：waiting.html（后续可用 waiting-2.html 等） -->
   <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
     <p class="subtitle">正在终端中继续……</p>
   </div>
   ```

   这能避免对话已推进时，用户仍盯着已解决的选择。下一个视觉问题出现时，再推送新画面。

6. 重复，直到完成。

## 编写内容片段

只写页面内容。服务器会用框架模板自动包装，补充页头、主题 CSS、连接状态和交互基础设施。

**最小示例：**

```html
<h2>哪种布局更合适？</h2>
<p class="subtitle">请考虑可读性和视觉层级</p>

<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>单栏</h3>
      <p>干净、聚焦的阅读体验</p>
    </div>
  </div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content">
      <h3>双栏</h3>
      <p>侧栏导航配合主内容区</p>
    </div>
  </div>
</div>
```

无需 `<html>`、CSS 或 `<script>` 标签，服务器会补齐。

## 可用 CSS 类

框架模板为内容提供以下 CSS 类。

### 选项（A/B/C 选择）

```html
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>标题</h3>
      <p>说明</p>
    </div>
  </div>
</div>
```

**多选：** 在容器上添加 `data-multiselect`，允许用户选择多个选项。每次点击会切换该项的选中样式。

```html
<div class="options" data-multiselect>
  <!-- 选项标记相同，用户可以选择或取消多个项目 -->
</div>
```

### 卡片（视觉设计）

```html
<div class="cards">
  <div class="card" data-choice="design1" onclick="toggleSelect(this)">
    <div class="card-image"><!-- 原型内容 --></div>
    <div class="card-body">
      <h3>名称</h3>
      <p>说明</p>
    </div>
  </div>
</div>
```

### 原型容器

```html
<div class="mockup">
  <div class="mockup-header">预览：仪表板布局</div>
  <div class="mockup-body"><!-- 原型 HTML --></div>
</div>
```

### 分栏视图（并排）

```html
<div class="split">
  <div class="mockup"><!-- 左侧 --></div>
  <div class="mockup"><!-- 右侧 --></div>
</div>
```

### 优缺点

```html
<div class="pros-cons">
  <div class="pros"><h4>优点</h4><ul><li>收益</li></ul></div>
  <div class="cons"><h4>缺点</h4><ul><li>代价</li></ul></div>
</div>
```

### 原型元素（线框构建块）

```html
<div class="mock-nav">标志 | 首页 | 关于 | 联系</div>
<div style="display: flex;">
  <div class="mock-sidebar">导航</div>
  <div class="mock-content">主内容区</div>
</div>
<button class="mock-button">操作按钮</button>
<input class="mock-input" placeholder="输入字段">
<div class="placeholder">占位区域</div>
```

### 排版与章节

- `h2`——页面标题；
- `h3`——章节标题；
- `.subtitle`——标题下的辅助文本；
- `.section`——带下边距的内容块；
- `.label`——小号大写标签文本。

## 浏览器事件格式

用户点击浏览器选项时，交互以每行一个 JSON 对象的形式记录到 `$STATE_DIR/events`。推送新画面后文件会自动清空。

```jsonl
{"type":"click","choice":"a","text":"选项 A - 简洁布局","timestamp":1706000101}
{"type":"click","choice":"c","text":"选项 C - 复杂网格","timestamp":1706000108}
{"type":"click","choice":"b","text":"选项 B - 混合方案","timestamp":1706000115}
```

完整事件流会展示用户的探索路径；最终决定前可能点击多个选项。最后一个 `choice` 事件通常是最终选择，但点击模式也可能暴露犹豫或偏好，值得追问。

如果 `$STATE_DIR/events` 不存在，说明用户没有在浏览器中交互，只使用终端文字。

## 设计提示

- **让保真度匹配问题**——布局问题用线框图，视觉打磨问题才使用精细原型；
- **每页都说明问题**——写“哪种布局更专业？”，不要只写“选一个”；
- **迭代后再推进**——反馈改变当前画面时，先写新版；
- **每屏最多 2～4 个选项**；
- **重要时使用真实内容**——摄影作品集应使用实际图片；占位内容会掩盖设计问题；
- **保持原型简单**——聚焦布局和结构，不追求像素级完成度。

## 文件命名

- 使用语义化名称，如 `platform.html`、`visual-style.html`、`layout.html`；
- 不要复用文件名，每个画面都新建文件；
- 迭代时添加版本后缀，如 `layout-v2.html`、`layout-v3.html`；
- 服务器按修改时间提供最新文件。

## 清理

```bash
scripts/stop-server.sh $SESSION_DIR
```

如果会话使用 `--project-dir`，原型文件会保存在 `.superpowers/brainstorm/` 供以后参考。只有 `/tmp` 会话会在停止时删除。

## 参考

- 框架模板（CSS 参考）：[`scripts/frame-template.html`](scripts/frame-template.html)
- 客户端辅助脚本：[`scripts/helper.js`](scripts/helper.js)
