#!/usr/bin/env python3
import argparse
import json
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


EVAL_ROOT = Path(__file__).resolve().parent
PLUGIN_ROOT = EVAL_ROOT.parent
KNOWN_SKILLS = {
    "clarify",
    "plan",
    "build",
    "tdd",
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
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="Run each case this many times sequentially.",
    )
    parser.add_argument(
        "--min-pass-rate",
        type=float,
        default=1.0,
        help="Minimum pass rate required for every case.",
    )
    parser.add_argument(
        "--model",
        help="Optional Codex model override. The default uses the current CLI model.",
    )
    parser.add_argument(
        "--reasoning-effort",
        default="low",
        choices=("low", "medium", "high", "xhigh"),
        help="Reasoning effort used by every isolated Codex invocation.",
    )
    parser.add_argument(
        "--json-report",
        type=Path,
        help="Optional path for a machine-readable benchmark report.",
    )
    return parser.parse_args()


def build_prompt(user_prompt: str, skills_root: Path) -> str:
    catalog = []
    for skill_name in sorted(KNOWN_SKILLS):
        text = (skills_root / skill_name / "SKILL.md").read_text(encoding="utf-8")
        description = next(
            line.removeprefix("description: ")
            for line in text.splitlines()
            if line.startswith("description: ")
        )
        catalog.append(f"- {skill_name}: {description}")

    return f"""You have these engineering skills available:
{chr(10).join(catalog)}

Choose the minimum skill combination from metadata. Read the selected skills' SKILL.md files under
{skills_root}
before finalizing the route.

User task:
{user_prompt}

Decide the minimum skill combination and compact task contract. Do not execute the task or modify files.
Return selected_skills as the ordered skill names only.
Use only these skill names: {', '.join(sorted(KNOWN_SKILLS))}.
List skills intentionally not needed in skipped_skills.
Put restrictions that apply only to the current turn in action_boundary, not in feature non_goals.
Keep acceptance_criteria about observable product behavior. Put requested working methods such as
TDD in action_boundary or rationale, not in acceptance_criteria.
Do not put commit, push, PR, current-turn, or temporary restrictions in feature non_goals.
TDD can implement or fix the behavior itself. Do not select both tdd and build for the same slice.
"""


def field_text(result: dict, field: str) -> str:
    value = result.get("task_contract", {}).get(field, result.get(field, ""))
    if isinstance(value, list):
        return "\n".join(str(item) for item in value)
    return str(value)


def validate_result(case: dict, result: dict) -> list[str]:
    selected_list = result["selected_skills"]
    skipped_list = result["skipped_skills"]
    selected = set(selected_list)
    skipped = set(skipped_list)
    expected = set(case["expected_skills"])
    allowed = set(case["allowed_skills"])
    errors = []

    if len(selected_list) != len(selected):
        errors.append("selected_skills contains duplicates")
    if len(skipped_list) != len(skipped):
        errors.append("skipped_skills contains duplicates")
    if not selected <= KNOWN_SKILLS:
        errors.append(f"unknown selected skills: {sorted(selected - KNOWN_SKILLS)}")
    if not skipped <= KNOWN_SKILLS:
        errors.append(f"unknown skipped skills: {sorted(skipped - KNOWN_SKILLS)}")
    if selected & skipped:
        errors.append(f"selected and skipped overlap: {sorted(selected & skipped)}")
    if selected | skipped != KNOWN_SKILLS:
        errors.append(f"incomplete skill accounting: {sorted(KNOWN_SKILLS - selected - skipped)}")
    if not expected <= selected:
        errors.append(f"missing expected: {sorted(expected - selected)}")
    if not selected <= allowed:
        errors.append(f"selected disallowed: {sorted(selected - allowed)}")
    for group in case.get("required_one_of", []):
        if not selected.intersection(group):
            errors.append(f"must select one of: {sorted(group)}")
    if {"build", "tdd"} <= selected and not case.get("allow_build_with_tdd", False):
        errors.append("build and tdd redundantly own the same implementation slice")

    positions = {skill: index for index, skill in enumerate(selected_list)}
    for before, after in case.get("order_constraints", []):
        if before in positions and after in positions and positions[before] >= positions[after]:
            errors.append(f"wrong order: {before} must precede {after}")

    acceptance = field_text(result, "acceptance_criteria")
    if re.search(r"\b(?:TDD|RED|GREEN|REFACTOR)\b", acceptance, re.IGNORECASE):
        errors.append("acceptance_criteria contains implementation process")

    non_goals = field_text(result, "non_goals")
    if re.search(r"本轮|当前会话|暂时|提交|推送|\bPR\b", non_goals, re.IGNORECASE):
        errors.append("non_goals contains current-turn restriction")

    for field, patterns in case.get("required_patterns", {}).items():
        text = field_text(result, field)
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE) is None:
                errors.append(f"{field} missing pattern: {pattern}")

    for field, patterns in case.get("forbidden_patterns", {}).items():
        text = field_text(result, field)
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                errors.append(f"{field} contains forbidden pattern: {pattern}")

    return errors


