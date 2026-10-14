# 产品图标

图标由内置 Image Gen 生成，保留原始 PNG 和真实透明 alpha。Workflows 的侧栏版本按比例导出为 128 × 128 PNG，保留图形与透明背景；未用代码重画图形。

- 插件商城：四块互相拼接的圆角模块，表达独立插件与组合扩展。
- Workflows：四个圆角方形节点及分支汇合路径，表达动态编排；替换原来的环形圆球图标。
- 共用蓝、青、紫色与粗实轮廓，不使用文字、底板或第三方品牌标志。透明背景供深浅主题复用。
- 插件商城保持原始资源；Workflows 保留新生成的 RGBA PNG，并提供单独的 128 × 128 侧栏资源，避免把大图重复放入 MCP 工具目录。

下面的深浅背景图片是上一版图标的开发检查，不能代替新版 Codex 侧栏验收。新版通过标准 MCP server、tool 和 resource 图标字段提供；侧栏最终显示仍须在加载新版后核对。

[深浅背景与尺寸检查](icon-theme-preview.png)

## Workflows 0.4 图标调整

从原图保留青、蓝、紫配色，改为四个圆角方形节点组成的分支汇合图；线条加粗，减少细节以适配 24–32 px 侧栏。要求真实透明背景、一个居中图形，不包含文字、底板、阴影或旋涡。

面板标准操作图标使用 Tabler Icons v3.35.0 的原始 SVG，MIT 许可证随图标放在插件 `assets/icons/`。构建时嵌入 CSS，资源不依赖开发目录或外部请求。[Tabler Icons 来源](https://github.com/tabler/tabler-icons/tree/v3.35.0)。

## 插件商城提示词

```text
Use case: logo-brand
Asset type: product icon for a developer plugin marketplace, square PNG with genuine transparent alpha background.
Primary request: Create one polished, original, compact app symbol representing a marketplace of modular plug-in extensions.
Subject: Four interlocking rounded geometric modules arranged into one coherent compact pinwheel or cross, with bold small tab-and-socket connections and clean central negative space. The modules should read as compatible building blocks rather than a literal jigsaw picture.
Style/medium: Refined flat digital brand mark, precise crisp edges, substantial rounded shapes, very subtle tonal depth within the shapes only. It must look like a finished software product icon, quiet and modern.
Composition/framing: Exactly one centered icon on a square canvas. Icon occupies about 76% of canvas, with balanced clear padding on every side. Strong silhouette readable when rendered at 24, 32, and 64 px.
Color palette: Restrained cool cobalt blue, turquoise teal, and soft violet; saturated enough to remain clear on both near-black and white app backgrounds. No white or black enclosing tile.
Family style: A companion Workflows product uses broad branching paths and rounded nodes in this same cobalt-teal-violet family, so use the same substantial shape weight, corner softness, and restrained polish.
Constraints: Actual transparent background, no backdrop, no outer tile, no shadow behind the icon, no delicate outlines, no micro-detail. One mark only, no grid of variations.
Text: none.
Avoid: Letters, words, labels, watermark, screenshots, UI controls, gradients fading into background, glossy 3D plastic, mascots, shopping carts, bags, OpenAI logos, Claude logos, or other existing brand marks.
```

## Workflows 提示词

```text
Use case: logo-brand
Asset type: product icon for Workflows, a dynamic multi-agent workflow orchestration plugin, square PNG with genuine transparent alpha background.
Primary request: Create one polished, original, compact app symbol representing a workflow that dynamically branches and converges.
Subject: A compact diamond-shaped composition of four substantial rounded nodes: a left origin node, an upper branch node, a lower branch node, and a right result node. Two broad smooth paths split from the left through the upper and lower nodes and join at the right. Keep this as one distinctive abstract brand symbol, with simple clear negative space between the two routes.
Style/medium: Refined flat digital brand mark, precise crisp edges, substantial rounded shapes, very subtle tonal depth within the shapes only. It must look like a finished software product icon, quiet and modern.
Composition/framing: Exactly one centered icon on a square canvas. Icon occupies about 76% of canvas, with balanced clear padding on every side. Strong silhouette readable when rendered at 24, 32, and 64 px.
Color palette: Restrained cool cobalt blue, turquoise teal, and soft violet; saturated enough to remain clear on both near-black and white app backgrounds. No white or black enclosing tile.
Family style: A companion developer plugin marketplace uses interlocking rounded modules in this same cobalt-teal-violet family, so use the same substantial shape weight, corner softness, and restrained polish.
Constraints: Actual transparent background, no backdrop, no outer tile, no shadow behind the icon, no delicate outlines, no tiny arrows, no micro-detail. One mark only, no grid of variations.
Text: none.
Avoid: Letters, words, labels, watermark, screenshots, UI controls, gradients fading into background, glossy 3D plastic, mascots, OpenAI logos, Claude logos, or other existing brand marks.
```
