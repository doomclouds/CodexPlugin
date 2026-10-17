# 前端原型微交互

用于真实 HTML、React、TSX 和 CSS 原型中的状态反馈、展开、hover/focus 与局部转场。当前能力边界是可运行前端；独立 Motion 时间线、场景工程、视频渲染和 MP4 导出未实现。不要据本页把网页动效说成视频产品。

## 先写清动作因果

给每个必要动作确定：谁触发、哪个真实对象变化、变化后是什么、用户何时能继续、如何取消或返回。只有能说明关系或反馈的动态才保留；静止状态和减少动态模式也应完整表达内容。

| 用途 | 合适的反馈 | 检查重点 |
| --- | --- | --- |
| 按压、选择与切换 | 及时改变实际状态，必要时辅以短过渡 | 高频连续操作不排队、不等待表演 |
| 展开、详情与返回 | 让目标与来源关系清楚，必要内容仍可到达 | 键盘焦点与返回位置保持可理解 |
| 提交与完成 | 等待来自真实任务，完成来自实际结果 | 旋转图标或动画结束不等于成功 |
| 过程解释 | 每一步对应真实机制，允许停留和重看 | 静止时能读到阶段与关键条件 |
| 品牌表现 | 一个有内容依据的动作形成节奏 | 主行动不被入场动画阻塞，正文不先透明隐藏 |

高频工具的响应优先及时；解释过程才考虑较长的停留。先用浏览器已有 CSS 和事件实现能说明问题的最小动作，不为“高级感”加入新动画库。已有真实库与项目合同需要时再复用，依赖与资产仍应随项目封闭。

## 可运行的局部反馈起点

下面的短过渡只影响按钮自身。实际点击、禁用与业务状态由 HTML 或组件事件负责；这个 CSS 不会自动实现保存。

```css
.action-feedback {
  --feedback-time: 140ms;
  --feedback-ease: cubic-bezier(.2, .8, .2, 1);
  transition: transform var(--feedback-time) var(--feedback-ease);
}
@media (hover: hover) and (pointer: fine) {
  .action-feedback:not(:disabled):hover { transform: translateY(-1px); }
}
.action-feedback:not(:disabled):active { transform: translateY(0); }
.action-feedback:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .action-feedback { transition: none; transform: none; }
  .action-feedback:not(:disabled):hover,
  .action-feedback:not(:disabled):active { transform: none; }
}
```

`140ms` 是需要按任务验证的起点，不是所有动作的强制时长。焦点轮廓独立于 hover，触摸不依赖悬停才看见内容。减少动态时去掉位移，保留颜色、边界、文字与实际状态；不要用极小但不断循环的动画伪装替代。

## 保持操作与生命周期正确

不要使用 `transition: all` 把宽高、布局与交互状态一起拖慢。通常优先有明确目的的 transform 或局部颜色变化；它们仍需在实际内容下检查，不能只凭属性名声称流畅。

动画开始不应夺走当前输入或重建整个表单。重复触发要替换或合并过时反馈，不能把旧操作的动画结果写到新对象；异步响应绑定目标和请求身份。需要 JavaScript 动画或 Canvas 时，按组件生命周期停止自己拥有的计时器与帧回调，取消过时任务，并处理页面不活动和减少动态偏好。原型处于隔离运行环境时，不假定外部资源、存储或后端可用。

有顺序展示的内容，先把信息在静止 DOM 中放好；增强失败后仍可读。避免滚动劫持、必须等入场结束才能点击、靠位移动画表示错误而没有文字、用虚假进度条承诺不存在的完成时间。

## 看连续过程，也看结果

实际执行一次及连续触发，核对对象状态、焦点、取消与返回；再以减少动态偏好执行同一路径，检查内容和动作仍成立。需要窄屏或触摸时重复相关路径。静态截图检查文字、对比和最终布局，连续观看检查节奏与因果；两种证据分别报告。导出网页后重开同一路径，不能把编辑器中的动效通过当作交付物通过。
