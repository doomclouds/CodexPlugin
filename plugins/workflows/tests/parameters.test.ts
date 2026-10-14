import test from "node:test";
import assert from "node:assert/strict";
import { readParameters, renderParameterFields } from "../prototypes/panel-parameters.ts";
import type { WorkflowParameter } from "../prototypes/panel-parameters.ts";

const parameters: WorkflowParameter[] = [
  { name: "bugId", label: "Bug 编号", type: "string", required: true, placeholder: "输入编号" },
  { name: "url", label: "链接", type: "string" },
  { name: "description", label: "描述", type: "string", multiline: true, description: "补充现象" },
  { name: "attempts", label: "尝试次数", type: "number" },
  { name: "includeClosed", label: "包含已关闭", type: "boolean", required: true },
  { name: "files", label: "文件", type: "string[]" },
];

test("metadata drives text, multiline, numeric, checkbox and list controls without name-based guessing", () => {
  const html = renderParameterFields(parameters, { bugId: "0012", url: "https://example.test/12", attempts: 0, includeClosed: false, files: ["a.ts", "b.ts"] });
  assert.match(html, /type="text"[^>]*data-parameter="bugId"[^>]*value="0012"/);
  assert.match(html, /type="text"[^>]*data-parameter="url"/);
  assert.match(html, /<textarea[^>]*data-parameter="description"/);
  assert.match(html, /type="number"[^>]*data-parameter="attempts"[^>]*value="0"/);
  const checkbox = html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? "";
  assert.match(checkbox, /aria-required="true"/);
  assert.equal(checkbox.includes(" checked"), false);
  assert.equal(/\srequired(?:\s|>)/.test(checkbox), false);
  assert.match(html, />a\.ts\nb\.ts<\/textarea>/);
  assert.match(html, /wf-parameter-required/);
  assert.match(html, /补充现象/);
  assert.match(renderParameterFields([{ name: "description", label: "描述", type: "string" }], {}), /type="text"/);
});

test("form values produce exact declared types and preserve false, zero, string identifiers and extra caller keys", () => {
  const args = readParameters(parameters, new Map<string, unknown>([
    ["bugId", "0012"], ["url", "https://example.test/12"], ["description", "first\nsecond"],
    ["attempts", "0"], ["includeClosed", false], ["files", "a.ts\r\n\r\nb.ts"],
  ]), { callerSpecific: { untouched: true }, attempts: 9 });
  assert.deepEqual(args, { callerSpecific: { untouched: true }, attempts: 0, bugId: "0012", url: "https://example.test/12", description: "first\nsecond", includeClosed: false, files: ["a.ts", "b.ts"] });
  assert.equal(typeof args.bugId, "string");
  assert.equal(typeof args.attempts, "number");
});

test("missing controls retain defaults while explicit clearing removes optional numbers", () => {
  const definitions: WorkflowParameter[] = [{ name: "count", label: "次数", type: "number" }, { name: "flag", label: "开关", type: "boolean", required: true }, { name: "text", label: "文本", type: "string" }];
  assert.deepEqual(readParameters(definitions, {}, { count: 0, flag: false, text: "default", extra: 12 }), { count: 0, flag: false, text: "default", extra: 12 });
  assert.deepEqual(readParameters(definitions, { count: "", text: "" }, { count: 5, flag: true, text: "default" }), { flag: true, text: "" });
  assert.match(renderParameterFields(definitions, { flag: true }, true), / checked/);
  assert.equal((renderParameterFields(definitions, {}, true).match(/ disabled/g) ?? []).length, definitions.length);
});

test("required fields and invalid types fail before constructing workflow input", () => {
  assert.throws(() => readParameters(parameters, {}), /请填写“Bug 编号”/);
  assert.throws(() => readParameters([parameters[0]!], { bugId: "   " }), /请填写/);
  assert.throws(() => readParameters([{ name: "list", label: "列表", type: "string[]", required: true }], { list: "\n\r\n" }), /请填写/);
  for (const attempts of ["abc", "1x", "Infinity", "0xff", Infinity, {}, true]) assert.throws(() => readParameters([parameters[3]!], { attempts }), /必须是有限数字/);
  assert.deepEqual(readParameters([parameters[3]!], { attempts: "-1.25e2" }), { attempts: -125 });
  assert.throws(() => readParameters([parameters[4]!], { includeClosed: "on" }), /必须是布尔值/);
  assert.deepEqual(readParameters([parameters[4]!], { includeClosed: "false" }), { includeClosed: false });
  assert.throws(() => readParameters(parameters, {}, [1, 2]), /对象形式/);
});

test("parameter values and labels escape markup and special names remain safe own keys", () => {
  const malicious = '"><img src=x onerror="evil()">';
  const definition: WorkflowParameter = { name: malicious, label: malicious, type: "string", placeholder: malicious, description: malicious, multiline: true };
  const html = renderParameterFields([definition], { [malicious]: '</textarea><script>evil()</script>' });
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("<script"), false);
  assert.match(html, /&lt;\/textarea&gt;/);
  const result = readParameters([{ name: "__proto__", label: "自定义字段", type: "string" }], JSON.parse('{"__proto__":"value"}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(result.__proto__, "value");
  const unknownType = { ...definition, type: 'string" onclick="evil' as WorkflowParameter["type"] };
  assert.throws(() => renderParameterFields([unknownType], {}), /不支持的字段类型/);
  assert.throws(() => readParameters([unknownType], {}), /不支持的字段类型/);
});

test("text lists preserve caller string contents and legacy JSON without metadata has no form", () => {
  assert.deepEqual(readParameters([parameters[5]!], { files: [" a.ts ", "b.ts"] }), { files: [" a.ts ", "b.ts"] });
  assert.deepEqual(readParameters([parameters[5]!], { files: " a.ts \n\nb.ts" }), { files: [" a.ts ", "b.ts"] });
  assert.equal(renderParameterFields([], ["legacy", 0, false]), "");
});
