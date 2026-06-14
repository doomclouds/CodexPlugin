from __future__ import annotations

import re
from pathlib import Path

from asset_core.issues import issue


ALLOWED_MILESTONE_STATUSES = {"Not Started", "In Progress", "Done", "Deferred", "Split"}

SLICE_RE = re.compile(r"^- \[(?P<mark>[ xX])\] (?P<number>\d+)\. (?P<title>.+?)\s*$")
META_RE = re.compile(r"^\s*- (?P<key>[^:]+): (?P<value>.*)\s*$")
README_LINK_RE = re.compile(r"\[[^\]]+\]\((?P<link>[^)]+README\.md)\)")


def _repo_root(root: Path) -> Path:
    root = root.resolve()
    if root.name == "superpowers" and root.parent.name == "docs":
        return root.parent.parent
    if root.name == "docs":
        return root.parent
    return root


def _milestones_root(root: Path) -> Path:
    return _repo_root(root) / "docs" / "milestones"


def _relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


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
    return bool(cleaned) and cleaned not in {"{{strategic_significance}}", "None yet.", "TBD", "- TBD"}


def find_milestone(root: Path, slug: str) -> Path | None:
    milestones_root = _milestones_root(root)
    if not milestones_root.is_dir():
        return None
    for path in sorted(milestones_root.glob(f"*/{slug}")):
        if path.is_dir():
            return path
    return None


def parse_checklist(checklist: Path) -> dict[str, object]:
    summary: dict[str, str] = {}
    slices: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    in_summary = False

    for line in checklist.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            in_summary = line == "## Progress Summary"
            current = None
            continue

        if in_summary:
            match = META_RE.match(line)
            if match:
                summary[match.group("key").strip().lower()] = match.group("value").strip()
            continue

        slice_match = SLICE_RE.match(line)
        if slice_match:
            current = {
                "number": slice_match.group("number"),
                "title": slice_match.group("title"),
                "mark": slice_match.group("mark"),
                "status": "Done" if slice_match.group("mark").lower() == "x" else "Not Started",
                "spec": "None yet.",
                "plan": "None yet.",
                "archive": "None yet.",
                "completion_signal": "Pending.",
            }
            slices.append(current)
            continue

        meta_match = META_RE.match(line)
        if current is not None and meta_match:
            key = meta_match.group("key").strip().lower().replace("related ", "").replace(" ", "_")
            value = meta_match.group("value").strip()
            current[key] = value

    return {"summary": summary, "slices": slices}


def recompute_summary(checklist: Path) -> dict[str, object]:
    parsed = parse_checklist(checklist)
    slices = parsed["slices"]
    assert isinstance(slices, list)
    done = sum(1 for item in slices if isinstance(item, dict) and item.get("status") == "Done")
    in_progress = sum(1 for item in slices if isinstance(item, dict) and item.get("status") == "In Progress")
    not_started = sum(1 for item in slices if isinstance(item, dict) and item.get("status") == "Not Started")
    deferred = sum(1 for item in slices if isinstance(item, dict) and item.get("status") == "Deferred")
    split = sum(1 for item in slices if isinstance(item, dict) and item.get("status") == "Split")
    total = len(slices)
    if total > 0 and done == total:
        status = "Done"
    elif done > 0 or in_progress > 0:
        status = "In Progress"
    elif split > 0:
        status = "Split"
    elif deferred > 0:
        status = "Deferred"
    else:
        status = "Not Started"
    return {
        "status": status,
        "progress": f"{done}/{total}",
        "done": done,
        "in_progress": in_progress,
        "not_started": not_started,
        "deferred": deferred,
        "split": split,
    }


def _milestone_dirs(root: Path, slug: str | None) -> list[Path]:
    if slug:
        found = find_milestone(root, slug)
        return [found] if found else []
    milestones_root = _milestones_root(root)
    if not milestones_root.is_dir():
        return []
    return sorted(path for path in milestones_root.glob("*/*") if path.is_dir())


