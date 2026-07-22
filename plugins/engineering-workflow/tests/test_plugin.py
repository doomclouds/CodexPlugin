import json
import re
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SKILLS = {
    "clarify",
    "spec",
    "plan",
    "build",
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

    fields = {}
    for line in match.group("body").splitlines():
        key, separator, value = line.partition(":")
        if not separator:
            raise AssertionError(f"Invalid frontmatter line in {path}: {line}")
        fields[key.strip()] = value.strip()
    return fields


class EngineeringWorkflowPluginTests(unittest.TestCase):
    def test_manifest_and_skill_inventory(self) -> None:
        manifest = json.loads(
            (PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        self.assertEqual("engineering-workflow", manifest["name"])
        self.assertEqual("./skills/", manifest["skills"])

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

                ui = (skill_root / "agents" / "openai.yaml").read_text(encoding="utf-8")
                description = re.search(r'^  short_description: "([^"]+)"$', ui, re.MULTILINE)
                prompt = re.search(r'^  default_prompt: "([^"]+)"$', ui, re.MULTILINE)
                self.assertIsNotNone(description)
                self.assertIsNotNone(prompt)
                self.assertLessEqual(25, len(description.group(1)))
                self.assertLessEqual(len(description.group(1)), 64)
                self.assertIn(f"${skill_name}", prompt.group(1))
                self.assertIn("allow_implicit_invocation: true", ui)

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
        self.assertIn("RED:", build)
        self.assertIn("RED skipped:", build)

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
        self.assertEqual(1, document["schema_version"])
        self.assertGreaterEqual(len(document["cases"]), 13)

        case_ids = set()
        for case in document["cases"]:
            with self.subTest(case=case["id"]):
                self.assertNotIn(case["id"], case_ids)
                case_ids.add(case["id"])
                expected = set(case["expected_skills"])
                excluded = set(case["excluded_skills"])
                self.assertTrue(case["prompt"])
                self.assertTrue(case["constraints"])
                self.assertTrue(expected)
                self.assertLessEqual(expected | excluded, EXPECTED_SKILLS)
                self.assertFalse(expected & excluded)


if __name__ == "__main__":
    unittest.main()
