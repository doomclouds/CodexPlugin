from __future__ import annotations

import re
from pathlib import Path

from asset_core.issues import issue


ALLOWED_DEBT_STATUSES = {"Open", "In Progress", "Closed", "Superseded", "Won't Fix"}
ALLOWED_PRIORITIES = {"Low", "Medium", "High"}

META_RE = re.compile(r"^\s*- (?P<key>[^:]+): (?P<value>.*)\s*$")
DEBT_LINK_RE = re.compile(r"\[[^\]]+\]\((?P<link>[^)]+-debt\.md)\)")
DEBT_FILENAME_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<slug>.+)-debt\.md$")
REQUIRED_METADATA = {
    "date": "Date",
    "topic_slug": "Topic slug",
    "status": "Status",
    "milestone": "Milestone",
    "debt_type": "Debt type",
    "priority": "Priority",
    "revisit_trigger": "Revisit trigger",
    "scope": "Scope",
    "related_slice": "Related slice",
}


def _repo_root(root: Path) -> Path:
    root = root.resolve()
    if root.name == "technical-debt" and root.parent.name == "docs":
        return root.parent.parent
    if root.name == "superpowers" and root.parent.name == "docs":
        return root.parent.parent
    if root.name == "docs":
        return root.parent
    return root


def _technical_debt_root(root: Path) -> Path:
    return _repo_root(root) / "docs" / "technical-debt"


def _relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _clean_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value.startswith("`") and value.endswith("`"):
        return value[1:-1].strip()
    return value


def _metadata_key(key: str) -> str:
    return key.strip().lower().replace(" ", "_").replace("-", "_")


def _section_text(path: Path, heading: str) -> str:
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8").splitlines()
    capture = False
    collected: list[str] = []
    for line in lines:
        if line.startswith("## "):
            if capture:
                break
            capture = line[3:].strip() == heading
            continue
        if capture:
            collected.append(line)
    return "\n".join(collected).strip()


def _has_meaningful_text(text: str) -> bool:
    cleaned = text.strip()
    return bool(cleaned) and cleaned not in {"None yet.", "TBD", "- TBD", "{{related_assets}}"}


def _has_archive_reference(text: str) -> bool:
    return "-archives.md" in text or "docs/superpowers/archives" in text


def _debt_files(root: Path) -> list[Path]:
    debt_root = _technical_debt_root(root)
    if not debt_root.is_dir():
        return []
    return sorted(path for path in debt_root.glob("*/*-debt.md") if path.name != "INDEX.md")


def _filename_metadata(path: Path) -> tuple[str, str] | None:
    match = DEBT_FILENAME_RE.match(path.name)
    if not match:
        return None
    return match.group("date"), match.group("slug")


def _filename_slug(path: Path) -> str:
    parsed = _filename_metadata(path)
    return parsed[1] if parsed else path.stem.removesuffix("-debt")


def find_debts(root: Path, slug: str) -> list[Path]:
    return [path for path in _debt_files(root) if _filename_slug(path) == slug]


def find_debt(root: Path, slug: str) -> Path | None:
    matches = find_debts(root, slug)
    return matches[0] if len(matches) == 1 else None


def duplicate_slug_issues(root: Path, debts: list[Path]) -> list[dict[str, str]]:
    repo_root = _repo_root(root)
    grouped: dict[str, list[Path]] = {}
    for debt in debts:
        grouped.setdefault(_filename_slug(debt), []).append(debt)

    issues: list[dict[str, str]] = []
    for slug, matches in sorted(grouped.items()):
        if len(matches) <= 1:
            continue
        paths = ", ".join(_relative(repo_root, path) for path in matches)
        issues.append(
            issue(
                "error",
                "duplicate_technical_debt_slug",
                f"Technical debt slug is ambiguous: {slug} ({paths})",
                path=_relative(repo_root, _technical_debt_root(root)),
            )
        )
    return issues


def parse_debt_metadata(path: Path) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = META_RE.match(line)
        if not match:
            continue
        metadata[_metadata_key(match.group("key"))] = _clean_value(match.group("value"))
    return metadata


