# 测试反模式

**加载时机：** 编写或修改测试、增加 mock，或想在生产代码中添加测试专用方法时。

## 概述

测试必须验证真实行为，而不是 mock 的行为。Mock 是隔离手段，不是测试对象。

**核心原则：测试代码做了什么，不要测试 mock 做了什么。**

## 三条硬规则

```
1. 绝不测试 mock 行为
2. 绝不向生产类添加测试专用方法
3. 不理解依赖就绝不 mock
```

## 反模式一：测试 mock 行为

**错误做法：**

```typescript
// ❌ BAD: Testing that the mock exists
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

这只证明 mock 存在，不证明组件正常工作。Mock 在就通过，不在就失败，对真实行为没有任何说明。

**修复：**

```typescript
// ✅ GOOD: Test real component or don't mock it
test('renders sidebar', () => {
  render(<Page />);  // Don't mock sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// OR if sidebar must be mocked for isolation:
// Don't assert on the mock - test Page's behavior with sidebar present
```

### 门禁问题

断言任何 mock 元素前，问：“我在测试真实组件行为，还是只测试 mock 存在？”

如果只是测试 mock 存在，立即停止：删除断言或取消该 mock，改测真实行为。

## 反模式二：生产代码中的测试专用方法

**错误做法：**

```typescript
// ❌ BAD: destroy() only used in tests
class Session {
  async destroy() {  // Looks like production API!
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... cleanup
  }
}

// In tests
afterEach(() => session.destroy());
```

这会用测试专用代码污染生产类；方法可能在生产环境被误调用，还会混淆对象生命周期与实体生命周期。

**修复：**

```typescript
// ✅ GOOD: Test utilities handle test cleanup
// Session has no destroy() - it's stateless in production

// In test-utils/
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// In tests
afterEach(() => cleanupSession(session));
```

### 门禁问题

给生产类添加方法前：

1. 这个方法是否只被测试调用？如果是，放入测试工具。
2. 这个类是否拥有该资源的生命周期？如果不是，它就不属于这个类。

## 反模式三：不理解依赖就 mock

**错误做法：**

```typescript
// ❌ BAD: Mock breaks test logic
test('detects duplicate server', () => {
  // Mock prevents config write that test depends on!
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // Should throw - but won't!
});
```

被 mock 的方法包含测试依赖的副作用——写配置。为了“安全”过度 mock 会破坏真实行为，使测试因错误原因通过或神秘失败。

**修复：**

```typescript
// ✅ GOOD: Mock at correct level
test('detects duplicate server', () => {
  // Mock the slow part, preserve behavior test needs
  vi.mock('MCPServerManager'); // Just mock slow server startup

  await addServer(config);  // Config written
  await addServer(config);  // Duplicate detected ✓
});
```

### 门禁问题

Mock 任何方法前先停止并回答：

1. 真实方法有哪些副作用？
2. 当前测试是否依赖这些副作用？
3. 我是否完全理解测试需要什么？

如果测试依赖副作用，在更低层 mock 真正缓慢或外部的操作，或使用保留必要行为的测试替身；不要 mock 测试本身依赖的高层方法。如果不确定，先用真实实现运行，观察必要行为，再在正确层级添加最小 mock。

以下想法都是红旗：“为了安全先 mock”、“它可能很慢，最好 mock”、“不用理解依赖链也能 mock”。

## 反模式四：不完整的 mock

**错误做法：**

```typescript
// ❌ BAD: Partial mock - only fields you think you need
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // Missing: metadata that downstream code uses
};

// Later: breaks when code accesses response.metadata.requestId
```

局部 mock 会隐藏结构假设。下游可能依赖被省略的字段，导致测试通过、集成失败，并制造虚假信心。

**硬规则：mock 现实中的完整数据结构，不要只包含当前测试碰巧使用的字段。**

**修复：**

```typescript
// ✅ GOOD: Mirror real API completeness
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // All fields real API returns
};
```

### 门禁问题

创建 mock 响应前，检查真实 API 响应有哪些字段：

1. 查看实际响应、文档或示例；
2. 包含系统下游可能消费的全部字段；
3. 验证 mock 完整匹配真实响应模式。

不确定时，包含所有已记录字段。

## 反模式五：把集成测试当收尾事项

**错误做法：**

```
✅ 实现完成
❌ 没写测试
“可以交给测试了”
```

测试是实现的一部分，不是可选后续；没有测试就无法声称完成。

**修复：**

```
TDD 循环：
1. 编写失败测试
2. 最小实现使其通过
3. 重构
4. 然后才声称完成
```

## Mock 何时过于复杂

警告信号：

- Mock 设置比测试逻辑更长；
- 为了让测试通过而 mock 一切；
- Mock 缺少真实组件拥有的方法；
- Mock 一改，测试就坏。

此时应认真考虑：使用真实组件的集成测试，往往比复杂 mock 更简单。

## TDD 如何预防这些反模式

1. **先写测试**——迫使你思考真正要验证什么；
2. **亲眼看到失败**——确认测试在验证真实行为而非 mock；
3. **最小实现**——避免测试专用方法混入生产代码；
4. **真实依赖优先**——在 mock 之前看清测试实际需要什么。

如果你在测试 mock 行为，就没有取得真实的 TDD 反事实证据。

## 快速参考

| 反模式 | 修复 |
|--------|------|
| 断言 mock 元素 | 测试真实组件或取消 mock |
| 生产代码含测试专用方法 | 移到测试工具 |
| 不理解就 mock | 先理解依赖，再做最小 mock |
| Mock 不完整 | 完整镜像真实 API |
| 测试留到最后 | 测试先行 |
| Mock 过于复杂 | 考虑集成测试 |

## 红旗

- 断言检查 `*-mock` 测试 ID；
- 方法只在测试文件中调用；
- Mock 设置占测试一半以上；
- 删除 mock 后测试失败，却说不清原因；
- 无法解释为何需要 mock；
- “为了安全”而 mock。

## 结论

**Mock 是隔离工具，不是测试对象。** 如果 TDD 暴露你在测试 mock 行为，改测真实行为，并重新审视是否真的需要 mock。
