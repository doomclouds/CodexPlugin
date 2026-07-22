#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


EVAL_ROOT = Path(__file__).resolve().parent
PLUGIN_ROOT = EVAL_ROOT.parent
KNOWN_STAGE_SKILLS = {
    "clarify",
    "spec",
    "plan",
    "build",
    "debug",
    "explore",
    "review",
    "verify",
}


OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "selected_skills",
        "skipped_skills",
        "task_contract",
        "action_boundary",
        "rationale",
    ],
    "properties": {
        "selected_skills": {"type": "array", "items": {"type": "string"}},
        "skipped_skills": {"type": "array", "items": {"type": "string"}},
        "task_contract": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "goal",
                "assumptions",
                "acceptance_criteria",
                "edge_behaviors",
                "non_goals",
                "risks",
            ],
            "properties": {
                "goal": {"type": "string"},
                "assumptions": {"type": "array", "items": {"type": "string"}},
                "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                "edge_behaviors": {"type": "array", "items": {"type": "string"}},
                "non_goals": {"type": "array", "items": {"type": "string"}},
                "risks": {"type": "array", "items": {"type": "string"}},
            },
        },
        "action_boundary": {"type": "string"},
        "rationale": {"type": "string"},
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run engineering-workflow routing cases in isolated Codex CLI contexts."
    )
    parser.add_argument(
        "--case",
        action="append",
        dest="case_ids",
        help="Run only this case id. Repeat to select multiple cases.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=240,
        help="Timeout in seconds for each Codex invocation.",
    )
    return parser.parse_args()


def build_prompt(user_prompt: str, skills_root: Path) -> str:
    catalog = []
    for skill_name in sorted(KNOWN_STAGE_SKILLS):
        text = (skills_root / skill_name / "SKILL.md").read_text(encoding="utf-8")
        description = next(
            line.removeprefix("description: ")
            for line in text.splitlines()
            if line.startswith("description: ")
        )
        catalog.append(f"- {skill_name}: {description}")

    return f"""You have these engineering skills available:
{chr(10).join(catalog)}

Choose the minimum stage chain from metadata. Read the selected stages' SKILL.md files under
{skills_root}
before finalizing the route.

User task:
{user_prompt}

Decide the minimum stage chain and compact task contract. Do not execute the task or modify files.
Return selected_skills as the ordered stage names only.
Use only these stage names: {', '.join(sorted(KNOWN_STAGE_SKILLS))}.
List stages intentionally not needed in skipped_skills.
Put restrictions that apply only to the current turn in action_boundary, not in feature non_goals.
"""


def run_case(case: dict, timeout: int) -> tuple[bool, dict]:
    with tempfile.TemporaryDirectory(prefix="engineering-workflow-eval-") as temp_dir:
        temp_root = Path(temp_dir)
        schema_path = temp_root / "output-schema.json"
        result_path = temp_root / "result.json"
        skills_root = temp_root / "skills"
        shutil.copytree(PLUGIN_ROOT / "skills", skills_root)
        shutil.copytree(PLUGIN_ROOT / "references", temp_root / "references")
        schema_path.write_text(
            json.dumps(OUTPUT_SCHEMA, ensure_ascii=False), encoding="utf-8"
        )

        command = [
            "codex",
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--color",
            "never",
            "--config",
            'model_reasoning_effort="low"',
            "--sandbox",
            "read-only",
            "--cd",
            str(temp_root),
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(result_path),
            build_prompt(case["prompt"], skills_root),
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if completed.returncode != 0:
            return False, {
                "error": f"codex exited with {completed.returncode}",
                "stderr": completed.stderr[-2000:],
            }

        result = json.loads(result_path.read_text(encoding="utf-8"))
        selected = set(result["selected_skills"])
        expected = set(case["expected_skills"])
        excluded = set(case["excluded_skills"])
        errors = []
        if not selected <= KNOWN_STAGE_SKILLS:
            errors.append(f"unknown skills: {sorted(selected - KNOWN_STAGE_SKILLS)}")
        if not expected <= selected:
            errors.append(f"missing expected: {sorted(expected - selected)}")
        if selected & excluded:
            errors.append(f"selected excluded: {sorted(selected & excluded)}")
        result["errors"] = errors
        return not errors, result


def main() -> int:
    args = parse_args()
    document = json.loads((EVAL_ROOT / "cases.json").read_text(encoding="utf-8"))
    cases = document["cases"]
    if args.case_ids:
        selected_ids = set(args.case_ids)
        cases = [case for case in cases if case["id"] in selected_ids]
        missing = selected_ids - {case["id"] for case in cases}
        if missing:
            raise SystemExit(f"Unknown case ids: {', '.join(sorted(missing))}")

    failures = 0
    for case in cases:
        print(f"RUN {case['id']}", flush=True)
        try:
            passed, result = run_case(case, args.timeout)
        except subprocess.TimeoutExpired as error:
            passed = False
            stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr
            result = {
                "error": str(error),
                "stderr": (stderr or "")[-2000:],
            }
        except (json.JSONDecodeError, OSError) as error:
            passed = False
            result = {"error": str(error)}

        status = "PASS" if passed else "FAIL"
        print(f"{status} {case['id']}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        failures += not passed

    print(f"Summary: {len(cases) - failures}/{len(cases)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
