# Design 0.3 开发验证

日期：2026-10-17。依据用户新指令移除旧图层产品与开发版格式兼容，仅保留实际源码设计。原目标仍进行中，本轮不构成已超越竞品的结论。

## 源码与运行包

旧场景文档、存储/渲染/JSON Patch、生成 worker、图层编辑器、专用模板/导出/同步及对应测试已删除；公共会话、浏览器发现、ZIP 和 JSON 验证提取为当前代码流程的独立模块，未保留旧接口转发。发布 Skill 不再引用旧文档或图层模式。AGENTS 已记录开发阶段不维护淘汰兼容分支。

项目格式为 schemaVersion 2，使用 pages/defaultPageId。旧文件只诊断、不迁移、不静默改写删除。各页面对应实际入口和安全 route，共享与专属视口明确。源文件 hash、revision、评论和版本保护保留。

隔离运行包真实 stdio 验证通过，注册33个实际工具，不再注册design_apply_changes/design_create_project/design_get_schema/design_request_generation/design_export。真实React编译、多页入口、稳定锚、CAS、重启持久化和不支持文件原文保留通过；模型推理次数0。引用验证65文件通过；Skill元数据验证通过。

## 测试与发现

首次整仓运行Design68/69通过，独立导出跨页用例失败；Workflows未失败。进一步按实际DOM终态等待后仍失败，未以增大sleep或删断言绕过。根因为query/hash原在iframe load后发送，HTML script/React模块首次执行可先读空位置。

修复在用户代码运行前注入编译器拥有的项目/修订/页面上下文，UI和独立导出复用同一helper，拒绝身份不匹配。load事件仍处理滚动与后续事件。增强原用例同时核对首次求值和当前location；相关16项回归通过。最新整仓Design74/74通过无跳过，隔离包再次通过。全仓最终退出码0；可移植性20/20，Workflows463通过、3项按既有条件跳过。

独立生成checkpoint的24项协议fixture通过：超时/取消保存未验收私有源码与截图、真实阶段、明确新worker继续、账户/修订/hash/元数据冲突、过期/容量与并发读取。该结果不替代真实模型验证；本轮没有发推理。

## IAB实际操作

专用数据目录中的项目code_3aaf5a04a6584eb1aaed49c264be9fa9，不是用户原生项目。

- 创建schema2 React项目，再按hash/revision添加实际details.html页与React页中的项目内链接。
- 在交互模式实际从React主页面跳到独立HTML详情页，页面选择与源文件随之变化。
- HTML计数器从0变1；打开AI侧栏、切源码再回设计效果后仍为1；手机iframe仍为独立0。
- 最新包revision3的详情脚本首次运行即读到?filter=attention#summary，load后收到值相同，排除了仅后续message正确的假阳性。
- 去掉旧全局CSS后，亮色焦点按钮仍为白字/rgb(54,95,69)底、rgb(43,106,71) 3px环；深色为rgb(16,35,24)字/rgb(162,207,171)底、rgb(182,226,188) 3px环。
- 当前聊天仍是默认；显式选独立模式才读取实际7项模型目录，预算10/15分钟可见。只点击读取草稿列表，真实显示无草稿，未创建模型任务。

以上是开发预览的真实MCP路径，不冒充原生宿主0.3已加载。已安装原生版本仍以实际缓存和capabilities读回为准。独立草稿续审与Motion均未完成真实模型/用户全流程验收。

## Motion研究顺序

用户已明确优先Claude Motion的REA。已追踪类型路由、实例SKILL载入、本地通用截图回看及相邻解说视频模板的独立注册归属；公开motion-render提供导出数据/播放器调用线索，但不是官方规范、没有真实player fixture，本轮不执行或复制无许可证运行时。OpenDesign Motion作为后续补充。研究不等于Motion已实现。