def run_case(
    case: dict,
    timeout: int,
    model: str | None = None,
    reasoning_effort: str = "low",
) -> tuple[bool, dict]:
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
            f'model_reasoning_effort="{reasoning_effort}"',
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
        if model:
            command[2:2] = ["--model", model]
        started = time.monotonic()
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            duration = time.monotonic() - started
            stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr
            return False, {
                "error": str(error),
                "stderr": (stderr or "")[-2000:],
                "duration_seconds": round(duration, 3),
            }
        duration = time.monotonic() - started
        if completed.returncode != 0:
            return False, {
                "error": f"codex exited with {completed.returncode}",
                "stderr": completed.stderr[-2000:],
                "duration_seconds": round(duration, 3),
            }

        result = json.loads(result_path.read_text(encoding="utf-8"))
        errors = validate_result(case, result)
        result["errors"] = errors
        result["duration_seconds"] = round(duration, 3)
        return not errors, result


def main() -> int:
    args = parse_args()
    if args.repeat < 1:
        raise SystemExit("--repeat must be at least 1")
    if not 0 < args.min_pass_rate <= 1:
        raise SystemExit("--min-pass-rate must be greater than 0 and at most 1")

    document = json.loads((EVAL_ROOT / "cases.json").read_text(encoding="utf-8"))
    cases = document["cases"]
    if args.case_ids:
        selected_ids = set(args.case_ids)
        cases = [case for case in cases if case["id"] in selected_ids]
        missing = selected_ids - {case["id"] for case in cases}
        if missing:
            raise SystemExit(f"Unknown case ids: {', '.join(sorted(missing))}")

    failures = 0
    report_cases = []
    for case in cases:
        attempts = []
        for attempt in range(1, args.repeat + 1):
            print(f"RUN {case['id']} [{attempt}/{args.repeat}]", flush=True)
            attempt_started = time.monotonic()
            try:
                passed, result = run_case(
                    case,
                    args.timeout,
                    model=args.model,
                    reasoning_effort=args.reasoning_effort,
                )
            except subprocess.TimeoutExpired as error:
                passed = False
                stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr
                result = {
                    "error": str(error),
                    "stderr": (stderr or "")[-2000:],
                    "duration_seconds": round(time.monotonic() - attempt_started, 3),
                }
            except (json.JSONDecodeError, OSError) as error:
                passed = False
                result = {
                    "error": str(error),
                    "duration_seconds": round(time.monotonic() - attempt_started, 3),
                }

            status = "PASS" if passed else "FAIL"
            print(f"{status} {case['id']} [{attempt}/{args.repeat}]")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            attempts.append({"passed": passed, "result": result})

        pass_count = sum(attempt["passed"] for attempt in attempts)
        pass_rate = pass_count / args.repeat
        case_passed = pass_rate >= args.min_pass_rate
        failures += not case_passed
        report_cases.append(
            {
                "id": case["id"],
                "passes": pass_count,
                "runs": args.repeat,
                "pass_rate": pass_rate,
                "passed": case_passed,
                "attempts": attempts,
            }
        )
        print(f"CASE {case['id']}: {pass_count}/{args.repeat} ({pass_rate:.0%})")

    report = {
        "schema_version": 1,
        "model": args.model or "cli-default",
        "reasoning_effort": args.reasoning_effort,
        "repeat": args.repeat,
        "min_pass_rate": args.min_pass_rate,
        "summary": {
            "passed_cases": len(cases) - failures,
            "total_cases": len(cases),
            "passed_attempts": sum(
                item["passes"] for item in report_cases
            ),
            "total_attempts": len(cases) * args.repeat,
            "duration_seconds": round(
                sum(
                    attempt["result"].get("duration_seconds", 0)
                    for item in report_cases
                    for attempt in item["attempts"]
                ),
                3,
            ),
        },
        "cases": report_cases,
    }
    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print(f"Summary: {len(cases) - failures}/{len(cases)} cases passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
