#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from checks.milestone_checks import ALLOWED_MILESTONE_STATUSES, check_milestone, find_milestone, parse_checklist


SCRIPTS_ROOT = Path(__file__).resolve().parent
SKILLS_ROOT = SCRIPTS_ROOT.parents[1]
TEMPLATES_ROOT = SKILLS_ROOT / "manage-superpowers-milestone" / "references"
README_TEMPLATE = TEMPLATES_ROOT / "milestone-readme-template.md"
CHECKLIST_TEMPLATE = TEMPLATES_ROOT / "milestone-checklist-template.md"


def repo_root(root: Path) -> Path:
    root = root.resolve()
    if root.name == "superpowers" and root.parent.name == "docs":
        return root.parent.parent
    if root.name == "docs":
        return root.parent
    return root


def relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def milestones_root(root: Path) -> Path:
    return repo_root(root) / "docs" / "milestones"


def render_template(template: Path, values: dict[str, str]) -> str:
    text = template.read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text.rstrip() + "\n"


def slice_entries(slices: list[dict[str, str]]) -> str:
    entries: list[str] = []
    for index, item in enumerate(slices, start=1):
        status = item.get("status", "Not Started")
        mark = "x" if status == "Done" else " "
        entries.append(
            "\n".join(
                [
                    f"- [{mark}] {index}. {item['title']}",
                    f"  - Status: {status}",
                    f"  - Related spec: {item.get('spec', 'None yet.')}",
                    f"  - Related plan: {item.get('plan', 'None yet.')}",
                    f"  - Related archive: {item.get('archive', 'None yet.')}",
                    f"  - Completion signal: {item.get('completion_signal', 'Pending.')}",
                ]
            )
        )
    return "\n".join(entries)


def milestone_title(milestone: Path) -> str:
    checklist = milestone / "CHECKLIST.md"
    if checklist.exists():
        for line in checklist.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                return line[2:].removesuffix(" Checklist").strip()
    readme = milestone / "README.md"
    if readme.exists():
        for line in readme.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                return line[2:].removesuffix(" Milestone").strip()
    return milestone.name.replace("-", " ").title()


def render_checklist(title: str, month: str, slices: list[dict[str, str]]) -> str:
    summary = recompute_values(slices)
    return render_template(
        CHECKLIST_TEMPLATE,
        {
            "title": title,
            "month": month,
            "status": str(summary["status"]),
            "progress": str(summary["progress"]),
            "done": str(summary["done"]),
            "in_progress": str(summary["in_progress"]),
            "not_started": str(summary["not_started"]),
            "slice_entries": slice_entries(slices),
        },
    )


def recompute_values(slices: list[dict[str, str]]) -> dict[str, object]:
    done = sum(1 for item in slices if item.get("status") == "Done")
    in_progress = sum(1 for item in slices if item.get("status") == "In Progress")
    not_started = sum(1 for item in slices if item.get("status") == "Not Started")
    total = len(slices)
    if total > 0 and done == total:
        status = "Done"
    elif done > 0 or in_progress > 0:
        status = "In Progress"
    else:
        status = "Not Started"
    return {
        "status": status,
        "progress": f"{done}/{total}",
        "done": done,
        "in_progress": in_progress,
        "not_started": not_started,
    }


def read_slices(checklist: Path) -> list[dict[str, str]]:
    parsed = parse_checklist(checklist)
    slices = parsed["slices"]
    assert isinstance(slices, list)
    return [dict(item) for item in slices if isinstance(item, dict)]


def index_rows(index_file: Path) -> list[list[str]]:
    if not index_file.exists():
        return []
    rows: list[list[str]] = []
    for line in index_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 6 or cells[0] == "Month" or all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue
        rows.append(cells[:6])
    return rows


def write_index(root: Path, milestone: Path, status: str, progress: str, title: str, notes: str) -> None:
    root = repo_root(root)
    index_file = milestones_root(root) / "INDEX.md"
    index_file.parent.mkdir(parents=True, exist_ok=True)
    month = milestone.parent.name
    slug = milestone.name
    milestone_link = f"{month}/{slug}/README.md"
    checklist_link = f"{month}/{slug}/CHECKLIST.md"
    new_row = [
        month,
        f"[{title}]({milestone_link})",
        f"[Checklist]({checklist_link})",
        status,
        progress,
        notes,
    ]

    rows = [row for row in index_rows(index_file) if milestone_link not in row[1]]
    rows.append(new_row)
    rows.sort(key=lambda row: (row[0], row[1].lower()), reverse=True)
    text = "\n".join(
        [
            "# Milestones",
            "",
            "| Month | Milestone | Checklist | Status | Progress | Notes |",
            "| --- | --- | --- | --- | --- | --- |",
            *["| " + " | ".join(row) + " |" for row in rows],
            "",
        ]
    )
    index_file.write_text(text, encoding="utf-8", newline="\n")


def notes_from_readme(readme: Path, fallback: str) -> str:
    if not readme.exists():
        return fallback
    lines = readme.read_text(encoding="utf-8").splitlines()
    capture = False
    for line in lines:
        if line.startswith("## "):
            capture = line == "## Strategic Significance"
            continue
        if capture and line.strip():
            return line.strip()
    return fallback


