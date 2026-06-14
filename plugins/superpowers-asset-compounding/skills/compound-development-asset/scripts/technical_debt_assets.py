#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from checks.technical_debt_checks import (
    ALLOWED_DEBT_STATUSES,
    ALLOWED_PRIORITIES,
    check_technical_debt,
    find_debts,
    parse_debt_metadata,
)


SCRIPTS_ROOT = Path(__file__).resolve().parent
SKILLS_ROOT = SCRIPTS_ROOT.parents[1]
TEMPLATE = SKILLS_ROOT / "manage-technical-debt" / "references" / "technical-debt-template.md"


class CommandError(Exception):
    def __init__(self, code: str, message: str, *, path: str | None = None) -> None:
        super().__init__(message)
        self.issue = {"severity": "error", "code": code, "message": message}
        if path:
            self.issue["path"] = path


def repo_root(root: Path) -> Path:
    root = root.resolve()
    if root.name == "technical-debt" and root.parent.name == "docs":
        return root.parent.parent
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


def technical_debt_root(root: Path) -> Path:
    return repo_root(root) / "docs" / "technical-debt"


def render_template(values: dict[str, str]) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text.rstrip() + "\n"


def month_from_date(date: str) -> str:
    match = re.match(r"^\d{4}-\d{2}-\d{2}$", date)
    if not match:
        raise CommandError("invalid_debt_date", f"Invalid date: {date}")
    return date[:7]


def title_from_debt(path: Path) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return path.stem.removesuffix("-debt").replace("-", " ").title()


def index_rows(index_file: Path) -> list[list[str]]:
    if not index_file.exists():
        return []
    rows: list[list[str]] = []
    for line in index_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 7 or cells[0] == "Month" or all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue
        rows.append(cells[:7])
    return rows


def write_index(root: Path, debt: Path, notes: str) -> None:
    root = repo_root(root)
    index_file = technical_debt_root(root) / "INDEX.md"
    index_file.parent.mkdir(parents=True, exist_ok=True)
    metadata = parse_debt_metadata(debt)
    month = debt.parent.name
    link = f"{month}/{debt.name}"
    title = title_from_debt(debt)
    new_row = [
        month,
        f"[{title}]({link})",
        metadata.get("status", ""),
        metadata.get("priority", ""),
        metadata.get("milestone", ""),
        metadata.get("revisit_trigger", ""),
        notes,
    ]

    rows = [row for row in index_rows(index_file) if link not in row[1]]
    rows.append(new_row)
    rows.sort(key=lambda row: (row[0], row[1].lower()), reverse=True)
    text = "\n".join(
        [
            "# Technical Debt Index",
            "",
            "| Month | Debt | Status | Priority | Milestone | Revisit Trigger | Notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            *["| " + " | ".join(row) + " |" for row in rows],
            "",
        ]
    )
    index_file.write_text(text, encoding="utf-8", newline="\n")


def require_debt(root: Path, slug: str) -> Path:
    matches = find_debts(root, slug)
    if not matches:
        raise CommandError(
            "technical_debt_not_found",
            f"Technical debt asset not found: {slug}",
            path=relative(root, technical_debt_root(root) / "*" / f"*-{slug}-debt.md"),
        )
    if len(matches) > 1:
        paths = ", ".join(relative(root, path) for path in matches)
        raise CommandError(
            "duplicate_technical_debt_slug",
            f"Technical debt slug is ambiguous: {slug} ({paths})",
            path=relative(root, technical_debt_root(root)),
        )
    return matches[0]


def replace_metadata_value(text: str, key: str, value: str) -> str:
    prefix = f"- {key}: "
    lines: list[str] = []
    replaced = False
    for line in text.splitlines():
        if line.startswith(prefix):
            lines.append(f"{prefix}`{value}`")
            replaced = True
        else:
            lines.append(line)
    if not replaced:
        raise CommandError("missing_debt_metadata", f"Missing metadata key: {key}")
    return "\n".join(lines).rstrip() + "\n"


def section_exists(text: str, heading: str) -> bool:
    return f"\n## {heading}\n" in f"\n{text}"


def append_or_replace_section(text: str, heading: str, body: str) -> str:
    text = text.rstrip()
    if not section_exists(text, heading):
        return f"{text}\n\n## {heading}\n\n{body.rstrip()}\n"

    lines = text.splitlines()
    output: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if line == f"## {heading}":
            output.append(line)
            output.append("")
            output.extend(body.rstrip().splitlines())
            index += 1
            while index < len(lines) and not lines[index].startswith("## "):
                index += 1
            continue
        output.append(line)
        index += 1
    return "\n".join(output).rstrip() + "\n"