def _index_rows(index_file: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    if not index_file.exists():
        return rows
    for line_no, line in enumerate(index_file.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 7 or cells[0] == "Month" or all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue
        match = DEBT_LINK_RE.search(cells[1])
        if not match:
            continue
        rows[match.group("link")] = {
            "month": cells[0],
            "status": cells[2],
            "priority": cells[3],
            "milestone": cells[4],
            "line": str(line_no),
        }
    return rows


def _check_one(root: Path, debt: Path, index_rows: dict[str, dict[str, str]], has_index: bool) -> list[dict[str, str]]:
    repo_root = _repo_root(root)
    issues: list[dict[str, str]] = []
    metadata = parse_debt_metadata(debt)
    status = metadata.get("status", "")
    priority = metadata.get("priority", "")
    missing = [label for key, label in REQUIRED_METADATA.items() if not _has_meaningful_text(metadata.get(key, ""))]
    if missing:
        issues.append(
            issue(
                "error",
                "missing_debt_metadata",
                f"Missing required technical debt metadata: {', '.join(missing)}.",
                path=_relative(repo_root, debt),
            )
        )

    filename = _filename_metadata(debt)
    if filename is not None:
        filename_date, filename_slug = filename
        mismatches: list[str] = []
        if metadata.get("date") and metadata["date"] != filename_date:
            mismatches.append(f"Date {metadata['date']!r} != filename date {filename_date!r}")
        if metadata.get("topic_slug") and metadata["topic_slug"] != filename_slug:
            mismatches.append(f"Topic slug {metadata['topic_slug']!r} != filename slug {filename_slug!r}")
        if mismatches:
            issues.append(
                issue(
                    "error",
                    "debt_filename_metadata_mismatch",
                    "; ".join(mismatches),
                    path=_relative(repo_root, debt),
                )
            )

    if status and status not in ALLOWED_DEBT_STATUSES:
        issues.append(
            issue(
                "error",
                "invalid_debt_status",
                f"Invalid technical debt status: {status!r}.",
                path=_relative(repo_root, debt),
            )
        )

    if priority and priority not in ALLOWED_PRIORITIES:
        issues.append(
            issue(
                "error",
                "invalid_debt_priority",
                f"Invalid technical debt priority: {priority!r}.",
                path=_relative(repo_root, debt),
            )
        )

    if status == "Closed":
        closure = _section_text(debt, "Closure")
        if not _has_meaningful_text(closure):
            issues.append(
                issue(
                    "error",
                    "closed_debt_missing_closure",
                    "Closed technical debt must include a Closure section.",
                    path=_relative(repo_root, debt),
                )
            )
        if not _has_archive_reference(closure):
            issues.append(
                issue(
                    "error",
                    "closed_debt_missing_archive",
                    "Closed technical debt must link a resolving archive.",
                    path=_relative(repo_root, debt),
                )
            )

    if status == "Superseded" and not _has_meaningful_text(_section_text(debt, "Replacement")):
        issues.append(
            issue(
                "error",
                "superseded_debt_missing_replacement",
                "Superseded technical debt must include a Replacement section.",
                path=_relative(repo_root, debt),
            )
        )

    if status == "Won't Fix" and not _has_meaningful_text(_section_text(debt, "Won't Fix Reason")):
        issues.append(
            issue(
                "error",
                "wont_fix_debt_missing_reason",
                "Won't Fix technical debt must include a Won't Fix Reason section.",
                path=_relative(repo_root, debt),
            )
        )

    if has_index:
        expected_link = f"{debt.parent.name}/{debt.name}"
        index_row = index_rows.get(expected_link)
        if not index_row:
            issues.append(
                issue(
                    "error",
                    "debt_index_status_mismatch",
                    "Technical debt asset is missing from docs/technical-debt/INDEX.md.",
                    path=_relative(repo_root, debt),
                )
            )
        elif index_row["status"] != status or index_row["priority"] != priority:
            issues.append(
                issue(
                    "error",
                    "debt_index_status_mismatch",
                    (
                        f"Technical debt index status/priority is {index_row['status']} "
                        f"{index_row['priority']}, expected {status} {priority}."
                    ),
                    path=_relative(repo_root, _technical_debt_root(root) / "INDEX.md"),
                )
            )

    return issues


def check_technical_debt(root: Path, slug: str | None = None) -> list[dict[str, str]]:
    repo_root = _repo_root(root)
    debt_root = _technical_debt_root(root)
    issues: list[dict[str, str]] = []
    debts = find_debts(root, slug) if slug else _debt_files(root)

    if slug and not debts:
        return [
            issue(
                "error",
                "technical_debt_not_found",
                f"Technical debt asset not found: {slug}",
                path=_relative(repo_root, debt_root / "*" / f"*-{slug}-debt.md"),
            )
        ]

    issues.extend(duplicate_slug_issues(root, debts if slug else _debt_files(root)))

    index_file = debt_root / "INDEX.md"
    has_index = index_file.exists()
    if debts and not has_index:
        issues.append(
            issue(
                "error",
                "technical_debt_missing_index",
                "Missing docs/technical-debt/INDEX.md.",
                path=_relative(repo_root, index_file),
            )
        )
    index_rows = _index_rows(index_file)

    for debt in debts:
        issues.extend(_check_one(root, debt, index_rows, has_index))

    return issues
