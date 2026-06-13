from __future__ import annotations

import re
from pathlib import Path

from asset_core.issues import issue


ALLOWED_DEBT_STATUSES = {"Open", "In Progress", "Closed", "Superseded", "Won't Fix"}
ALLOWED_PRIORITIES = {"Low", "Medium", "High"}

META_RE = re.compile(r"^\s*- (?P<key>[^:]+): (?P<value>.*)\s*$")
DEBT_LINK_RE = re.compile(r"\[[^\]]+\]\((?P<link>[^)]+-debt\.md)\)")


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


def _debt_files(root: Path) -> list[Path]:
    debt_root = _technical_debt_root(root)
    if not debt_root.is_dir():
        return []
    return sorted(path for path in debt_root.glob("*/*-debt.md") if path.name != "INDEX.md")


def find_debt(root: Path, slug: str) -> Path | None:
    suffix = f"-{slug}-debt.md"
    for path in _debt_files(root):
        if path.name.endswith(suffix):
            return path
    return None


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


def _has_archive_reference(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    return "-archives.md" in text or "docs/superpowers/archives" in text


def _check_one(root: Path, debt: Path, index_rows: dict[str, dict[str, str]], has_index: bool) -> list[dict[str, str]]:
    repo_root = _repo_root(root)
    issues: list[dict[str, str]] = []
    metadata = parse_debt_metadata(debt)
    status = metadata.get("status", "")
    priority = metadata.get("priority", "")

    if status not in ALLOWED_DEBT_STATUSES:
        issues.append(
            issue(
                "error",
                "invalid_debt_status",
                f"Invalid technical debt status: {status!r}.",
                path=_relative(repo_root, debt),
            )
        )

    if priority not in ALLOWED_PRIORITIES:
        issues.append(
            issue(
                "error",
                "invalid_debt_priority",
                f"Invalid technical debt priority: {priority!r}.",
                path=_relative(repo_root, debt),
            )
        )

    if status == "Closed":
        if not _has_meaningful_text(_section_text(debt, "Closure")):
            issues.append(
                issue(
                    "error",
                    "closed_debt_missing_closure",
                    "Closed technical debt must include a Closure section.",
                    path=_relative(repo_root, debt),
                )
            )
        if not _has_archive_reference(debt):
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
    debts = [find_debt(root, slug)] if slug else _debt_files(root)
    debts = [path for path in debts if path is not None]

    if slug and not debts:
        return [
            issue(
                "error",
                "technical_debt_not_found",
                f"Technical debt asset not found: {slug}",
                path=_relative(repo_root, debt_root / "*" / f"*-{slug}-debt.md"),
            )
        ]

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