def create_debt(args: argparse.Namespace) -> dict[str, object]:
    if args.priority not in ALLOWED_PRIORITIES:
        raise CommandError("invalid_debt_priority", f"Invalid priority: {args.priority}")
    root = repo_root(Path(args.root))
    month = month_from_date(args.date)
    debt = technical_debt_root(root) / month / f"{args.date}-{args.slug}-debt.md"
    existing = find_debts(root, args.slug)
    if existing:
        paths = ", ".join(relative(root, path) for path in existing)
        return {
            "status": "needs_attention",
            "issues": [
                {
                    "severity": "error",
                    "code": "duplicate_technical_debt_slug",
                    "message": f"Technical debt slug already exists: {args.slug} ({paths})",
                    "path": relative(root, existing[0]),
                }
            ],
        }

    text = render_template(
        {
            "title": args.title,
            "date": args.date,
            "slug": args.slug,
            "status": "Open",
            "milestone": args.milestone,
            "debt_type": args.debt_type,
            "priority": args.priority,
            "revisit_trigger": args.revisit_trigger,
            "scope": args.scope,
            "related_slice": args.related_slice,
            "summary": args.summary,
            "why_this_is_debt": args.why,
            "current_impact": args.impact,
            "resolution_criteria": args.resolution_criteria,
            "initial_resolution_direction": args.resolution_direction,
            "non_goals": args.non_goal,
            "related_assets": "- None yet.",
        }
    )

    if args.write:
        debt.parent.mkdir(parents=True, exist_ok=True)
        debt.write_text(text, encoding="utf-8", newline="\n")
        write_index(root, debt, args.scope)

    return {"status": "created", "debt": relative(root, debt)}


def set_status(args: argparse.Namespace) -> dict[str, object]:
    if args.status not in ALLOWED_DEBT_STATUSES:
        raise CommandError("invalid_debt_status", f"Invalid status: {args.status}")
    root = repo_root(Path(args.root))
    debt = require_debt(root, args.slug)
    if args.write:
        text = debt.read_text(encoding="utf-8")
        debt.write_text(replace_metadata_value(text, "Status", args.status), encoding="utf-8", newline="\n")
        write_index(root, debt, parse_debt_metadata(debt).get("scope", ""))
    return {"status": "updated", "debt": relative(root, debt)}


def close_debt(args: argparse.Namespace) -> dict[str, object]:
    root = repo_root(Path(args.root))
    debt = require_debt(root, args.slug)
    archive = args.archive.replace("\\", "/")
    if args.write:
        text = debt.read_text(encoding="utf-8")
        text = replace_metadata_value(text, "Status", "Closed")
        text = append_or_replace_section(
            text,
            "Closure",
            "\n".join(
                [
                    args.closure,
                    "",
                    f"- Archive: [{Path(archive).name}]({archive})",
                ]
            ),
        )
        debt.write_text(text, encoding="utf-8", newline="\n")
        write_index(root, debt, parse_debt_metadata(debt).get("scope", ""))
    return {"status": "closed", "debt": relative(root, debt)}


def check(args: argparse.Namespace) -> dict[str, object]:
    issues = check_technical_debt(Path(args.root), args.slug)
    status = "pass" if not any(item["severity"] == "error" for item in issues) else "needs_attention"
    return {"status": status, "issues": issues}


def print_result(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["status"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and maintain project technical debt assets.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--date", required=True)
    create.add_argument("--slug", required=True)
    create.add_argument("--title", required=True)
    create.add_argument("--milestone", required=True)
    create.add_argument("--debt-type", dest="debt_type", required=True)
    create.add_argument("--priority", required=True)
    create.add_argument("--revisit-trigger", dest="revisit_trigger", required=True)
    create.add_argument("--scope", required=True)
    create.add_argument("--related-slice", dest="related_slice", required=True)
    create.add_argument("--summary", required=True)
    create.add_argument("--why", required=True)
    create.add_argument("--impact", required=True)
    create.add_argument("--resolution-criteria", dest="resolution_criteria", required=True)
    create.add_argument("--resolution-direction", dest="resolution_direction", required=True)
    create.add_argument("--non-goal", dest="non_goal", required=True)
    create.add_argument("--write", action="store_true")
    create.add_argument("--json", action="store_true")
    create.set_defaults(func=create_debt)

    status = subparsers.add_parser("set-status")
    status.add_argument("--slug", required=True)
    status.add_argument("--status", required=True)
    status.add_argument("--write", action="store_true")
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=set_status)

    close = subparsers.add_parser("close")
    close.add_argument("--slug", required=True)
    close.add_argument("--archive", required=True)
    close.add_argument("--closure", required=True)
    close.add_argument("--write", action="store_true")
    close.add_argument("--json", action="store_true")
    close.set_defaults(func=close_debt)

    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("--slug")
    check_parser.add_argument("--json", action="store_true")
    check_parser.set_defaults(func=check)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command in {"create", "set-status", "close"} and not args.write:
            raise CommandError("write_required", f"{args.command} requires --write to modify files.")
        result = args.func(args)
    except CommandError as error:
        result = {"status": "needs_attention", "issues": [error.issue]}
        print_result(result, getattr(args, "json", False))
        return 1
    print_result(result, args.json)
    issues = result.get("issues", [])
    if isinstance(issues, list):
        return 1 if any(issue["severity"] == "error" for issue in issues if isinstance(issue, dict)) else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