def create_milestone(args: argparse.Namespace) -> dict[str, object]:
    root = repo_root(Path(args.root))
    milestone = milestones_root(root) / args.month / args.slug
    slices = [
        {
            "title": title,
            "status": "Not Started",
            "spec": "None yet.",
            "plan": "None yet.",
            "archive": "None yet.",
            "completion_signal": "Pending.",
        }
        for title in args.slice
    ]
    scope = "\n".join(f"- {title}" for title in args.slice)
    readme_text = render_template(
        README_TEMPLATE,
        {
            "title": args.title,
            "background": args.background or "None yet.",
            "strategic_significance": args.strategic_significance or "None yet.",
            "goal": args.goal or f"Complete the {args.title} milestone.",
            "acceptance": args.acceptance,
            "scope": args.scope or scope,
            "non_goals": args.non_goals or "None yet.",
            "reference_signals": args.reference_signals or "None yet.",
            "slice_boundaries": scope,
        },
    )
    checklist_text = render_checklist(args.title, args.month, slices)
    summary = recompute_values(slices)

    if args.write:
        milestone.mkdir(parents=True, exist_ok=True)
        (milestone / "README.md").write_text(readme_text, encoding="utf-8", newline="\n")
        (milestone / "CHECKLIST.md").write_text(checklist_text, encoding="utf-8", newline="\n")
        write_index(root, milestone, str(summary["status"]), str(summary["progress"]), args.title, args.acceptance)

    return {"status": "created", "milestone": relative(root, milestone / "README.md")}


def require_milestone(root: Path, slug: str) -> Path:
    milestone = find_milestone(root, slug)
    if milestone is None:
        raise SystemExit(f"Milestone not found: {slug}")
    return milestone


def update_slice(args: argparse.Namespace) -> dict[str, object]:
    if args.status not in ALLOWED_MILESTONE_STATUSES:
        raise SystemExit(f"Invalid status: {args.status}")
    root = repo_root(Path(args.root))
    milestone = require_milestone(root, args.slug)
    checklist = milestone / "CHECKLIST.md"
    slices = read_slices(checklist)
    found = False
    for item in slices:
        if item["title"] != args.slice:
            continue
        found = True
        item["status"] = args.status
        if args.spec is not None:
            item["spec"] = args.spec
        if args.plan is not None:
            item["plan"] = args.plan
        if args.archive is not None:
            item["archive"] = args.archive
        if args.completion_signal is not None:
            item["completion_signal"] = args.completion_signal
        break
    if not found:
        raise SystemExit(f"Slice not found: {args.slice}")

    if args.write:
        checklist.write_text(
            render_checklist(milestone_title(milestone), milestone.parent.name, slices),
            encoding="utf-8",
            newline="\n",
        )

    return {"status": "updated", "milestone": relative(root, checklist)}


def recompute_milestone(args: argparse.Namespace) -> dict[str, object]:
    root = repo_root(Path(args.root))
    milestone = require_milestone(root, args.slug)
    checklist = milestone / "CHECKLIST.md"
    slices = read_slices(checklist)
    title = milestone_title(milestone)
    summary = recompute_values(slices)

    if args.write:
        checklist.write_text(render_checklist(title, milestone.parent.name, slices), encoding="utf-8", newline="\n")
        write_index(
            root,
            milestone,
            str(summary["status"]),
            str(summary["progress"]),
            title,
            notes_from_readme(milestone / "README.md", ""),
        )

    return {"status": "recomputed", "progress": summary["progress"]}


def check(args: argparse.Namespace) -> dict[str, object]:
    issues = check_milestone(Path(args.root), args.slug)
    status = "pass" if not any(item["severity"] == "error" for item in issues) else "needs_attention"
    return {"status": status, "issues": issues}


def print_result(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["status"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and maintain project milestone assets.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--month", required=True)
    create.add_argument("--slug", required=True)
    create.add_argument("--title", required=True)
    create.add_argument("--slice", action="append", required=True)
    create.add_argument("--acceptance", required=True)
    create.add_argument("--strategic-significance")
    create.add_argument("--background")
    create.add_argument("--goal")
    create.add_argument("--scope")
    create.add_argument("--non-goals", dest="non_goals")
    create.add_argument("--reference-signals", dest="reference_signals")
    create.add_argument("--write", action="store_true")
    create.add_argument("--json", action="store_true")
    create.set_defaults(func=create_milestone)

    update = subparsers.add_parser("update-slice")
    update.add_argument("--slug", required=True)
    update.add_argument("--slice", required=True)
    update.add_argument("--status", required=True)
    update.add_argument("--spec")
    update.add_argument("--plan")
    update.add_argument("--archive")
    update.add_argument("--completion-signal", dest="completion_signal")
    update.add_argument("--write", action="store_true")
    update.add_argument("--json", action="store_true")
    update.set_defaults(func=update_slice)

    recompute = subparsers.add_parser("recompute")
    recompute.add_argument("--slug", required=True)
    recompute.add_argument("--write", action="store_true")
    recompute.add_argument("--json", action="store_true")
    recompute.set_defaults(func=recompute_milestone)

    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("--slug")
    check_parser.add_argument("--json", action="store_true")
    check_parser.set_defaults(func=check)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command in {"create", "update-slice", "recompute"} and not args.write:
        raise SystemExit(f"{args.command} requires --write to modify files.")
    result = args.func(args)
    print_result(result, args.json)
    if args.command == "check":
        issues = result["issues"]
        assert isinstance(issues, list)
        return 1 if any(issue["severity"] == "error" for issue in issues if isinstance(issue, dict)) else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
