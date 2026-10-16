import type { Artboard, DesignDocument, DesignNode } from "../src/model.ts";
import { findNode, type DesignPatch } from "../src/operations.ts";
import { renderArtboard } from "../src/render.ts";

export interface EditorBridge {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(text: string, context?: unknown): Promise<{ sent: boolean; reason?: string }>;
  download?(file: { filename: string; mimeType: string; dataBase64?: string; text?: string }): Promise<{ saved: boolean; unsupported?: boolean; reason?: string }>;
  openLink?(url: string): Promise<{ opened: boolean; reason?: string }>;
}
type ProjectSummary = { id: string; name: string; revision: number; updatedAt: string };
type ModelSummary = { id: string; displayName: string; isDefault?: boolean };
type VisualDirection = { id: string; name: string; summary: string };
type GenerationJob = { id: string; status: string; error?: string; [key: string]: unknown };
type SavePatches = DesignPatch[] | ((document: DesignDocument) => DesignPatch[]);

const paths: Record<string, string> = {
  cursor: "M4 3l13 8-6 1-3 6z", hand: "M6 10V6a1.5 1.5 0 013 0v4-6a1.5 1.5 0 013 0v6-5a1.5 1.5 0 013 0v6-3a1.5 1.5 0 013 0v6c0 4-3 7-7 7-3 0-5-2-6-4l-2-4a1.5 1.5 0 012.5-1.5L6 13z",
  plus: "M10 4v12M4 10h12", minus: "M4 10h12", undo: "M7 5L3 9l4 4M3 9h9a5 5 0 010 10", redo: "M13 5l4 4-4 4M17 9H8a5 5 0 000 10",
  frame: "M5 2v16M15 2v16M2 5h16M2 15h16", text: "M4 4h12M10 4v13M7 17h6", rectangle: "M3 4h14v12H3z", ellipse: "M17 10a7 6 0 11-14 0 7 6 0 0114 0z", image: "M3 3h14v14H3zM3 14l5-5 4 4 2-2 3 3M13 6h.01", button: "M3 6h14v8H3zM7 10h6", input: "M3 6h14v8H3zM6 8v4", component: "M10 2l8 8-8 8-8-8zM6 6l8 8M14 6l-8 8", unlock: "M5 9h10v9H5zM7 9V6a3 3 0 016-1",
  play: "M6 3l11 7-11 7z", stop: "M5 5h10v10H5z", download: "M10 3v10M6 9l4 4 4-4M3 14v4h14v-4", layers: "M10 2l8 5-8 5-8-5zM2 11l8 5 8-5M2 15l8 5 8-5", settings: "M4 5h12M4 10h12M4 15h12M7 3v4M13 8v4M8 13v4", chevron: "M7 4l6 6-6 6", chevronDown: "M4 7l6 6 6-6", close: "M5 5l10 10M15 5L5 15", eye: "M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6zM13 10a3 3 0 11-6 0 3 3 0 016 0z", lock: "M5 9h10v9H5zM7 9V6a3 3 0 016 0v3", trash: "M3 5h14M8 2h4l1 3M5 5l1 13h8l1-13M8 8v7M12 8v7", copy: "M7 7h10v11H7zM13 7V2H3v11h4", spark: "M10 2l2.5 5.5L18 10l-5.5 2.5L10 18l-2.5-5.5L2 10l5.5-2.5z", comment: "M3 3h14v11H9l-6 4z", history: "M3 8a7 7 0 117 9M3 3v5h5M10 6v5l3 2", arrowUp: "M10 17V3M4 9l6-6 6 6", arrowDown: "M10 3v14M4 11l6 6 6-6", fit: "M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4", panelLeft: "M2 3h16v14H2zM7 3v14", panelRight: "M2 3h16v14H2zM13 3v14", check: "M3 10l5 5L17 5", grid: "M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z", refresh: "M17 7a7 7 0 00-12-3L2 7M2 2v5h5M3 13a7 7 0 0012 3l3-3M18 18v-5h-5",
};
const icon = (name: string) => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="${paths[name] ?? paths.rectangle}"/></svg>`;
const e = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const isDocument = (value: unknown): value is DesignDocument => !!value && typeof value === "object" && "artboards" in value && Array.isArray((value as DesignDocument).artboards) && typeof (value as DesignDocument).revision === "number";

export function mountEditor(root: HTMLElement, bridge: EditorBridge) {
  let document: DesignDocument | undefined;
  let projects: ProjectSummary[] = [];
  let models: ModelSummary[] = [];
  let directions: VisualDirection[] = [];
  let selected: string[] = [];
  let artboardId = "";
  let leftTab = "layers";
  let rightTab = "design";
  let leftOpen = false;
  let rightOpen = false;
  let scale = .7;
  let offset = { x: 70, y: 70 };
  let tool = "select";
  let space = false;
  let preview = false;
  let addMenu = false;
  let modal = "";
  let newTemplate = "landing";
  let newName = "未命名设计";
  let renameName = "";
  let toast: { text: string; error: boolean } | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let state = "尚未连接宿主";
  let connected = false;
  let saving = 0;
  let disposed = false;
  let aiMode = "host";
  let aiModel = "";
  let aiDirection = "auto";
  let aiPrompt = "";
  let commentDraft = "";
  let systemDraft = "";
  let systemFormat = "css";
  let aiStatus = "";
  let aiError = false;
  let fallbackPrompt = "";
  let job: GenerationJob | undefined;
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let history: { revision: number; createdAt: string; operation?: string }[] = [];
  let collapsed = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let clipboard: DesignNode[] = [];
  let pointerCleanup: (() => void) | undefined;
  const propertyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingProperties = new Map<string, { property: string; value: unknown; projectId: string; nodeId?: string; boardId: string }>();
  let historyPending = false;

  function notify(message: string, error = false) {
    if (disposed) return;
    toast = { text: message, error };
    clearTimeout(toastTimer);
    renderToast();
    toastTimer = setTimeout(() => { toast = undefined; renderToast(); }, error ? 8500 : 3600);
  }
  function renderToast() {
    root.querySelector(".de-toast")?.remove();
    if (!toast) return;
    const node = window.document.createElement("div");
    node.className = `de-toast${toast.error ? " error" : ""}`;
    node.setAttribute("role", toast.error ? "alert" : "status");
    node.textContent = toast.text;
    root.querySelector(".de-body")?.append(node);
  }
  function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  async function call(name: string, args: Record<string, unknown>) {
    if (!connected) throw new Error("尚未连接 MCP 宿主，请从 Design 工具打开编辑器。");
    return bridge.callTool(name, args);
  }
  function currentBoard(): Artboard | undefined { return document?.artboards.find(board => board.id === artboardId) ?? document?.artboards[0]; }
  function currentNode() { return document && selected.length ? findNode(document, selected[0]!) : undefined; }
  function accept(next: DesignDocument, fit = false) {
    if (disposed) return;
    const changedProject = document?.id !== next.id;
    if (!changedProject && document && next.revision < document.revision) return;
    document = next;
    selected = selected.filter(nodeId => !!findNode(next, nodeId));
    if (!next.artboards.some(board => board.id === artboardId)) artboardId = next.artboards[0]?.id ?? "";
    const summary = { id: next.id, name: next.name, revision: next.revision, updatedAt: next.updatedAt };
    projects = [summary, ...projects.filter(project => project.id !== next.id)];
    if (changedProject) { selected = []; leftOpen = false; rightOpen = false; }
    state = "已保存";
    render();
    if (fit || changedProject) requestAnimationFrame(() => fitCanvas());
  }
  function mutate(patches: SavePatches, success?: string): Promise<void> {
    if (!document) return Promise.resolve();
    const projectId = document.id;
    const baseRevision = document.revision;
    queue = queue.then(async () => {
      if (!document || document.id !== projectId) return;
      if (typeof patches !== "function" && document.revision !== baseRevision) { notify("项目版本已更新，本次编辑尚未应用。请基于最新画布重新操作。", true); return; }
      const changes = typeof patches === "function" ? patches(document) : patches;
      if (!changes.length) return;
      saving++;
      state = "正在保存…";
      renderStatus();
      try {
        const result = await call("design_apply_changes", { projectId, expectedRevision: document.revision, patches: changes });
        if (!isDocument(result.document)) throw new Error("服务未返回有效设计文档，改动尚未确认保存。");
        accept(result.document);
        if (success) notify(success);
      } catch (error) {
        state = "保存失败";
        const message = errorMessage(error);
        notify(/revision|conflict|版本|冲突/i.test(message) ? `版本冲突：${message}。请刷新后重新应用本次编辑。` : message, true);
      } finally { saving--; renderStatus(); }
    });
    return queue;
  }
  async function refresh(fit = false, quiet = false) {
    try {
      const result = await call("design_list_projects", {});
      projects = Array.isArray(result.projects) ? result.projects as ProjectSummary[] : [];
      if (document) {
        const project = await call("design_get_project", { projectId: document.id });
        if (isDocument(project.document)) accept(project.document, fit);
      } else if (projects.length) {
        await openProject(projects[0]!.id);
      } else render();
    } catch (error) { if (!quiet) notify(errorMessage(error), true); }
  }
  async function openProject(projectId: string) {
    await queue;
    try {
      const result = await call("design_get_project", { projectId });
      if (!isDocument(result.document)) throw new Error("项目文档不可用。");
      accept(result.document, true);
    } catch (error) { notify(errorMessage(error), true); }
  }
  function renderStatus() {
    const status = root.querySelector<HTMLElement>(".de-save-state");
    if (status) { status.textContent = state; status.classList.toggle("busy", saving > 0); }
    const connection = root.querySelector<HTMLElement>("[data-connection]");
    if (connection) connection.innerHTML = `<span class="de-status-dot ${connected ? "connected" : ""}"></span>${e(connected ? "本地 MCP 已连接" : state)}`;
    const revision = root.querySelector<HTMLElement>("[data-revision]");
    if (revision) revision.textContent = document ? `修订 ${document.revision}` : "";
  }
  function field(label: string, key: string, value: unknown, type = "text", extra = "") {
    return `<label class="de-field${extra.includes("full") ? " full" : ""}">${e(label)}<input data-prop="${e(key)}" data-draft-key="prop-${e(key)}" type="${type}" value="${e(value)}" ${type === "number" ? 'step="1"' : ""}/></label>`;
  }
  function selectField(label: string, key: string, value: string, options: [string, string][], full = false) {
    return `<label class="de-field${full ? " full" : ""}">${e(label)}<select data-prop="${e(key)}">${options.map(([key, text]) => `<option value="${e(key)}"${key === value ? " selected" : ""}>${e(text)}</option>`).join("")}</select></label>`;
  }
  function colorField(label: string, key: string, value: string) {
    const resolved = document?.designSystem.tokens[value.replace(/^\$/, "")] ?? value;
    return `<label class="de-field full">${e(label)}<div class="de-color-field"><input data-prop="${e(key)}" data-draft-key="prop-${e(key)}" value="${e(value)}" placeholder="#FFFFFF 或 $color.primary"/><input type="color" aria-label="${e(label)}取色" data-prop="${e(key)}" value="${/^#[\da-f]{6}$/i.test(resolved) ? resolved : "#ffffff"}"/></div></label>`;
  }
  function nodeTree(nodes: DesignNode[], depth = 0): string {
    return nodes.map(node => {
      const open = !collapsed.has(node.id);
      return `<div class="de-layer${selected.includes(node.id) ? " selected" : ""}${node.visible === false ? " muted" : ""}" style="padding-left:${11 + depth * 14}px" data-select="${e(node.id)}" tabindex="0" role="treeitem" aria-selected="${selected.includes(node.id)}"${node.children.length ? ` aria-expanded="${open}"` : ""}>
        ${node.children.length ? `<button class="icon quiet layer-action active" data-collapse="${e(node.id)}" aria-label="${open ? "收起" : "展开"}">${icon(open ? "chevronDown" : "chevron")}</button>` : '<span style="width:10px"></span>'}${icon(node.type)}<span class="de-layer-name">${e(node.name)}</span><button class="icon quiet layer-action${node.locked ? " active" : ""}" data-lock="${e(node.id)}" title="${node.locked ? "解锁" : "锁定"}">${icon(node.locked ? "lock" : "unlock")}</button></div>
        ${open ? nodeTree(node.children, depth + 1) : ""}`;
    }).join("");
  }
  function renderLayers() {
    if (!document) return '<div class="de-empty">创建项目后，画板和图层会显示在这里。</div>';
    return `<div class="de-label-row" style="padding:10px 12px 4px"><span class="de-hint">画板 · ${document.artboards.length}</span><button class="icon quiet" data-action="add-board" title="添加画板">${icon("plus")}</button></div>${document.artboards.map(board => `<div class="de-layer-group"><div class="de-layer board${board.id === artboardId && !selected.length ? " selected" : ""}" data-board="${e(board.id)}" tabindex="0" role="treeitem">${icon("frame")}<span class="de-layer-name">${e(board.name)}</span><small style="font-size:9px;color:var(--de-muted)">${board.width}×${board.height}</small></div>${nodeTree(board.nodes)}</div>`).join("")}`;
  }
  function renderAssets() {
    if (!document) return '<div class="de-empty">先创建或打开项目。</div>';
    const tokenRows = Object.entries(document.designSystem.tokens).map(([key, value]) => {
      let resolved = value;
      const seen = new Set<string>();
      while (resolved.startsWith("$") && !seen.has(resolved)) { seen.add(resolved); resolved = document!.designSystem.tokens[resolved.slice(1)] ?? ""; }
      const property = CSS.supports("color", resolved) ? "style.fill" : /^font[.-]/i.test(key) && CSS.supports("font-family", resolved) ? "style.fontFamily" : "";
      return `<div class="de-token"><span class="de-token-swatch" data-token-color="${e(resolved)}"></span><div><div class="de-token-name">${e(key)}</div><div class="de-token-value">${e(value)}</div></div>${property ? `<button class="icon quiet" data-token="${e(key)}" data-token-prop="${property}" title="${property === "style.fill" ? "应用填充颜色" : "应用字体"}">${icon("plus")}</button>` : ""}</div>`;
    }).join("");
    return `<div class="de-section"><div class="de-section-title">图片素材</div><label class="de-add-asset">${icon("plus")}导入 PNG / JPEG / WebP<input type="file" accept="image/png,image/jpeg,image/webp" data-upload="asset" aria-label="导入图片素材"/></label><div class="de-asset-list">${document.assets.map(asset => `<button class="de-asset-card" data-asset="${e(asset.id)}" title="插入 ${e(asset.name)}"><img src="data:${e(asset.mimeType)};base64,${e(asset.data)}" alt="${e(asset.name)}"/><small>${e(asset.name)}</small></button>`).join("")}</div></div>
      <div class="de-section"><div class="de-section-title">${e(document.designSystem.name || "设计系统")}<button class="icon quiet" data-action="system" title="导入设计系统">${icon("plus")}</button></div>${tokenRows || '<p class="de-hint">导入 CSS 变量或 JSON 设计系统，即可在颜色和字体属性中使用 $token 引用。</p>'}</div>
      <div class="de-section"><div class="de-section-title">组件库</div>${document.designSystem.components.map(component => `<div class="de-component-card">${icon("component")}<span class="name">${e(component.name)}</span><button class="icon quiet" data-component="${e(component.id)}" title="插入组件实例">${icon("plus")}</button></div>`).join("") || '<p class="de-hint">选中一个元素，在属性面板中创建组件。</p>'}</div>`;
  }
  function renderComments() {
    if (!document) return '<div class="de-empty">先创建或打开项目。</div>';
    return document.comments.map(comment => {
      const node = comment.nodeId ? findNode(document!, comment.nodeId)?.node : undefined;
      const board = document!.artboards.find(board => board.id === comment.artboardId);
      return `<article class="de-comment${comment.status === "resolved" ? " resolved" : ""}"><div class="de-comment-meta"><span>${dateLabel(comment.createdAt)}</span><span style="margin-left:auto">${comment.status === "resolved" ? "已解决" : "待处理"}</span><button class="icon quiet" data-resolve="${e(comment.id)}" title="${comment.status === "resolved" ? "重新打开" : "标记已解决"}">${icon("check")}</button></div><p>${e(comment.text)}</p><button class="de-comment-anchor" data-comment-anchor="${e(comment.id)}">${icon("frame")}${e(node?.name ?? board?.name ?? "画板已移除")}</button></article>`;
    }).join("") || '<div class="de-empty"><strong>留下设计反馈</strong>选择元素或画板后添加评论。评论会与项目一起保存。</div>';
  }
  function renderInspector() {
    const found = currentNode();
    const board = currentBoard();
    if (!document || !board) return '<div class="de-empty"><strong>设计，从一个想法开始</strong>创建画板，或让当前聊天模型帮你搭建第一版。</div>';
    if (!found) {
      return `<div class="de-section"><div class="de-section-title">画板 ${icon("frame")}</div><div class="de-fields">${field("名称", "board.name", board.name, "text", "full")}${field("宽", "board.width", board.width, "number")}${field("高", "board.height", board.height, "number")}${field("X", "board.x", board.x, "number")}${field("Y", "board.y", board.y, "number")}${colorField("背景", "board.background", board.background)}</div></div>
        <div class="de-section"><div class="de-section-title">常用尺寸</div><div class="de-inline"><button data-size="1440,1000">桌面</button><button data-size="768,1024">平板</button><button data-size="390,844">手机</button></div></div>
        <div class="de-section"><div class="de-section-title">画板操作</div><div class="de-inline"><button data-action="duplicate-board">${icon("copy")}复制</button><button data-action="delete-board">${icon("trash")}删除</button></div><button style="width:100%;margin-top:8px" data-action="rename-project">重命名项目</button></div><p class="de-hint">选择画布中的元素以编辑属性。按住空格拖动画布，滚轮上下移动，⌘ / Ctrl + 滚轮缩放。</p>`;
    }
    let node = found.node;
    let source = found.node;
    const seen = new Set<string>();
    while (source.type === "component" && source.componentId && !seen.has(source.componentId)) {
      seen.add(source.componentId);
      const definition = document.designSystem.components.find(component => component.id === source.componentId)?.node;
      if (!definition) break;
      node = { ...node, text: node.text ?? definition.text, style: { ...definition.style, ...node.style }, layout: node.layout ?? definition.layout };
      source = definition;
    }
    const layout = node.layout ?? { mode: "absolute", gap: 16, padding: 16, columns: 2, align: "start", justify: "start" };
    return `${selected.length > 1 ? `<p class="de-hint">已选择 ${selected.length} 个元素。下方属性应用到首个元素；删除、复制与键盘移动应用到全部。</p>` : ""}<div class="de-section"><div class="de-section-title">${e(({ frame: "容器", text: "文本", rectangle: "矩形", ellipse: "椭圆", image: "图片", button: "按钮", input: "输入框", component: "组件实例" } as Record<string, string>)[node.type])}${icon(node.type)}</div><div class="de-fields">${field("名称", "name", node.name, "text", "full")}${field("X", "x", node.x, "number")}${field("Y", "y", node.y, "number")}${field("宽", "width", node.width, "number")}${field("高", "height", node.height, "number")}</div><label class="de-prop-check"><input type="checkbox" data-prop="visible"${node.visible !== false ? " checked" : ""}/>显示元素</label><label class="de-prop-check"><input type="checkbox" data-prop="locked"${node.locked ? " checked" : ""}/>锁定位置</label></div>
      ${["text", "button", "input", "component"].includes(node.type) ? `<div class="de-section"><div class="de-section-title">内容与文字</div><label class="de-field"><textarea data-prop="text" data-draft-key="prop-text">${e(node.text ?? "")}</textarea></label><div class="de-fields" style="margin-top:8px">${field("字号", "style.fontSize", node.style.fontSize ?? 16, "number")}${field("字重", "style.fontWeight", node.style.fontWeight ?? 400, "number")}${field("字体", "style.fontFamily", node.style.fontFamily ?? "system-ui", "text", "full")}${field("行高（倍数）", "style.lineHeight", node.style.lineHeight ?? 1.5, "number")}${selectField("对齐", "style.textAlign", node.style.textAlign ?? "left", [["left", "左对齐"], ["center", "居中"], ["right", "右对齐"], ["justify", "两端对齐"]])}${colorField("文字颜色", "style.color", node.style.color ?? "#202722")}</div></div>` : ""}
      <div class="de-section"><div class="de-section-title">外观</div><div class="de-fields">${colorField("填充", "style.fill", node.style.fill ?? "transparent")}${colorField("描边", "style.stroke", node.style.stroke ?? "none")}${field("描边宽度", "style.strokeWidth", node.style.strokeWidth ?? 0, "number")}${field("圆角", "style.radius", node.style.radius ?? 0, "number")}${field("不透明度（0–1）", "style.opacity", node.style.opacity ?? 1, "number")}</div></div>
      ${["frame", "component"].includes(node.type) || node.children.length ? `<div class="de-section"><div class="de-section-title">布局</div><div class="de-fields">${selectField("排列方式", "layout.mode", layout.mode, [["absolute", "自由定位"], ["row", "横向排列"], ["column", "纵向排列"], ["grid", "网格"]], true)}${field("间距", "layout.gap", layout.gap, "number")}${field("内边距", "layout.padding", layout.padding, "number")}${layout.mode === "grid" ? field("列数", "layout.columns", layout.columns ?? 2, "number") : ""}${selectField("交叉轴", "layout.align", layout.align ?? "start", [["start", "起点"], ["center", "居中"], ["end", "终点"], ["stretch", "拉伸"]])}${selectField("主轴", "layout.justify", layout.justify ?? "start", [["start", "起点"], ["center", "居中"], ["end", "终点"], ["space-between", "两端分布"], ["space-around", "均匀分布"]])}</div></div>` : ""}
      ${node.type === "image" ? `<div class="de-section"><div class="de-section-title">图片</div><label class="de-field">素材<select data-prop="assetId"><option value="">选择素材</option>${document.assets.map(asset => `<option value="${e(asset.id)}"${asset.id === node.assetId ? " selected" : ""}>${e(asset.name)}</option>`).join("")}</select></label><label class="de-add-asset" style="margin-top:8px">${icon("plus")}上传并替换图片<input type="file" accept="image/png,image/jpeg,image/webp" data-upload="replace" aria-label="上传并替换图片"/></label></div>` : ""}
      <div class="de-section"><div class="de-section-title">点击交互</div><div class="de-fields">${selectField("动作", "interaction.action", node.interaction?.action ?? "none", [["none", "无"], ["navigate", "跳转画板"], ["url", "打开链接"], ["toggle", "切换元素显隐"]], true)}${node.interaction?.action === "navigate" ? `<label class="de-field full">目标画板<select data-prop="interaction.target">${document.artboards.map(board => `<option value="${e(board.id)}"${board.id === node.interaction?.target ? " selected" : ""}>${e(board.name)}</option>`).join("")}</select></label>` : node.interaction?.action === "toggle" ? `<label class="de-field full">目标元素<select data-prop="interaction.target">${allNodes().map(target => `<option value="${e(target.id)}"${target.id === node.interaction?.target ? " selected" : ""}>${e(target.name)}</option>`).join("")}</select></label>` : node.interaction?.action === "url" ? field("链接（https://）", "interaction.target", node.interaction.target, "url", "full") : ""}</div></div>
      <div class="de-section"><div class="de-section-title">图层操作</div><div class="de-inline"><button data-action="move-up" title="上移一层">${icon("arrowUp")}</button><button data-action="move-down" title="下移一层">${icon("arrowDown")}</button><button data-action="duplicate" title="复制元素">${icon("copy")}</button><button data-action="delete" title="删除元素">${icon("trash")}</button></div><div class="de-inline" style="margin-top:7px"><button data-action="group">组合</button><button data-action="make-component">创建组件</button></div>${node.type === "component" ? '<p class="de-hint">组件实例跟随组件库中的源定义；实例的尺寸、位置与外观覆盖独立保存。</p>' : ""}</div>`;
  }
  function renderAI() {
    const busy = job && ["queued", "running", "starting"].includes(job.status);
    return `<div class="de-ai-card"><strong>${icon("spark")} 让想法成为设计</strong><p>描述目标、内容和风格。模型通过相同的项目工具创建和修改设计，画布编辑会持续保留。</p></div>
      <div class="de-ai-form"><label class="de-field">执行模式<select data-setting="ai-mode"><option value="host"${aiMode === "host" ? " selected" : ""}>当前聊天模型 · 默认</option><option value="codex"${aiMode === "codex" ? " selected" : ""}>独立本地 Codex</option></select></label>
      <label class="de-field">视觉方向<select data-setting="ai-direction"><option value="auto"${aiDirection === "auto" ? " selected" : ""}>自动 · 遵循需求与品牌</option>${directions.map(direction => `<option value="${e(direction.id)}"${aiDirection === direction.id ? " selected" : ""}>${e(direction.name)}</option>`).join("")}</select></label>
      ${aiMode === "codex" ? `<label class="de-field">Codex 模型<select data-setting="ai-model"><option value="">使用本地默认模型</option>${models.map(model => `<option value="${e(model.id)}"${aiModel === model.id ? " selected" : ""}>${e(model.displayName || model.id)}${model.isDefault ? "（默认）" : ""}</option>`).join("")}</select></label><p class="de-hint">复用本机 Codex 登录。任务在独立进程执行，生成结果需点击应用后写入当前项目。</p>` : '<p class="de-hint">使用打开此面板的聊天与登录。宿主支持发送消息时会将需求交给当前模型；否则提供完整提示词，复制回聊天即可继续。</p>'}
      <label class="de-field">你的设计需求<textarea data-setting="ai-prompt" data-draft-key="ai-prompt" placeholder="例如：为一家独立咖啡品牌设计首页，用暖白色与深绿色，包含品牌故事、产品卡片和订阅入口。">${e(aiPrompt)}</textarea></label><div class="de-hint">${document ? `项目：${e(document.name)} · 修订 ${document.revision}${selected.length ? ` · 已选择 ${selected.length} 个元素` : ""}` : "请先创建或打开一个项目"}</div><button class="primary" data-action="generate"${!document || busy ? " disabled" : ""}>${icon("spark")}${aiMode === "host" ? "交给当前聊天" : "开始本地生成"}</button></div>
      ${aiStatus ? `<div class="de-ai-status${aiError ? " error" : ""}" role="status">${e(aiStatus)}</div>` : ""}
      ${job ? `<div class="de-ai-status"><strong>本地任务 · ${e(job.status)}</strong>${job.error ? `<p>${e(job.error)}</p>` : ""}<div class="de-inline" style="margin-top:8px">${["completed", "succeeded", "ready"].includes(job.status) ? '<button class="primary" data-action="apply-generation">应用设计</button>' : ""}${busy ? '<button data-action="cancel-generation">停止任务</button>' : ""}<button data-action="refresh-generation">刷新状态</button></div></div>` : ""}
      ${fallbackPrompt ? `<div class="de-copy-prompt"><label class="de-field">复制以下内容到当前聊天<textarea readonly data-draft-key="fallback-prompt">${e(fallbackPrompt)}</textarea></label><button style="width:100%;margin-top:6px" data-action="copy-prompt">${icon("copy")}复制提示词</button></div>` : ""}`;
  }
  function renderModal() {
    if (!modal) return "";
    const close = '<button class="quiet" data-action="close-modal">取消</button>';
    let content = "";
    if (modal === "new") content = `<h2>创建新的设计</h2><p>从空白画板或可编辑模板开始，所有内容都会保存在本机项目库。</p><label class="de-field">项目名称<input data-setting="new-name" data-draft-key="new-name" value="${e(newName)}" maxlength="200"/></label><div class="de-template-grid">${[["blank", "空白画板", "从自己的想法开始"], ["landing", "品牌落地页", "桌面页面与真实内容"], ["dashboard", "数据看板", "卡片、图表与导航"], ["mobile", "移动应用", "手机画板与界面元素"]].map(([key, name, detail]) => `<button class="de-template${newTemplate === key ? " active" : ""}" data-template="${key}"><strong>${name}</strong><small>${detail}</small></button>`).join("")}</div><div class="de-modal-actions">${close}<button class="primary" data-action="create-project">创建项目</button></div>`;
    if (modal === "export") content = `<h2>导出设计</h2><p>导出来自当前保存的修订 ${document?.revision ?? ""}。图片与 PDF 导出由本地渲染器处理，服务会明确报告运行环境限制。</p><label class="de-field">导出范围<select data-setting="export-scope"><option value="project">整个项目</option><option value="artboard">当前画板 · ${e(currentBoard()?.name)}</option></select></label><div class="de-export-options">${[["html", "HTML", "可运行页面"], ["svg", "SVG", "包含 HTML 的 SVG"], ["png", "PNG", "位图图片"], ["pdf", "PDF", "便于分享"], ["json", "JSON", "可继续编辑的工程"], ["zip", "ZIP", "交付文件包"]].map(([format, title, detail]) => `<button data-export="${format}"><strong>${title}</strong><small>${detail}</small></button>`).join("")}</div><div class="de-modal-actions"><button data-action="close-modal">完成</button></div>`;
    if (modal === "system") content = `<h2>导入设计系统</h2><p>粘贴 CSS 自定义属性或完整 JSON 设计系统。颜色和字体属性可通过 $token 引用，组件出现在素材栏。</p><label class="de-field">格式<select data-setting="system-format"><option value="css"${systemFormat === "css" ? " selected" : ""}>CSS 变量</option><option value="json"${systemFormat === "json" ? " selected" : ""}>JSON</option></select></label><label class="de-field" style="margin-top:12px">内容<textarea data-setting="system-content" data-draft-key="system-content" style="min-height:220px" placeholder=":root { --color-primary: #406a51; --font-body: system-ui; }">${e(systemDraft)}</textarea></label><div class="de-modal-actions">${close}<button class="primary" data-action="import-system">导入</button></div>`;
    if (modal === "rename") content = `<h2>重命名项目</h2><label class="de-field">项目名称<input data-setting="rename-name" data-draft-key="rename-name" value="${e(renameName)}" maxlength="200"/></label><div class="de-modal-actions">${close}<button class="primary" data-action="save-project-name">保存名称</button></div>`;
    if (modal === "history") content = `<h2>版本历史</h2><p>每次保存都会创建版本。使用工具栏的撤销和重做在连续编辑之间返回。</p>${history.map(version => `<div class="de-history-item"><span>修订 ${version.revision}${version.revision === document?.revision ? " · 当前" : ""}${version.operation ? ` · ${e(version.operation)}` : ""}</span><time>${dateLabel(version.createdAt)}</time></div>`).join("") || '<p class="de-hint">暂无可用版本。</p>'}<div class="de-modal-actions"><button data-action="close-modal">关闭</button></div>`;
    const title = ({ new: "创建设计项目", export: "导出设计", system: "导入设计系统", rename: "重命名项目", history: "版本历史" } as Record<string, string>)[modal] ?? "设计操作";
    return `<div class="de-modal-backdrop" data-modal-backdrop><section class="de-modal" role="dialog" aria-modal="true" aria-label="${title}">${content}</section></div>`;
  }
  function render() {
    if (disposed) return;
    const active = window.document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const propertyDraftKey = active?.dataset.propertyKey;
    const draftKey = active && root.contains(active) && (!active.dataset.prop || !historyPending && !!propertyDraftKey && pendingProperties.has(propertyDraftKey)) ? active.dataset.draftKey : undefined;
    const draft = draftKey ? { key: draftKey, value: active!.value, start: active!.selectionStart, end: active!.selectionEnd } : undefined;
    const leftScroll = root.querySelector(".de-sidebar .de-panel-content")?.scrollTop ?? 0;
    const rightScroll = root.querySelector(".de-inspector .de-panel-content")?.scrollTop ?? 0;
    root.innerHTML = `<div class="de-app${preview ? " de-preview-mode" : ""}"><header class="de-topbar"><div class="de-brand"><span class="de-brand-mark">D</span><span class="hide-small">Design</span></div><div class="de-separator hide-mobile"></div><select class="de-project-select" data-setting="project" aria-label="当前项目"><option value="">${projects.length ? "选择项目" : "未创建项目"}</option>${projects.map(project => `<option value="${e(project.id)}"${project.id === document?.id ? " selected" : ""}>${e(project.name)}</option>`).join("")}<option value="__new__">＋ 新建设计</option></select><button class="icon quiet hide-mobile" data-action="new" title="新建项目">${icon("plus")}</button><span class="de-save-state"></span><div class="de-top-actions"><button class="icon quiet mobile-toggle de-mobile-toggle" data-action="toggle-left" title="图层面板">${icon("panelLeft")}</button><button class="icon quiet" data-action="undo" title="撤销 ⌘Z"${!document ? " disabled" : ""}>${icon("undo")}</button><button class="icon quiet" data-action="redo" title="重做 ⌘⇧Z"${!document ? " disabled" : ""}>${icon("redo")}</button><button class="icon quiet hide-small" data-action="history" title="版本历史"${!document ? " disabled" : ""}>${icon("history")}</button><button class="icon quiet hide-mobile" data-action="refresh" title="刷新项目">${icon("refresh")}</button><div class="de-separator hide-mobile"></div><button data-action="preview"${!document ? " disabled" : ""}>${icon(preview ? "stop" : "play")}<span class="hide-mobile">${preview ? "结束预览" : "预览"}</span></button><button class="primary" data-action="export"${!document ? " disabled" : ""}>${icon("download")}<span class="hide-mobile">导出</span></button><button class="icon quiet de-mobile-toggle" data-action="toggle-right" title="属性与 AI">${icon("settings")}</button></div></header>
      <main class="de-body${leftOpen ? " show-left" : ""}${rightOpen ? " show-right" : ""}"><aside class="de-sidebar" aria-label="项目资源"><nav class="de-tabs">${[["layers", "图层"], ["assets", "素材"], ["comments", "评论"]].map(([key, label]) => `<button data-left-tab="${key}" class="${leftTab === key ? "active" : ""}">${label}${key === "comments" && document?.comments.filter(comment => comment.status === "open").length ? ` · ${document.comments.filter(comment => comment.status === "open").length}` : ""}</button>`).join("")}</nav><div class="de-panel-content${leftTab === "layers" ? " flush" : ""}">${leftTab === "layers" ? renderLayers() : leftTab === "assets" ? renderAssets() : renderComments()}</div>${leftTab === "comments" && document ? `<div class="de-comment-composer"><label class="de-field">评论定位：${e(currentNode()?.node.name ?? currentBoard()?.name ?? "画板")}<textarea data-setting="comment" data-draft-key="comment" placeholder="记录建议或待办…">${e(commentDraft)}</textarea></label><button data-action="add-comment">${icon("comment")}添加评论</button></div>` : ""}</aside>
      <section class="de-canvas-shell${tool === "hand" ? " tool-hand" : ""}" aria-label="设计画布" tabindex="0"><div class="de-canvas-viewport"><div class="de-world"></div></div>${document ? `<span class="de-canvas-label">${e(document.name)}${preview ? " · 交互预览" : ""}</span>${preview ? `<div class="de-preview-strip"><select data-setting="preview-board" aria-label="预览画板">${document.artboards.map(board => `<option value="${e(board.id)}"${board.id === artboardId ? " selected" : ""}>${e(board.name)}</option>`).join("")}</select><button class="icon quiet" data-action="fit" title="适合视图">${icon("fit")}</button></div>` : `<div class="de-toolbar" role="toolbar" aria-label="画布工具"><button class="${tool === "select" ? "active" : ""}" data-tool="select" title="选择 V">${icon("cursor")}</button><button class="${tool === "hand" ? "active" : ""}" data-tool="hand" title="平移 H">${icon("hand")}</button><div class="de-separator"></div><button data-add="frame" title="添加容器 F">${icon("frame")}</button><button data-add="text" title="添加文本 T">${icon("text")}</button><button data-add="rectangle" title="添加矩形 R">${icon("rectangle")}</button><button data-action="add-menu" class="${addMenu ? "active" : ""}" title="更多元素">${icon("plus")}</button><div class="de-separator"></div><button data-action="ai" title="AI 设计">${icon("spark")}</button></div>${addMenu ? `<div class="de-add-menu">${[["frame", "容器"], ["text", "文本"], ["rectangle", "矩形"], ["ellipse", "椭圆"], ["image", "图片"], ["button", "按钮"], ["input", "输入框"]].map(([type, name]) => `<button data-add="${type}">${icon(type!)}${name}</button>`).join("")}<button data-action="add-board">${icon("grid")}画板</button></div>` : ""}`}<div class="de-zoom"><button data-action="zoom-out" aria-label="缩小">${icon("minus")}</button><button class="value" data-action="fit" title="适合全部画板">${Math.round(scale * 100)}%</button><button data-action="zoom-in" aria-label="放大">${icon("plus")}</button></div>` : `<div class="de-welcome"><div class="de-welcome-art" aria-hidden="true"><span></span><span></span></div><h1>把想法放到画布上</h1><p>为你的下一个产品、品牌或灵感，创建一份可以持续编辑的设计。</p><button class="primary" data-action="new">${icon("plus")}创建第一个设计</button>${!connected ? '<p class="de-hint" style="margin-top:15px">请通过 MCP 宿主打开以读取和保存项目。</p>' : ""}</div>`}</section>
      <aside class="de-inspector" aria-label="元素属性"><nav class="de-tabs"><button data-right-tab="design" class="${rightTab === "design" ? "active" : ""}">设计</button><button data-right-tab="assistant" class="${rightTab === "assistant" ? "active" : ""}">${icon("spark")}AI 助手</button></nav><div class="de-panel-content">${rightTab === "assistant" ? renderAI() : renderInspector()}</div></aside>${renderModal()}</main><footer class="de-footer"><span data-connection></span><span class="keyboard-hint">V 选择 · H 平移 · ⌘D 复制 · Delete 删除</span><span class="right" data-revision></span></footer></div>`;
    for (const control of Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-prop]"))) {
      const propertyKey = `${document?.id}:${selected[0] ?? artboardId}:${control.dataset.prop}`;
      control.dataset.propertyKey = propertyKey;
      control.dataset.projectId = document?.id ?? "";
      control.dataset.targetNode = selected[0] ?? "";
      control.dataset.targetBoard = artboardId;
      control.dataset.initialValue = JSON.stringify(control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control instanceof HTMLInputElement && control.type === "number" ? Number(control.value) : control.value);
      if (control.dataset.draftKey) control.dataset.draftKey = propertyKey;
    }
    root.querySelector('[data-action="preview"]')?.setAttribute("aria-label", preview ? "结束预览" : "预览");
    root.querySelector('[data-action="export"]')?.setAttribute("aria-label", "导出");
    root.querySelector('[data-prop="text"]')?.setAttribute("aria-label", "元素文案");
    renderWorld();
    renderStatus();
    renderToast();
    const left = root.querySelector(".de-sidebar .de-panel-content");
    const right = root.querySelector(".de-inspector .de-panel-content");
    if (left) left.scrollTop = leftScroll;
    if (right) right.scrollTop = rightScroll;
    for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-token-color]"))) {
      const value = node.dataset.tokenColor!;
      if (CSS.supports("color", value)) node.style.backgroundColor = value;
    }
    if (draft) {
      const input = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-draft-key]")).find(input => input.dataset.draftKey === draft.key);
      if (input) {
        input.value = draft.value;
        input.focus({ preventScroll: true });
        try { if (draft.start !== null) input.setSelectionRange(draft.start, draft.end); } catch { /* Numeric inputs do not support selection ranges. */ }
      }
    } else if (modal) {
      root.querySelector<HTMLElement>(".de-modal input,.de-modal select,.de-modal textarea,.de-modal button")?.focus({ preventScroll: true });
    }
  }
  function renderWorld() {
    const world = root.querySelector<HTMLElement>(".de-world");
    if (!world || !document) return;
    world.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
    const boards = preview ? [currentBoard()].filter(Boolean) as Artboard[] : document.artboards;
    world.innerHTML = boards.map(board => `<div class="de-board${board.id === artboardId && !selected.length ? " selected" : ""}" data-board-id="${e(board.id)}" style="left:${preview ? 0 : board.x}px;top:${preview ? 0 : board.y}px;width:${board.width}px;height:${board.height}px"><div class="de-board-name" data-board-drag="${e(board.id)}">${e(board.name)}</div><div class="de-board-content">${renderArtboard(document!, board.id, { interactive: preview, selection: selected })}</div></div>`).join("");
    if (leftTab === "comments" && !preview) for (const [index, comment] of document.comments.entries()) {
      if (comment.status === "resolved") continue;
      const board = document.artboards.find(board => board.id === comment.artboardId);
      if (!board) continue;
      const nodeElement = comment.nodeId ? nodeDOM(comment.nodeId) : undefined;
      const rect = nodeElement?.getBoundingClientRect();
      const worldRect = world.getBoundingClientRect();
      const pin = window.document.createElement("button");
      pin.className = "de-comment-pin";
      pin.dataset.commentAnchor = comment.id;
      pin.title = comment.text;
      pin.setAttribute("aria-label", `评论 ${index + 1}：${comment.text}`);
      pin.textContent = String(index + 1);
      pin.style.left = `${rect ? (rect.right - worldRect.left) / scale - 6 : board.x + board.width - 20}px`;
      pin.style.top = `${rect ? (rect.top - worldRect.top) / scale - 10 : board.y + 10 + index * 28}px`;
      world.append(pin);
    }
    drawSelection();
  }
  function nodeDOM(nodeId: string) {
    return Array.from(root.querySelectorAll<HTMLElement>(".de-world [data-node-id]")).find(node => node.dataset.nodeId === nodeId);
  }
  function drawSelection() {
    root.querySelectorAll(".de-selection").forEach(node => node.remove());
    if (preview || !document) return;
    const world = root.querySelector<HTMLElement>(".de-world");
    if (!world) return;
    const base = world.getBoundingClientRect();
    for (const nodeId of selected) {
      const node = nodeDOM(nodeId);
      const found = findNode(document, nodeId);
      if (!node || !found) continue;
      const box = node.getBoundingClientRect();
      const overlay = window.document.createElement("div");
      overlay.className = "de-selection";
      overlay.style.cssText = `left:${(box.left - base.left) / scale}px;top:${(box.top - base.top) / scale}px;width:${box.width / scale}px;height:${box.height / scale}px`;
      if (selected.length === 1 && !found.node.locked) overlay.innerHTML = `<span class="de-selection-label" style="transform:scale(${Math.min(1.6, 1 / scale)})">${e(found.node.name)} · ${Math.round(box.width / scale)} × ${Math.round(box.height / scale)}</span>${["nw", "ne", "sw", "se"].map(direction => `<span class="de-resize ${direction}" data-resize="${direction}" data-node="${e(nodeId)}" role="button" aria-label="调整${e(found.node.name)}尺寸"></span>`).join("")}`;
      world.append(overlay);
    }
  }
  function applyTransform() {
    const world = root.querySelector<HTMLElement>(".de-world");
    if (world) world.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
    const value = root.querySelector(".de-zoom .value");
    if (value) value.textContent = `${Math.round(scale * 100)}%`;
  }
  function zoom(next: number, point?: { x: number; y: number }) {
    const shell = root.querySelector(".de-canvas-shell");
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const center = point ?? { x: rect.width / 2, y: rect.height / 2 };
    next = Math.max(.05, Math.min(4, next));
    offset = { x: center.x - (center.x - offset.x) * next / scale, y: center.y - (center.y - offset.y) * next / scale };
    scale = next;
    applyTransform();
  }
  function fitCanvas(targetId?: string) {
    const shell = root.querySelector(".de-canvas-shell");
    if (!shell || !document?.artboards.length) return;
    const boards = preview ? [currentBoard()!] : targetId ? document.artboards.filter(board => board.id === targetId) : document.artboards;
    if (!boards.length) return;
    const minX = preview ? 0 : Math.min(...boards.map(board => board.x));
    const minY = preview ? 0 : Math.min(...boards.map(board => board.y));
    const maxX = preview ? boards[0]!.width : Math.max(...boards.map(board => board.x + board.width));
    const maxY = preview ? boards[0]!.height : Math.max(...boards.map(board => board.y + board.height));
    const rect = shell.getBoundingClientRect();
    scale = Math.max(.05, Math.min(1, (rect.width - 95) / (maxX - minX), (rect.height - 125) / (maxY - minY)));
    offset = { x: (rect.width - (maxX - minX) * scale) / 2 - minX * scale, y: 50 - minY * scale };
    applyTransform();
  }
  function allNodes(): DesignNode[] {
    const result: DesignNode[] = [];
    const visit = (nodes: DesignNode[]) => { for (const node of nodes) { result.push(node); visit(node.children); } };
    for (const board of document?.artboards ?? []) visit(board.nodes);
    return result;
  }
  function selectNode(nodeId: string, additive = false) {
    if (!document) return;
    const found = findNode(document, nodeId);
    if (!found) return;
    artboardId = found.artboard.id;
    selected = additive ? selected.includes(nodeId) ? selected.filter(value => value !== nodeId) : [...selected, nodeId] : [nodeId];
    rightTab = "design";
    render();
  }
  function makeNode(type: DesignNode["type"]): DesignNode {
    const text = type === "text" ? "把想法放到这里" : type === "button" ? "开始探索" : type === "input" ? "请输入内容" : undefined;
    return { id: id("node"), name: ({ text: "文字", frame: "容器", rectangle: "矩形", ellipse: "椭圆", image: "图片", button: "按钮", input: "输入框", component: "组件" })[type], type, x: 40, y: 40, width: type === "text" ? 260 : type === "button" ? 150 : type === "input" ? 280 : 240, height: type === "text" ? 42 : ["button", "input"].includes(type) ? 48 : 180, style: { fill: type === "text" ? "transparent" : type === "button" ? document?.designSystem.tokens["color.primary"] ? "$color.primary" : "#406a51" : type === "image" ? "#e8ede4" : "#e4ece2", color: type === "button" ? "#ffffff" : "#202722", fontSize: type === "text" ? 26 : 16, fontWeight: type === "text" ? 600 : 400, radius: ["button", "input", "frame"].includes(type) ? 12 : 0, ...(type === "input" ? { stroke: "#cbd5c7", strokeWidth: 1, fill: "#ffffff" } : {}) }, children: [], ...(text !== undefined ? { text } : {}) };
  }
  async function addNode(type: DesignNode["type"], extra?: Partial<DesignNode>) {
    if (!document || !currentBoard()) return;
    const node = { ...makeNode(type), ...extra };
    const target = currentNode();
    const parentId = target?.node.type === "frame" ? target.node.id : undefined;
    const boardId = artboardId;
    addMenu = false;
    await mutate(doc => {
      const parent = parentId ? findNode(doc, parentId) : undefined;
      const index = doc.artboards.findIndex(board => board.id === boardId);
      return index < 0 ? [] : [{ op: "add", path: parent ? `${parent.path}/children/-` : `/artboards/${index}/nodes/-`, value: node }];
    });
    selected = [node.id];
    rightTab = "design";
    render();
  }
  function remapNodes(nodes: DesignNode[], boardMapping = new Map<string, string>()): DesignNode[] {
    const copies = jsonClone(nodes);
    const mapping = new Map<string, string>();
    const assign = (value: DesignNode) => { const previous = value.id; value.id = id("node"); mapping.set(previous, value.id); value.children.forEach(assign); };
    const fix = (value: DesignNode) => { if (value.interaction?.action === "toggle" && mapping.has(value.interaction.target)) value.interaction.target = mapping.get(value.interaction.target)!; if (value.interaction?.action === "navigate" && boardMapping.has(value.interaction.target)) value.interaction.target = boardMapping.get(value.interaction.target)!; value.children.forEach(fix); };
    copies.forEach(assign); copies.forEach(fix);
    return copies;
  }
  function remapNode(node: DesignNode): DesignNode { return remapNodes([node])[0]!; }
  function topSelected(doc: DesignDocument) {
    const found = selected.map(nodeId => findNode(doc, nodeId)).filter(Boolean) as NonNullable<ReturnType<typeof findNode>>[];
    return found.filter(item => !found.some(parent => item.path.startsWith(`${parent.path}/children/`)));
  }
  async function duplicate(paste = false) {
    if (!document) return;
    const originals = paste ? clipboard : topSelected(document).map(found => found.node);
    if (!originals.length) return;
    const copies = remapNodes(originals).map(copy => { copy.x += 24; copy.y += 24; copy.name += " 副本"; return copy; });
    const boardId = artboardId;
    await mutate(doc => copies.map((copy, index) => {
      const original = !paste ? findNode(doc, originals[index]!.id) : undefined;
      const boardIndex = doc.artboards.findIndex(board => board.id === boardId);
      return { op: "add", path: original ? `${original.path.slice(0, original.path.lastIndexOf("/"))}/-` : `/artboards/${boardIndex}/nodes/-`, value: copy };
    }));
    selected = copies.map(node => node.id);
    render();
  }
  async function deleteSelection() {
    if (!document) return;
    if (!selected.length) { await deleteBoard(); return; }
    await mutate(doc => {
      const found = topSelected(doc);
      const removed = new Set<string>();
      const visit = (node: DesignNode) => { removed.add(node.id); node.children.forEach(visit); };
      found.forEach(item => visit(item.node));
      return [...cleanupReferences(doc, removed), ...found.sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true })).map(item => ({ op: "remove" as const, path: item.path }))];
    });
    selected = [];
    render();
  }
  async function deleteBoard() {
    if (!document || !currentBoard()) return;
    if (document.artboards.length === 1) { notify("项目至少需要一个画板。可以删除画板中的元素。", true); return; }
    const boardId = artboardId;
    await mutate(doc => {
      const index = doc.artboards.findIndex(board => board.id === boardId);
      const removed = new Set<string>();
      const visit = (node: DesignNode) => { removed.add(node.id); node.children.forEach(visit); };
      doc.artboards[index]?.nodes.forEach(visit);
      return [...cleanupReferences(doc, removed, boardId), { op: "remove", path: `/artboards/${index}` }];
    });
  }
  function cleanupReferences(doc: DesignDocument, removed: Set<string>, removedBoardId?: string): DesignPatch[] {
    const patches: DesignPatch[] = [];
    const visit = (nodes: DesignNode[], base: string) => nodes.forEach((node, index) => {
      const path = `${base}/${index}`;
      if (node.interaction && !removed.has(node.id) && (node.interaction.action === "toggle" && removed.has(node.interaction.target) || node.interaction.action === "navigate" && node.interaction.target === removedBoardId)) patches.push({ op: "remove", path: `${path}/interaction` });
      visit(node.children, `${path}/children`);
    });
    doc.artboards.forEach((board, index) => visit(board.nodes, `/artboards/${index}/nodes`));
    doc.designSystem.components.forEach((component, index) => {
      const walk = (node: DesignNode, path: string) => {
        if (node.interaction && (node.interaction.action === "toggle" && removed.has(node.interaction.target) || node.interaction.action === "navigate" && node.interaction.target === removedBoardId)) patches.push({ op: "remove", path: `${path}/interaction` });
        node.children.forEach((child, childIndex) => walk(child, `${path}/children/${childIndex}`));
      };
      walk(component.node, `/designSystem/components/${index}/node`);
    });
    for (let index = doc.comments.length - 1; index >= 0; index--) {
      const comment = doc.comments[index]!;
      if (comment.artboardId === removedBoardId) patches.push({ op: "remove", path: `/comments/${index}` });
      else if (comment.nodeId && removed.has(comment.nodeId)) patches.push({ op: "remove", path: `/comments/${index}/nodeId` });
    }
    return patches;
  }
  async function addBoard(duplicateBoard = false) {
    if (!document) return;
    const current = currentBoard();
    const nextId = id("artboard");
    const next: Artboard = duplicateBoard && current ? { ...jsonClone(current), id: nextId, name: `${current.name} 副本`, nodes: remapNodes(current.nodes, new Map([[current.id, nextId]])) } : { id: nextId, name: `画板 ${document.artboards.length + 1}`, x: 0, y: 0, width: 1440, height: 1000, background: "#ffffff", nodes: [] };
    next.x = Math.max(...document.artboards.map(board => board.x + board.width)) + 100;
    next.y = current?.y ?? 0;
    await mutate([{ op: "add", path: "/artboards/-", value: next }]);
    artboardId = next.id; selected = []; render(); fitCanvas(next.id);
  }
  async function setProperty(key: string, value: unknown, targetId = selected[0], boardId = artboardId) {
    if (!document) return;
    await mutate(doc => {
      if (key.startsWith("board.")) {
        const index = doc.artboards.findIndex(board => board.id === boardId);
        if ((doc.artboards[index] as unknown as Record<string, unknown>)?.[key.slice(6)] === value) return [];
        return [{ op: "replace", path: `/artboards/${index}/${key.slice(6)}`, value }];
      }
      if (!targetId) return [];
      const found = findNode(doc, targetId);
      if (!found) return [];
      if (key.startsWith("style.")) return (found.node.style as Record<string, unknown>)[key.slice(6)] === value ? [] : [{ op: "replace", path: `${found.path}/style`, value: { ...found.node.style, [key.slice(6)]: value } }];
      if (key.startsWith("layout.")) return (found.node.layout as Record<string, unknown> | undefined)?.[key.slice(7)] === value ? [] : [{ op: "add", path: `${found.path}/layout`, value: { mode: "absolute", gap: 16, padding: 16, ...found.node.layout, [key.slice(7)]: value } }];
      if (key.startsWith("interaction.")) {
        if ((found.node.interaction as Record<string, unknown> | undefined)?.[key.slice(12)] === value) return [];
        if (key === "interaction.action" && value === "none") return found.node.interaction ? [{ op: "remove", path: `${found.path}/interaction` }] : [];
        const action = key === "interaction.action" ? value as "navigate" | "url" | "toggle" : found.node.interaction?.action ?? "navigate";
        const target = key === "interaction.target" ? String(value) : action === "navigate" ? doc.artboards.find(board => board.id !== boardId)?.id ?? boardId : action === "url" ? "https://example.com" : found.node.id;
        return [{ op: "add", path: `${found.path}/interaction`, value: { action, target } }];
      }
      return (found.node as unknown as Record<string, unknown>)[key] === value ? [] : [{ op: "add", path: `${found.path}/${key}`, value }];
    });
  }
  async function historyStep(direction: "undo" | "redo") {
    if (historyPending) return;
    historyPending = true;
    for (const [key, pending] of pendingProperties) {
      clearTimeout(propertyTimers.get(key));
      if (document?.id === pending.projectId) void setProperty(pending.property, pending.value, pending.nodeId, pending.boardId);
    }
    pendingProperties.clear(); propertyTimers.clear();
    const focused = window.document.activeElement as HTMLElement | null;
    if (focused && root.contains(focused) && focused.hasAttribute("data-prop")) focused.blur();
    queue = queue.then(async () => {
      if (!document) return;
      saving++; state = direction === "undo" ? "正在撤销…" : "正在重做…"; renderStatus();
      try { const result = await call(`design_${direction}`, { projectId: document.id, expectedRevision: document.revision }); if (isDocument(result.document)) accept(result.document); }
      catch (error) { notify(errorMessage(error), true); }
      finally { saving--; renderStatus(); }
    });
    try { await queue; } finally { historyPending = false; }
  }
  async function group() {
    if (!document || selected.length < 1) return;
    const nodeId = id("node");
    await mutate(doc => {
      const found = topSelected(doc);
      if (!found.length || found.some(item => item.artboard.id !== found[0]!.artboard.id)) { notify("请在同一画板选择要组合的元素。", true); return []; }
      const parentPaths = found.map(item => item.path.slice(0, item.path.lastIndexOf("/")));
      if (parentPaths.some(path => path !== parentPaths[0])) { notify("组合需要选择同一容器内的元素。", true); return []; }
      const minX = Math.min(...found.map(item => item.node.x));
      const minY = Math.min(...found.map(item => item.node.y));
      const maxX = Math.max(...found.map(item => item.node.x + item.node.width));
      const maxY = Math.max(...found.map(item => item.node.y + item.node.height));
      const node: DesignNode = { ...makeNode("frame"), id: nodeId, name: "组合", x: minX, y: minY, width: maxX - minX, height: maxY - minY, style: { fill: "transparent" }, children: found.map(item => ({ ...jsonClone(item.node), x: item.node.x - minX, y: item.node.y - minY })) };
      const changes: DesignPatch[] = found.sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true })).map(item => ({ op: "remove", path: item.path }));
      changes.push({ op: "add", path: `${parentPaths[0]}/-`, value: node });
      return changes;
    });
    if (findNode(document, nodeId)) { selected = [nodeId]; render(); }
  }
  async function reorder(direction: number) {
    if (!document || selected.length !== 1) return;
    const targetId = selected[0]!;
    await mutate(doc => {
      const found = findNode(doc, targetId);
      if (!found) return [];
      const parts = found.path.split("/");
      const oldIndex = Number(parts.pop());
      const parentPath = parts.join("/");
      const siblings = getAt(doc, parentPath) as DesignNode[];
      const nextIndex = oldIndex + direction;
      if (nextIndex < 0 || nextIndex >= siblings.length) return [];
      return [{ op: "remove", path: found.path }, { op: "add", path: `${parentPath}/${nextIndex}`, value: jsonClone(found.node) }];
    });
  }
  function getAt(value: unknown, path: string): unknown {
    let current = value as Record<string, unknown>;
    for (const token of path.split("/").slice(1)) current = current[token.replace(/~1/g, "/").replace(/~0/g, "~")] as Record<string, unknown>;
    return current;
  }
  async function makeComponent() {
    const found = currentNode();
    if (!document || !found) return;
    const componentId = id("component");
    const source = remapNode(found.node); source.x = 0; source.y = 0;
    await mutate([{ op: "add", path: "/designSystem/components/-", value: { id: componentId, name: found.node.name, node: source } }], "组件已加入素材库");
  }
  async function upload(file: File, replace: boolean) {
    if (!document) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { notify("支持 PNG、JPEG 和 WebP 图片。", true); return; }
    if (file.size > 8 * 1024 * 1024) { notify("请选择不超过 8 MB 的图片。", true); return; }
    try {
      const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const assetId = id("asset");
      const nodeId = replace ? selected[0] : undefined;
      const asset = { id: assetId, name: file.name, mimeType: file.type, data: dataURL.slice(dataURL.indexOf(",") + 1) };
      await mutate(doc => { const patches: DesignPatch[] = [{ op: "add", path: "/assets/-", value: asset }]; const found = nodeId ? findNode(doc, nodeId) : undefined; if (found) patches.push({ op: "add", path: `${found.path}/assetId`, value: assetId }); return patches; }, "图片已导入项目");
      if (!replace) { leftTab = "assets"; render(); }
    } catch (error) { notify(errorMessage(error), true); }
  }
  async function generate() {
    if (!document || !aiPrompt.trim()) { notify("请填写设计需求。", true); return; }
    aiStatus = "正在准备设计上下文…"; aiError = false; fallbackPrompt = ""; render();
    try {
      const direction = directions.find(value => value.id === aiDirection);
      const requestPrompt = `${aiPrompt.trim()}${direction ? `\n\n视觉方向参考：${direction.name}。${direction.summary}。用户已有品牌和明确需求优先于此方向。` : ""}${selected.length ? `\n\n当前选择的元素 ID：${selected.join(", ")}。请重点处理这些元素，并保留其他内容。` : ""}\n当前画板 ID：${artboardId}`;
      const result = await call("design_request_generation", { projectId: document.id, prompt: requestPrompt, mode: aiMode, ...(aiModel && aiMode === "codex" ? { model: aiModel } : {}) });
      if (aiMode === "host") {
        const prompt = typeof result.prompt === "string" ? result.prompt : aiPrompt;
        const context = result.context ?? { projectId: document.id, revision: document.revision, selectedNodeIds: selected, artboardId };
        const delivery = await bridge.prompt(prompt, context);
        aiStatus = delivery.sent ? "已将需求发送到当前聊天。模型的工具改动会同步到此画布。" : delivery.reason ?? "当前宿主没有提供发送聊天消息的能力。请复制下方提示词回到当前聊天。";
        if (!delivery.sent) fallbackPrompt = `${prompt}\n\n设计上下文：\n${JSON.stringify(context, null, 2)}`;
      } else {
        job = result.job as GenerationJob | undefined;
        if (!job?.id) throw new Error("本地 Codex 没有返回有效任务。请检查本机 Codex 登录与可执行文件。");
        aiStatus = "本地 Codex 已启动。完成后先查看结果，再应用到当前项目。";
        scheduleJob();
      }
    } catch (error) { aiStatus = errorMessage(error); aiError = true; }
    render();
  }
  function scheduleJob() {
    clearTimeout(jobTimer);
    if (job && ["queued", "running", "starting"].includes(job.status)) jobTimer = setTimeout(() => { void refreshJob(); }, 1500);
  }
  async function refreshJob() {
    if (!job || disposed) return;
    try { const result = await call("design_get_generation", { jobId: job.id }); if (result.job) job = result.job as GenerationJob; render(); scheduleJob(); }
    catch (error) { aiStatus = errorMessage(error); aiError = true; render(); }
  }
  async function exportDesign(format: string) {
    if (!document) return;
    await queue;
    const scope = root.querySelector<HTMLSelectElement>('[data-setting="export-scope"]')?.value;
    saving++; state = "正在导出…"; renderStatus();
    try {
      const result = await call("design_export", { projectId: document.id, format, ...(scope === "artboard" ? { artboardId } : {}) });
      const filename = typeof result.filename === "string" ? result.filename : `design.${format}`;
      const mimeType = typeof result.mimeType === "string" ? result.mimeType : "application/octet-stream";
      const file = { filename, mimeType, ...(typeof result.dataBase64 === "string" ? { dataBase64: result.dataBase64 } : {}), ...(typeof result.text === "string" ? { text: result.text } : {}) };
      if (file.dataBase64 !== undefined || file.text !== undefined) {
        const download = bridge.download ? await bridge.download(file) : { saved: false, unsupported: true };
        if (download.saved) notify(`已向宿主提交下载 ${filename}`);
        else if (download.unsupported) {
          const saved = await call("design_save_export", { projectId: document.id, format, ...(scope === "artboard" ? { artboardId } : {}) });
          if (typeof saved.path !== "string") throw new Error("宿主不支持下载，且本地导出未返回保存路径。");
          notify(`已保存到 ${saved.path}`);
        } else notify(download.reason ?? "下载未完成或已取消。", true);
      } else if (typeof result.path === "string") notify(`已导出到 ${result.path}`);
      else throw new Error("导出器没有返回可下载文件或文件路径。");
    } catch (error) { notify(errorMessage(error), true); }
    finally { saving--; state = "已保存"; renderStatus(); }
  }
  async function action(name: string) {
    switch (name) {
      case "new": modal = "new"; render(); break;
      case "close-modal": modal = ""; render(); break;
      case "create-project": {
        try { const result = await call("design_create_project", { name: newName.trim() || "未命名设计", template: newTemplate }); if (!isDocument(result.document)) throw new Error("创建项目未返回文档。"); modal = ""; accept(result.document, true); }
        catch (error) { notify(errorMessage(error), true); }
        break;
      }
      case "toggle-left": leftOpen = !leftOpen; rightOpen = false; render(); break;
      case "toggle-right": rightOpen = !rightOpen; leftOpen = false; render(); break;
      case "add-menu": addMenu = !addMenu; render(); break;
      case "add-board": await addBoard(); break;
      case "duplicate-board": await addBoard(true); break;
      case "delete-board": await deleteBoard(); break;
      case "delete": await deleteSelection(); break;
      case "duplicate": await duplicate(); break;
      case "group": await group(); break;
      case "make-component": await makeComponent(); break;
      case "move-up": await reorder(-1); break;
      case "move-down": await reorder(1); break;
      case "undo": await historyStep("undo"); break;
      case "redo": await historyStep("redo"); break;
      case "refresh": await refresh(); break;
      case "fit": fitCanvas(); break;
      case "zoom-in": zoom(scale * 1.25); break;
      case "zoom-out": zoom(scale / 1.25); break;
      case "preview": preview = !preview; selected = []; render(); requestAnimationFrame(() => fitCanvas()); break;
      case "export": if (document) { modal = "export"; render(); } break;
      case "system": if (document) { modal = "system"; render(); } break;
      case "ai": rightTab = "assistant"; rightOpen = true; render(); break;
      case "history": {
        if (!document) break;
        try { const result = await call("design_history", { projectId: document.id }); history = result.versions as typeof history ?? []; modal = "history"; render(); } catch (error) { notify(errorMessage(error), true); }
        break;
      }
      case "rename-project": {
        if (!document) break;
        renameName = document.name; modal = "rename"; render();
        break;
      }
      case "save-project-name": {
        if (!renameName.trim()) { notify("项目名称不能为空。", true); break; }
        modal = "";
        await mutate([{ op: "replace", path: "/name", value: renameName.trim() }]);
        render();
        break;
      }
      case "import-system": {
        if (!document) break;
        const content = root.querySelector<HTMLTextAreaElement>('[data-setting="system-content"]')?.value;
        const format = root.querySelector<HTMLSelectElement>('[data-setting="system-format"]')?.value;
        if (!content?.trim()) { notify("请粘贴设计系统内容。", true); break; }
        try { const result = await call("design_import_system", { projectId: document.id, expectedRevision: document.revision, content, format }); if (isDocument(result.document)) { modal = ""; leftTab = "assets"; accept(result.document); notify("设计系统已导入"); } } catch (error) { notify(errorMessage(error), true); }
        break;
      }
      case "add-comment": {
        if (!document) break;
        const text = root.querySelector<HTMLTextAreaElement>('[data-setting="comment"]')?.value.trim();
        if (!text) { notify("请填写评论内容。", true); break; }
        const commentId = id("comment");
        await mutate([{ op: "add", path: "/comments/-", value: { id: commentId, artboardId, ...(selected[0] ? { nodeId: selected[0] } : {}), text, status: "open", createdAt: new Date().toISOString() } }]);
        if (document?.comments.some(comment => comment.id === commentId)) { commentDraft = ""; const input = root.querySelector<HTMLTextAreaElement>('[data-setting="comment"]'); if (input) input.value = ""; }
        break;
      }
      case "generate": await generate(); break;
      case "refresh-generation": await refreshJob(); break;
      case "cancel-generation": if (job) { try { const result = await call("design_cancel_generation", { jobId: job.id }); if (result.job) job = result.job as GenerationJob; render(); } catch (error) { notify(errorMessage(error), true); } } break;
      case "apply-generation": if (job && document) {
        try { const result = await call("design_apply_generation", { jobId: job.id, expectedRevision: document.revision }); if (isDocument(result.document)) { accept(result.document); job = undefined; aiStatus = "生成结果已应用到项目，可继续编辑。"; render(); } } catch (error) { notify(errorMessage(error), true); }
      } break;
      case "copy-prompt": {
        try { await navigator.clipboard.writeText(fallbackPrompt); notify("提示词已复制，请粘贴到当前聊天"); } catch { const textarea = root.querySelector<HTMLTextAreaElement>(".de-copy-prompt textarea"); textarea?.focus(); textarea?.select(); notify("请按 ⌘C / Ctrl+C 复制已选提示词"); }
        break;
      }
    }
  }
  function onClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (preview && target.closest(".de-board-content [data-design-action]")) { event.preventDefault(); executePreview(target); return; }
    const button = target.closest<HTMLElement>("[data-action],[data-add],[data-template],[data-left-tab],[data-right-tab],[data-tool],[data-select],[data-board],[data-collapse],[data-lock],[data-asset],[data-token],[data-component],[data-comment-anchor],[data-resolve],[data-export],[data-size]");
    if (!button || !root.contains(button) || (button as HTMLButtonElement).disabled) return;
    if (button.dataset.action) { void action(button.dataset.action); return; }
    if (button.dataset.add) { void addNode(button.dataset.add as DesignNode["type"]); return; }
    if (button.dataset.template) { newTemplate = button.dataset.template; render(); return; }
    if (button.dataset.leftTab) { leftTab = button.dataset.leftTab; render(); return; }
    if (button.dataset.rightTab) { rightTab = button.dataset.rightTab; render(); return; }
    if (button.dataset.tool) { tool = button.dataset.tool; render(); return; }
    if (button.dataset.collapse) { const value = button.dataset.collapse; if (collapsed.has(value)) collapsed.delete(value); else collapsed.add(value); render(); return; }
    if (button.dataset.select) { selectNode(button.dataset.select, event.shiftKey); return; }
    if (button.dataset.board) { artboardId = button.dataset.board; selected = []; render(); fitCanvas(artboardId); return; }
    if (button.dataset.lock && document) { const nodeId = button.dataset.lock; void mutate(doc => { const found = findNode(doc, nodeId); return found ? [{ op: "add", path: `${found.path}/locked`, value: !found.node.locked }] : []; }); return; }
    if (button.dataset.asset) { void addNode("image", { assetId: button.dataset.asset }); return; }
    if (button.dataset.token) { if (!selected.length) notify("先选择一个元素，再应用设计令牌。"); else void setProperty(button.dataset.tokenProp ?? "style.fill", `$${button.dataset.token}`); return; }
    if (button.dataset.component && document) { const component = document.designSystem.components.find(value => value.id === button.dataset.component); if (component) void addNode("component", { componentId: component.id, name: component.name, width: component.node.width, height: component.node.height, style: {} }); return; }
    if (button.dataset.resolve && document) { const commentId = button.dataset.resolve; void mutate(doc => { const index = doc.comments.findIndex(comment => comment.id === commentId); return index < 0 ? [] : [{ op: "replace", path: `/comments/${index}/status`, value: doc.comments[index]!.status === "open" ? "resolved" : "open" }]; }); return; }
    if (button.dataset.commentAnchor && document) { const comment = document.comments.find(value => value.id === button.dataset.commentAnchor); if (comment) { artboardId = comment.artboardId; selected = comment.nodeId && findNode(document, comment.nodeId) ? [comment.nodeId] : []; leftTab = "comments"; render(); fitCanvas(artboardId); } return; }
    if (button.dataset.export) { void exportDesign(button.dataset.export); return; }
    if (button.dataset.size && document) { const [width, height] = button.dataset.size.split(",").map(Number); const boardId = artboardId; void mutate(doc => { const index = doc.artboards.findIndex(board => board.id === boardId); return [{ op: "replace", path: `/artboards/${index}/width`, value: width }, { op: "replace", path: `/artboards/${index}/height`, value: height }]; }); }
  }
  function onInput(event: Event) {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (input.dataset.setting === "ai-prompt") aiPrompt = input.value;
    if (input.dataset.setting === "new-name") newName = input.value;
    if (input.dataset.setting === "rename-name") renameName = input.value;
    if (input.dataset.setting === "comment") commentDraft = input.value;
    if (input.dataset.setting === "system-content") systemDraft = input.value;
    if (input.dataset.prop && document && !historyPending && root.contains(input)) {
      const property = input.dataset.prop;
      const nodeId = input.dataset.targetNode || undefined;
      const boardId = input.dataset.targetBoard ?? artboardId;
      const projectId = input.dataset.projectId ?? document.id;
      const timerKey = input.dataset.propertyKey ?? `${projectId}:${nodeId ?? boardId}:${property}`;
      clearTimeout(propertyTimers.get(timerKey));
      const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input instanceof HTMLInputElement && input.type === "number" ? input.value === "" ? undefined : Number(input.value) : input.value;
      if (value === undefined || typeof value === "number" && !Number.isFinite(value) || JSON.stringify(value) === input.dataset.initialValue) { pendingProperties.delete(timerKey); propertyTimers.delete(timerKey); return; }
      pendingProperties.set(timerKey, { property, value, projectId, nodeId, boardId });
      propertyTimers.set(timerKey, setTimeout(() => { propertyTimers.delete(timerKey); const pending = pendingProperties.get(timerKey); pendingProperties.delete(timerKey); if (!historyPending && pending && document?.id === pending.projectId) void setProperty(pending.property, pending.value, pending.nodeId, pending.boardId); }, 450));
    }
  }
  function onChange(event: Event) {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.dataset.prop) {
      if (!root.contains(input) || historyPending) return;
      const timerKey = input.dataset.propertyKey;
      if (timerKey) { clearTimeout(propertyTimers.get(timerKey)); propertyTimers.delete(timerKey); pendingProperties.delete(timerKey); }
      const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
      if (typeof value === "number" && !Number.isFinite(value)) { notify("请输入有效数字。", true); return; }
      if (JSON.stringify(value) === input.dataset.initialValue || input.dataset.projectId !== document?.id) return;
      void setProperty(input.dataset.prop, value, input.dataset.targetNode || undefined, input.dataset.targetBoard ?? artboardId); return;
    }
    if (input.dataset.upload) { const file = (input as HTMLInputElement).files?.[0]; if (file) void upload(file, input.dataset.upload === "replace"); return; }
    switch (input.dataset.setting) {
      case "project": if (input.value === "__new__") { modal = "new"; render(); } else if (input.value) void openProject(input.value); break;
      case "ai-mode": aiMode = input.value; render(); break;
      case "ai-model": aiModel = input.value; break;
      case "ai-direction": aiDirection = input.value; break;
      case "system-format": systemFormat = input.value; break;
      case "preview-board": artboardId = input.value; render(); fitCanvas(); break;
    }
  }
  function isInput(target: EventTarget | null) { return target instanceof HTMLElement && (!!target.closest("input,textarea,select,[contenteditable=true]") || !!target.closest(".de-modal")); }
  function onKeyDown(event: KeyboardEvent) {
    if (!root.isConnected || !root.contains(event.target as Node) && !root.contains(window.document.activeElement) && event.target !== window.document.body) return;
    if (event.key === "Escape") { if (modal) modal = ""; else if (preview) preview = false; else if (leftOpen || rightOpen) { leftOpen = false; rightOpen = false; } else { selected = []; addMenu = false; } render(); return; }
    if (modal && event.key === "Tab") {
      const elements = Array.from(root.querySelectorAll<HTMLElement>(".de-modal button:not(:disabled),.de-modal input,.de-modal select,.de-modal textarea"));
      if (event.shiftKey && window.document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && window.document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
      return;
    }
    if (isInput(event.target)) return;
    if (!preview && ["Enter", " "].includes(event.key) && event.target instanceof HTMLElement) {
      const row = event.target.closest<HTMLElement>("[data-select],[data-board]");
      if (row?.dataset.select) { event.preventDefault(); selectNode(row.dataset.select, event.shiftKey); return; }
      if (row?.dataset.board) { event.preventDefault(); artboardId = row.dataset.board; selected = []; render(); fitCanvas(artboardId); return; }
    }
    if (preview && ["Enter", " "].includes(event.key) && event.target instanceof HTMLElement && event.target.closest(".de-board-content [data-design-action]")) { event.preventDefault(); executePreview(event.target); return; }
    const command = event.metaKey || event.ctrlKey;
    if (event.code === "Space") { space = true; event.preventDefault(); return; }
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); void historyStep(event.shiftKey ? "redo" : "undo"); return; }
    if (command && event.key.toLowerCase() === "y") { event.preventDefault(); void historyStep("redo"); return; }
    if (command && event.key.toLowerCase() === "d") { event.preventDefault(); void duplicate(); return; }
    if (command && event.key.toLowerCase() === "c" && document && selected.length) { clipboard = topSelected(document).map(found => jsonClone(found.node)); event.preventDefault(); notify(`已复制 ${clipboard.length} 个元素`); return; }
    if (command && event.key.toLowerCase() === "v" && clipboard.length) { event.preventDefault(); void duplicate(true); return; }
    if (command && event.key.toLowerCase() === "a" && currentBoard()) { selected = currentBoard()!.nodes.map(node => node.id); event.preventDefault(); render(); return; }
    if (preview) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); void deleteSelection(); return; }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selected.length && document) {
      const amount = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
      const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
      event.preventDefault();
      void mutate(doc => topSelected(doc).filter(found => !found.node.locked).flatMap(found => [{ op: "replace", path: `${found.path}/x`, value: found.node.x + dx }, { op: "replace", path: `${found.path}/y`, value: found.node.y + dy }]));
      return;
    }
    if (!command) switch (event.key.toLowerCase()) { case "v": tool = "select"; render(); break; case "h": tool = "hand"; render(); break; case "f": void addNode("frame"); break; case "t": void addNode("text"); break; case "r": void addNode("rectangle"); break; case "0": fitCanvas(); break; }
  }
  function onKeyUp(event: KeyboardEvent) { if (event.code === "Space") space = false; }
  function onWheel(event: WheelEvent) {
    const target = event.target as HTMLElement;
    const shell = target.closest<HTMLElement>(".de-canvas-shell");
    if (!shell || !root.contains(shell)) return;
    event.preventDefault();
    const rect = shell.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) zoom(scale * Math.exp(-event.deltaY * .008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    else { offset.x -= event.deltaX; offset.y -= event.deltaY; applyTransform(); }
  }
  function executePreview(target: HTMLElement) {
    if (!document) return;
    const actionNode = target.closest<HTMLElement>("[data-design-action]");
    if (actionNode?.dataset.designAction === "navigate" && document.artboards.some(board => board.id === actionNode.dataset.designTarget)) { artboardId = actionNode.dataset.designTarget!; render(); fitCanvas(); }
    else if (actionNode?.dataset.designAction === "toggle") { const node = nodeDOM(actionNode.dataset.designTarget!); if (node) node.hidden = !node.hidden; }
    else if (actionNode?.dataset.designAction === "url") { const url = actionNode.dataset.designTarget!; if (/^(https?:\/\/|mailto:)/i.test(url)) {
      if (bridge.openLink) void bridge.openLink(url).then(result => { if (!result.opened) notify(result.reason ?? "宿主未打开该链接。", true); }).catch(error => notify(errorMessage(error), true));
      else notify("当前宿主未提供外部链接入口。请导出 HTML 后测试此链接。", true);
    } }
  }
  function beginPointer(event: PointerEvent) {
    if (!document || event.button > 1) return;
    const target = event.target as HTMLElement;
    const shell = target.closest<HTMLElement>(".de-canvas-shell");
    if (!shell || target.closest(".de-toolbar,.de-zoom,.de-preview-strip,.de-add-menu,.de-comment-pin")) return;
    if (preview) return;
    pointerCleanup?.();
    const start = { x: event.clientX, y: event.clientY };
    const boardDrag = target.closest<HTMLElement>("[data-board-drag]");
    const resize = target.closest<HTMLElement>("[data-resize]");
    const nodeElement = target.closest<HTMLElement>("[data-node-id]");
    const pan = space || tool === "hand" || event.button === 1;
    if (pan) {
      event.preventDefault();
      shell.classList.add("panning");
      const before = { ...offset };
      const move = (event: PointerEvent) => { offset = { x: before.x + event.clientX - start.x, y: before.y + event.clientY - start.y }; applyTransform(); };
      const finish = () => { shell.classList.remove("panning"); pointerCleanup?.(); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
      pointerCleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); pointerCleanup = undefined; };
      return;
    }
    if (boardDrag) {
      const boardId = boardDrag.dataset.boardDrag!;
      const board = document.artboards.find(board => board.id === boardId)!;
      artboardId = boardId; selected = [];
      const before = { x: board.x, y: board.y };
      const wrapper = boardDrag.closest<HTMLElement>(".de-board")!;
      let dx = 0; let dy = 0;
      const move = (event: PointerEvent) => { dx = Math.round((event.clientX - start.x) / scale); dy = Math.round((event.clientY - start.y) / scale); wrapper.style.left = `${before.x + dx}px`; wrapper.style.top = `${before.y + dy}px`; };
      const finish = () => { pointerCleanup?.(); if (dx || dy) void mutate(doc => { const index = doc.artboards.findIndex(board => board.id === boardId); return [{ op: "replace", path: `/artboards/${index}/x`, value: before.x + dx }, { op: "replace", path: `/artboards/${index}/y`, value: before.y + dy }]; }); else render(); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
      pointerCleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); pointerCleanup = undefined; }; event.preventDefault(); return;
    }
    if (!nodeElement && !resize) { const board = target.closest<HTMLElement>(".de-board"); if (board?.dataset.boardId) artboardId = board.dataset.boardId; selected = []; render(); return; }
    const nodeId = resize?.dataset.node ?? nodeElement!.dataset.nodeId!;
    const found = findNode(document, nodeId);
    if (!found) return;
    if (event.shiftKey && !resize) { selectNode(nodeId, true); event.preventDefault(); return; }
    if (!selected.includes(nodeId)) { artboardId = found.artboard.id; selected = [nodeId]; rightTab = "design"; }
    if (found.node.locked) { render(); return; }
    const parentPath = found.path.slice(0, found.path.lastIndexOf("/"));
    const parentNode = /\/children$/.test(parentPath) ? getAt(document, parentPath.slice(0, -9)) as DesignNode : undefined;
    const autoLayout = !!parentNode?.layout && parentNode.layout.mode !== "absolute";
    const targets = resize ? [found] : topSelected(document).filter(value => !value.node.locked);
    const before = targets.map(value => ({ id: value.node.id, x: value.node.x, y: value.node.y, width: value.node.width, height: value.node.height }));
    const direction = resize?.dataset.resize;
    let dx = 0; let dy = 0; let changed = false;
    render();
    const move = (event: PointerEvent) => {
      dx = Math.round((event.clientX - start.x) / scale); dy = Math.round((event.clientY - start.y) / scale);
      if (!direction && autoLayout) return;
      changed = Math.abs(dx) + Math.abs(dy) > 0;
      for (const original of before) {
        const node = nodeDOM(original.id); if (!node) continue;
        if (direction) {
          const width = Math.max(1, original.width + (direction.includes("w") ? -dx : dx));
          const height = Math.max(1, original.height + (direction.includes("n") ? -dy : dy));
          node.style.width = `${width}px`; node.style.height = `${height}px`;
          if (!autoLayout) { node.style.left = `${original.x + (direction.includes("w") ? original.width - width : 0)}px`; node.style.top = `${original.y + (direction.includes("n") ? original.height - height : 0)}px`; }
        } else { node.style.left = `${original.x + dx}px`; node.style.top = `${original.y + dy}px`; }
      }
      drawSelection();
    };
    const finish = () => {
      pointerCleanup?.();
      if (!changed) { if (autoLayout && (dx || dy)) notify("此元素由自动布局定位，请在图层操作中调整顺序。"); return; }
      void mutate(doc => before.flatMap(original => {
        const current = findNode(doc, original.id); if (!current) return [];
        if (!direction) return [{ op: "replace", path: `${current.path}/x`, value: original.x + dx }, { op: "replace", path: `${current.path}/y`, value: original.y + dy }];
        const width = Math.max(1, original.width + (direction.includes("w") ? -dx : dx));
        const height = Math.max(1, original.height + (direction.includes("n") ? -dy : dy));
        const patches: DesignPatch[] = [{ op: "replace", path: `${current.path}/width`, value: width }, { op: "replace", path: `${current.path}/height`, value: height }];
        if (!autoLayout) patches.push({ op: "replace", path: `${current.path}/x`, value: original.x + (direction.includes("w") ? original.width - width : 0) }, { op: "replace", path: `${current.path}/y`, value: original.y + (direction.includes("n") ? original.height - height : 0) });
        return patches;
      }));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
    pointerCleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); pointerCleanup = undefined; };
    event.preventDefault();
  }
  function doubleClick(event: MouseEvent) {
    if (preview || !document) return;
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    if (!node) return;
    const found = findNode(document, node.dataset.nodeId!);
    if (!found || !["text", "button", "input", "component"].includes(found.node.type)) return;
    selected = [found.node.id]; rightTab = "design"; rightOpen = true; render();
    const input = root.querySelector<HTMLTextAreaElement>('[data-prop="text"]'); input?.focus(); input?.select();
  }
  function receive(result: unknown) {
    if (!result || typeof result !== "object") return;
    const wrapper = result as Record<string, unknown>;
    const data = wrapper.structuredContent && typeof wrapper.structuredContent === "object" ? wrapper.structuredContent as Record<string, unknown> : wrapper;
    const next = isDocument(data.document) ? data.document : isDocument(data) ? data : undefined;
    if (next && (!document || next.id === document.id)) accept(next);
    else if (typeof data.projectId === "string" && !document) void openProject(data.projectId);
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (disposed) return;
    refreshTimer = setTimeout(async () => {
      if (connected && document && !saving && !pointerCleanup && !modal && !window.document.hidden) {
        try { const result = await call("design_get_project", { projectId: document.id }); if (isDocument(result.document) && result.document.revision > document.revision) accept(result.document); } catch { /* Host disconnection is reported through the bridge lifecycle. */ }
      }
      scheduleRefresh();
    }, 3500);
  }
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("pointerdown", beginPointer);
  root.addEventListener("dblclick", doubleClick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const resizeObserver = new ResizeObserver(() => { drawSelection(); });
  resizeObserver.observe(root);
  render();
  return {
    connecting() { state = "正在连接宿主…"; renderStatus(); },
    async connected() {
      if (disposed) return;
      connected = true; state = "已连接"; renderStatus();
      const results = await Promise.allSettled([refresh(), call("design_list_models", {}), call("design_get_guidance", {})]);
      const modelResult = results[1];
      if (modelResult.status === "fulfilled" && Array.isArray(modelResult.value.models)) models = modelResult.value.models as ModelSummary[];
      const guidanceResult = results[2];
      if (guidanceResult.status === "fulfilled" && Array.isArray(guidanceResult.value.directions)) directions = guidanceResult.value.directions as VisualDirection[];
      render(); scheduleRefresh();
    },
    disconnected(error: unknown) { connected = false; state = `连接不可用：${errorMessage(error)}`; renderStatus(); notify(state, true); },
    async setProjectId(projectId: string) { if (document?.id !== projectId && connected) await openProject(projectId); },
    receive,
    async teardown() {
      disposed = true;
      clearTimeout(toastTimer); clearTimeout(jobTimer); clearTimeout(refreshTimer); pointerCleanup?.(); resizeObserver.disconnect();
      for (const timer of propertyTimers.values()) clearTimeout(timer); propertyTimers.clear(); pendingProperties.clear();
      root.removeEventListener("click", onClick); root.removeEventListener("input", onInput); root.removeEventListener("change", onChange); root.removeEventListener("wheel", onWheel); root.removeEventListener("pointerdown", beginPointer); root.removeEventListener("dblclick", doubleClick); window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp);
      await queue;
    },
  };
}
