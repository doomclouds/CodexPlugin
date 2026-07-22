import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "run_cli_evals", PLUGIN_ROOT / "evals" / "run_cli_evals.py"
)
EVALS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVALS)


def make_result(selected: list[str]) -> dict:
    return {
        "selected_skills": selected,
        "skipped_skills": sorted(EVALS.KNOWN_SKILLS - set(selected)),
        "task_contract": {
            "goal": "实现公开行为",
            "assumptions": [],
            "acceptance_criteria": ["AC-1：调用者能观察到结果"],
            "edge_behaviors": [],
            "non_goals": ["不增加相邻功能"],
            "risks": [],
        },
        "action_boundary": "本次只做路由评测，不修改文件。",
        "rationale": "选择最小技能组合。",
    }


class RoutingEvaluatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.case = {
            "expected_skills": ["build", "verify"],
            "allowed_skills": ["build", "verify"],
            "order_constraints": [["build", "verify"]],
        }

    def test_accepts_exact_valid_route(self) -> None:
        self.assertEqual([], EVALS.validate_result(self.case, make_result(["build", "verify"])))

    def test_rejects_extra_skill_and_wrong_order(self) -> None:
        result = make_result(["verify", "tdd", "build"])
        errors = EVALS.validate_result(self.case, result)
        self.assertTrue(any("selected disallowed" in error for error in errors))
        self.assertTrue(any("wrong order" in error for error in errors))
        self.assertTrue(any("redundantly" in error for error in errors))

    def test_rejects_incomplete_skipped_accounting(self) -> None:
        result = make_result(["build", "verify"])
        result["skipped_skills"].remove("debug")
        errors = EVALS.validate_result(self.case, result)
        self.assertTrue(any("incomplete skill accounting" in error for error in errors))

    def test_requires_one_skill_from_an_alternative_group(self) -> None:
        case = dict(self.case)
        case["expected_skills"] = ["verify"]
        case["allowed_skills"] = ["build", "tdd", "verify"]
        case["required_one_of"] = [["build", "tdd"]]
        result = make_result(["verify"])
        errors = EVALS.validate_result(case, result)
        self.assertTrue(any("must select one of" in error for error in errors))

    def test_rejects_process_as_product_acceptance(self) -> None:
        result = make_result(["build", "verify"])
        result["task_contract"]["acceptance_criteria"] = ["AC-1：完成 RED 和 GREEN"]
        errors = EVALS.validate_result(self.case, result)
        self.assertIn("acceptance_criteria contains implementation process", errors)

    def test_rejects_turn_restriction_as_product_non_goal(self) -> None:
        result = make_result(["build", "verify"])
        result["task_contract"]["non_goals"] = ["本轮不提交代码"]
        errors = EVALS.validate_result(self.case, result)
        self.assertIn("non_goals contains current-turn restriction", errors)

    def test_enforces_case_patterns(self) -> None:
        case = dict(self.case)
        case["required_patterns"] = {
            "goal": ["公开行为"],
            "acceptance_criteria": ["取消"],
        }
        case["forbidden_patterns"] = {"risks": ["猜测"]}
        result = make_result(["build", "verify"])
        result["task_contract"]["risks"] = ["根因仍是猜测"]
        errors = EVALS.validate_result(case, result)
        self.assertFalse(any("goal missing pattern" in error for error in errors))
        self.assertTrue(any("missing pattern" in error for error in errors))
        self.assertTrue(any("forbidden pattern" in error for error in errors))

    def test_isolates_codex_writes_without_copying_user_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_home = root / "source"
            source_home.mkdir()
            (source_home / "auth.json").write_text("{}", encoding="utf-8")
            (source_home / "models_cache.json").write_text("{}", encoding="utf-8")
            (source_home / "config.toml").write_text("model = 'test'", encoding="utf-8")

            with patch.dict(os.environ, {"CODEX_HOME": str(source_home)}):
                environment = EVALS.isolated_codex_environment(root / "run")

            isolated_home = Path(environment["CODEX_HOME"])
            self.assertTrue((isolated_home / "auth.json").is_file())
            self.assertTrue((isolated_home / "models_cache.json").is_file())
            self.assertFalse((isolated_home / "config.toml").exists())


if __name__ == "__main__":
    unittest.main()
