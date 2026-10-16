import { randomUUID } from "node:crypto";
import { validateDocument } from "./model.ts";
import type { Artboard, DesignDocument, DesignNode, NodeStyle } from "./model.ts";

export const TEMPLATE_NAMES = ["blank", "landing", "dashboard", "mobile"] as const;
export type TemplateName = typeof TEMPLATE_NAMES[number];

const identifier = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export function createTemplate(name: string, template: TemplateName = "blank"): DesignDocument {
  if (!TEMPLATE_NAMES.includes(template)) throw new Error(`Unknown design template: ${template}`);
  const now = new Date().toISOString();
  const buttonComponentId = identifier("component");
  const makeNode = (type: DesignNode["type"], nodeName: string, x: number, y: number, width: number, height: number, style: NodeStyle = {}, text?: string): DesignNode => ({
    id: identifier("node"), name: nodeName, type, x, y, width, height, style, children: [], ...(text === undefined ? {} : { text }),
  });
  const text = (content: string, x: number, y: number, width: number, size = 20, color = "$color.text"): DesignNode => makeNode("text", content.slice(0, 40), x, y, width, size * 2, { color, fontSize: size, fontFamily: "$font.body", lineHeight: 1.4 }, content);
  const rectangle = (nodeName: string, x: number, y: number, width: number, height: number, fill = "$color.surface", radius = 16): DesignNode => makeNode("rectangle", nodeName, x, y, width, height, { fill, radius });
  const button = (label: string, x: number, y: number, width = 180): DesignNode => ({ ...makeNode("component", label, x, y, width, 52, {}, label), componentId: buttonComponentId });
  const board = (boardName: string, width: number, height: number, x = 0, nodes: DesignNode[] = []): Artboard => ({ id: identifier("artboard"), name: boardName, x, y: 0, width, height, background: "$color.background", nodes });
  const document: DesignDocument = {
    schemaVersion: 1,
    id: identifier("design"), name, revision: 1, createdAt: now, updatedAt: now,
    designSystem: {
      name: "Design 基础系统",
      tokens: { "color.primary": "#635bff", "color.background": "#f6f7fb", "color.surface": "#ffffff", "color.text": "#172033", "color.muted": "#667085", "color.border": "#e4e7ec", "font.body": "Inter, Arial, sans-serif" },
      components: [{ id: buttonComponentId, name: "主要按钮", node: makeNode("button", "主要按钮", 0, 0, 180, 52, { fill: "$color.primary", color: "#ffffff", radius: 12, fontSize: 16, fontWeight: 600 }, "开始使用") }],
    },
    artboards: [], assets: [], comments: [],
  };
  if (template === "blank") document.artboards.push(board("画板 1", 1440, 900));
  if (template === "landing") {
    const desktop = board("首页 · 桌面", 1440, 1050, 0, [text("FORM / STUDIO", 80, 40, 400, 20), text("把想法变成\n可以触摸的设计", 100, 200, 850, 64), text("统一设计语言，让每一次迭代都有清晰的起点。", 104, 410, 700, 22, "$color.muted"), button("开始创作", 104, 492), rectangle("功能卡片 1", 100, 650, 390, 260), rectangle("功能卡片 2", 525, 650, 390, 260), rectangle("功能卡片 3", 950, 650, 390, 260), text("设计系统", 130, 690, 300, 26), text("交互原型", 555, 690, 300, 26), text("持续迭代", 980, 690, 300, 26)]);
    const mobile = board("首页 · 手机", 390, 844, 1520, [text("FORM / STUDIO", 24, 28, 340, 18), text("把想法变成\n可以触摸的设计", 24, 142, 342, 38), text("统一设计语言，让每一次迭代\n都有清晰的起点。", 24, 326, 342, 18, "$color.muted"), button("开始创作", 24, 440, 342), rectangle("设计系统卡片", 24, 550, 342, 220), text("设计系统", 48, 580, 290, 26)]);
    document.artboards.push(desktop, mobile);
  }
  if (template === "dashboard") {
    const dashboard = board("工作台", 1440, 1000, 0, [rectangle("侧边栏", 0, 0, 240, 1000, "$color.surface", 0), text("工作空间", 32, 40, 180, 24), text("概览", 32, 140, 180, 18), text("项目", 32, 196, 180, 18, "$color.muted"), text("概览", 288, 44, 700, 36), text("你的团队正在创造新的可能。", 290, 110, 800, 18, "$color.muted"), rectangle("项目统计", 288, 190, 340, 150), rectangle("成员统计", 660, 190, 340, 150), rectangle("进度统计", 1032, 190, 340, 150), text("进行中项目", 312, 214, 280, 18, "$color.muted"), text("12", 312, 260, 280, 40), text("团队成员", 684, 214, 280, 18, "$color.muted"), text("8", 684, 260, 280, 40), text("本周完成", 1056, 214, 280, 18, "$color.muted"), text("86%", 1056, 260, 280, 40), rectangle("项目列表", 288, 380, 1084, 480), text("最近项目", 320, 410, 700, 24), text("品牌网站改版", 320, 490, 700, 20), text("移动端体验优化", 320, 570, 700, 20), text("组件库升级", 320, 650, 700, 20)]);
    const settings = board("工作空间设置", 1440, 1000, 1520, [text("工作空间设置", 100, 80, 1000, 36), rectangle("设置面板", 100, 180, 1000, 540), text("工作空间名称", 140, 224, 500, 18), makeNode("input", "名称输入框", 140, 278, 700, 52, { fill: "$color.background", color: "$color.text", radius: 8, fontSize: 18 }, "我的工作空间"), button("保存设置", 140, 588)]);
    const settingsLink = text("设置", 32, 252, 180, 18, "$color.muted"); settingsLink.interaction = { action: "navigate", target: settings.id }; dashboard.nodes.push(settingsLink);
    document.artboards.push(dashboard, settings);
  }
  if (template === "mobile") {
    const welcome = board("欢迎", 390, 844, 0, [rectangle("品牌图形", 108, 140, 174, 174, "$color.primary", 44), text("一起发现\n生活中的灵感", 32, 382, 326, 38), text("记录、整理和分享你的每一个好想法。", 32, 510, 326, 18, "$color.muted")]);
    const feed = board("灵感列表", 390, 844, 470, [text("我的灵感", 24, 52, 340, 30), rectangle("第一张卡片", 24, 128, 342, 248), text("周末的城市漫步", 44, 304, 300, 22), rectangle("第二张卡片", 24, 404, 342, 248), text("属于你的安静角落", 44, 580, 300, 22)]);
    const details = board("灵感详情", 390, 844, 940, [rectangle("封面", 0, 0, 390, 350, "$color.primary", 0), text("周末的城市漫步", 24, 398, 342, 30), text("慢下来，发现日常中\n那些被忽略的细节。", 24, 488, 342, 20, "$color.muted"), button("收藏灵感", 24, 720, 342)]);
    const start = button("开始探索", 32, 690, 326); start.interaction = { action: "navigate", target: feed.id }; welcome.nodes.push(start);
    const first = feed.nodes[1]; if (first) first.interaction = { action: "navigate", target: details.id };
    const back = text("← 返回列表", 24, 32, 300, 18, "#ffffff"); back.interaction = { action: "navigate", target: feed.id }; details.nodes.push(back);
    document.artboards.push(welcome, feed, details);
  }
  return validateDocument(document);
}
