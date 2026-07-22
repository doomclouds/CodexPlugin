import json
import re
import unittest
from pathlib import Path

import yaml


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SKILLS = {
    "clarify",
    "plan",
    "build",
    "tdd",
    "debug",
    "explore",
    "review",
    "verify",
}


def read_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(?P<body>.*?)\n---\n", text, re.DOTALL)
    if match is None:
        raise AssertionError(f"Missing frontmatter: {path}")

    fields = yaml.safe_load(match.group("body"))
    if not isinstance(fields, dict):
        raise AssertionError(f"Invalid frontmatter mapping: {path}")
    return fields


class EngineeringWorkflowPluginTests(unittest.TestCase):
    def test_manifest_and_skill_inventory(self) -> None:
        manifest = json.loads(
            (PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        self.assertEqual("engineering-workflow", manifest["name"])
        self.assertEqual("./skills/", manifest["skills"])
        self.assertRegex(manifest["version"], r"^0\.\d+\.\d+$")
        self.assertEqual(len(manifest["keywords"]), len(set(manifest["keywords"])))
        self.assertEqual("Engineering Workflow", manifest["interface"]["displayName"])

        skill_names = {
            path.name
            for path in (PLUGIN_ROOT / "skills").iterdir()
            if path.is_dir()
        }
        self.assertEqual(EXPECTED_SKILLS, skill_names)

    def test_skill_frontmatter_and_ui_metadata(self) -> None:
        for skill_name in EXPECTED_SKILLS:
            with self.subTest(skill=skill_name):
                skill_root = PLUGIN_ROOT / "skills" / skill_name
                fields = read_frontmatter(skill_root / "SKILL.md")
                self.assertEqual({"name", "description"}, set(fields))
                self.assertEqual(skill_name, fields["name"])
                self.assertTrue(fields["description"])

                skill_text = (skill_root / "SKILL.md").read_text(encoding="utf-8")
                self.assertLessEqual(len(skill_text.splitlines()), 500)

                ui = yaml.safe_load(
                    (skill_root / "agents" / "openai.yaml").read_text(encoding="utf-8")
                )
                self.assertEqual({"interface", "policy"}, set(ui))
                self.assertEqual(
                    {"display_name", "short_description", "default_prompt"},
                    set(ui["interface"]),
                )
                description = ui["interface"]["short_description"]
                prompt = ui["interface"]["default_prompt"]
                self.assertLessEqual(25, len(description))
                self.assertLessEqual(len(description), 64)
                self.assertIn(f"${skill_name}", prompt)
                self.assertIs(True, ui["policy"]["allow_implicit_invocation"])

    def test_shared_contract_is_present_where_consumed(self) -> None:
        for skill_name in EXPECTED_SKILLS:
            with self.subTest(skill=skill_name):
                text = (PLUGIN_ROOT / "skills" / skill_name / "SKILL.md").read_text(
                    encoding="utf-8"
                )
                self.assertIn("continuity-contract.md", text)

        build = (PLUGIN_ROOT / "skills" / "build" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("../tdd/SKILL.md", build)

        tdd = (PLUGIN_ROOT / "skills" / "tdd" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        for marker in ("RED", "GREEN", "REFACTOR", "公开入口", "实现证据"):
            self.assertIn(marker, tdd)

    def test_plan_owns_task_definition_and_execution_plan(self) -> None:
        plan = (PLUGIN_ROOT / "skills" / "plan" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        for required in (
            "spec、规格、设计说明、实施计划",
            "AC-*",
            "执行计划只是同一任务文档",
            "../tdd/SKILL.md",
        ):
            self.assertIn(required, plan)

    def test_markdown_references_resolve(self) -> None:
        for path in PLUGIN_ROOT.rglob("*.md"):
            with self.subTest(path=path.relative_to(PLUGIN_ROOT)):
                text = path.read_text(encoding="utf-8")
                for target in re.findall(r"\]\(([^)#]+\.md)\)", text):
                    if "://" in target or "<" in target:
                        continue
                    self.assertTrue((path.parent / target).resolve().is_file(), target)

    def test_asset_templates_define_stable_contracts(self) -> None:
        templates = PLUGIN_ROOT / "assets" / "templates"
        required = {
            "domain-map.md": ("## 领域", "## 关系", "CONTEXT.md"),
            "domain-context.md": ("## 职责", "## 统一语言", "## 边界"),
            "task.md": ("Status: active", "AC-1", "## 计划", "## 下一步"),
        }
        for filename, markers in required.items():
            with self.subTest(template=filename):
                text = (templates / filename).read_text(encoding="utf-8")
                for marker in markers:
                    self.assertIn(marker, text)

    def test_continuity_contract_defines_recoverable_defaults(self) -> None:
        policy = (PLUGIN_ROOT / "references" / "continuity-contract.md").read_text(
            encoding="utf-8"
        )
        for required in (
            "docs/domain/CONTEXT.MAP.md",
            "docs/domain/<domain>/CONTEXT.md",
            "docs/adr/YYYY/MM/",
            "docs/tasks/YYYY/MM/",
            "docs/research/YYYY/MM/",
            "后续更新原文件，不因月份变化搬迁或复制资产",
            "AC-*",
            "不要默认创建独立的 Spec、Plan 或 Handoff 文件",
            "强模型自行选择",
            "../assets/templates/domain-map.md",
            "../assets/templates/domain-context.md",
            "../assets/templates/task.md",
        ):
            self.assertIn(required, policy)

    def test_every_skill_reads_continuity_contract(self) -> None:
        for skill_name in EXPECTED_SKILLS:
            with self.subTest(skill=skill_name):
                text = (PLUGIN_ROOT / "skills" / skill_name / "SKILL.md").read_text(
                    encoding="utf-8"
                )
                self.assertIn("continuity-contract.md", text)

    def test_skills_avoid_opaque_process_language(self) -> None:
        forbidden = (
            "非平凡",
            "对上述",
            "公共行为接缝",
            "测试接缝",
            "可证伪",
            "三轴",
            "收紧",
            "契约漂移",
            "短 diff",
            "反馈回路",
            "静默超前",
            "散弹式",
        )
        for skill_name in EXPECTED_SKILLS:
            text = (PLUGIN_ROOT / "skills" / skill_name / "SKILL.md").read_text(
                encoding="utf-8"
            )
            with self.subTest(skill=skill_name):
                for phrase in forbidden:
                    self.assertNotIn(phrase, text)

    def test_eval_cases_reference_known_disjoint_skills(self) -> None:
        document = json.loads(
            (PLUGIN_ROOT / "evals" / "cases.json").read_text(encoding="utf-8")
        )
        self.assertEqual(2, document["schema_version"])
        self.assertGreaterEqual(len(document["cases"]), 20)

        case_ids = set()
        prompts = set()
        expected_coverage = set()
        for case in document["cases"]:
            with self.subTest(case=case["id"]):
                self.assertNotIn(case["id"], case_ids)
                case_ids.add(case["id"])
                self.assertNotIn(case["prompt"], prompts)
                prompts.add(case["prompt"])
                expected = set(case["expected_skills"])
                allowed = set(case["allowed_skills"])
                expected_coverage.update(expected)
                self.assertTrue(case["prompt"])
                self.assertTrue(expected)
                self.assertLessEqual(expected, allowed)
                self.assertLessEqual(allowed, EXPECTED_SKILLS)

                for before, after in case.get("order_constraints", []):
                    self.assertNotEqual(before, after)
                    self.assertIn(before, allowed)
                    self.assertIn(after, allowed)

                for group in case.get("required_one_of", []):
                    self.assertGreaterEqual(len(group), 2)
                    self.assertLessEqual(set(group), allowed)

                for check_name in ("required_patterns", "forbidden_patterns"):
                    for field, patterns in case.get(check_name, {}).items():
                        self.assertIn(
                            field,
                            {
                                "goal",
                                "assumptions",
                                "acceptance_criteria",
                                "edge_behaviors",
                                "non_goals",
                                "risks",
                                "action_boundary",
                                "rationale",
                            },
                        )
                        self.assertTrue(patterns)
                        for pattern in patterns:
                            re.compile(pattern)

        self.assertEqual(EXPECTED_SKILLS, expected_coverage)
        for skill_name in EXPECTED_SKILLS:
            self.assertTrue(
                any(
                    skill_name not in case["allowed_skills"]
                    for case in document["cases"]
                ),
                f"Missing negative routing coverage for {skill_name}",
            )


if __name__ == "__main__":
    unittest.main()