def _index_rows(index_file: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    if not index_file.exists():
        return rows
    for line in index_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 5 or cells[0] == "Month" or all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue
        match = README_LINK_RE.search(cells[1])
        if not match:
            continue
        rows[match.group("link")] = {
            "month": cells[0],
            "status": cells[3],
            "progress": cells[4],
            "line": line,
        }
    return rows


def _check_one(root: Path, milestone: Path) -> list[dict[str, str]]:
    repo_root = _repo_root(root)
    issues: list[dict[str, str]] = []
    readme = milestone / "README.md"
    checklist = milestone / "CHECKLIST.md"

    if not readme.exists():
        issues.append(issue("error", "milestone_missing_readme", f"Missing {readme}", path=_relative(repo_root, readme)))
    if not checklist.exists():
        issues.append(
            issue("error", "milestone_missing_checklist", f"Missing {checklist}", path=_relative(repo_root, checklist))
        )
        return issues

    parsed = parse_checklist(checklist)
    slices = parsed["slices"]
    summary = parsed["summary"]
    assert isinstance(slices, list)
    assert isinstance(summary, dict)

    if readme.exists() and len(slices) <= 2 and not _has_meaningful_text(_section_text(readme, "Strategic Significance")):
        issues.append(
            issue(
                "warning",
                "small_milestone_missing_strategic_significance",
                "Small milestones must explain strategic significance instead of only listing slices.",
                path=_relative(repo_root, readme),
            )
        )

    expected = recompute_summary(checklist)
    for key, expected_value in expected.items():
        actual = summary.get(str(key).replace("_", " "))
        if str(actual) != str(expected_value):
            issues.append(
                issue(
                    "error",
                    "milestone_progress_mismatch",
                    f"Checklist summary {key} is {actual!r}, expected {expected_value!r}.",
                    path=_relative(repo_root, checklist),
                )
            )
            break

    invalid_statuses: list[str] = []
    status = summary.get("status")
    if isinstance(status, str) and status not in ALLOWED_MILESTONE_STATUSES:
        invalid_statuses.append(status)
    for item in slices:
        if isinstance(item, dict) and str(item.get("status")) not in ALLOWED_MILESTONE_STATUSES:
            invalid_statuses.append(str(item.get("status")))
    if invalid_statuses:
        issues.append(
            issue(
                "error",
                "invalid_milestone_status",
                f"Invalid milestone status value(s): {', '.join(sorted(set(invalid_statuses)))}",
                path=_relative(repo_root, checklist),
            )
        )

    for item in slices:
        if not isinstance(item, dict) or item.get("status") != "Done":
            continue
        archive = str(item.get("archive", "")).strip()
        if not archive or archive == "None yet.":
            issues.append(
                issue(
                    "error",
                    "done_slice_missing_archive",
                    f"Done slice is missing a related archive: {item.get('title')}",
                    path=_relative(repo_root, checklist),
                )
            )

    index_file = _milestones_root(root) / "INDEX.md"
    month = milestone.parent.name
    slug = milestone.name
    expected_link = f"{month}/{slug}/README.md"
    rows = _index_rows(index_file)
    index_row = rows.get(expected_link)
    if not index_row:
        issues.append(
            issue(
                "error",
                "milestone_index_mismatch",
                f"Milestone is missing from {index_file}.",
                path=_relative(repo_root, readme),
            )
        )
    elif index_row["status"] != str(expected["status"]) or index_row["progress"] != str(expected["progress"]):
        issues.append(
            issue(
                "error",
                "milestone_index_mismatch",
                (
                    f"Milestone index status/progress is {index_row['status']} {index_row['progress']}, "
                    f"expected {expected['status']} {expected['progress']}."
                ),
                path=_relative(repo_root, index_file),
            )
        )

    return issues


def check_milestone(root: Path, slug: str | None = None) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    milestones = _milestone_dirs(root, slug)
    if slug and not milestones:
        milestone = _milestones_root(root) / "*" / slug
        return [
            issue(
                "error",
                "milestone_not_found",
                f"Milestone not found: {slug}",
                path=_relative(_repo_root(root), milestone),
            )
        ]
    for milestone in milestones:
        issues.extend(_check_one(root, milestone))
    return issues
