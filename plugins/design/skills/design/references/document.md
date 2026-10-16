# 文档参考

`design_get_schema` 返回当前运行时的完整文档结构。每个项目都有 `schemaVersion: 1`、稳定 `id`、`name`、递增 `revision`、创建和更新时间、设计系统、画板、图片资产与评论。

画板具有 ID、名称、画布坐标、尺寸、背景和节点数组。节点具有 ID、类型、名称、相对父级的坐标、尺寸、样式及子节点。类型包含 frame、text、rectangle、ellipse、image、button、input 和 component。frame 可使用 absolute、row、column 或 grid 布局。

颜色、字体和阴影可引用 `$color.primary` 等设计令牌。组件实例用 `componentId` 引用设计系统中的组件。图片用 `assetId` 引用资产。图层 ID 必须唯一；引用和交互目标必须存在；组件不能循环引用。

修改使用 JSON Pointer 路径。例如读取当前文档确认第一个画板的第一个节点确实是目标标题后：

```json
{
  "projectId": "project-id",
  "expectedRevision": 1,
  "patches": [
    { "op": "replace", "path": "/artboards/0/nodes/0/text", "value": "新的标题" }
  ]
}
```

数组新增可用末尾的 `-`。不允许通过 patch 修改项目身份、revision 和时间戳。更新整份设计时仍须遵循基础版本检查。

交互使用 `interaction: { "action": "navigate", "target": "artboard-id" }` 在画板间导航；`url` 打开 HTTP(S) 链接；`toggle` 切换指定节点的可见性。交互在预览和导出的 HTML 中生效。
