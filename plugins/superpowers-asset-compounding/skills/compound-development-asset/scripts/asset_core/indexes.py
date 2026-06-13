from __future__ import annotations

import re
from pathlib import Path

from asset_core.areas import ASSET_AREAS
from asset_core.topics import date_slug_from_name


ENTRY_RE = re.compile(r"^- \[(?P<label>[^\]]+)\]\((?P<link>[^)]+)\):(?P<summary>.*)$")
MONTH_RE = re.compile(r"^## (?P<month>\d{4}-\d{2})\s*$")
TABLE_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
INDEXED_AREAS = ("archives", "problems", "inbox")


def parse_index(index_file: Path) -> tuple[list[str], list[dict[str, str]]]:
    current_month: str | None = None
    months: list[str] = []
    entries: list[dict[str, str]] = []
    for line_no, line in enumerate(index_file.read_text(encoding="utf-8").splitlines(), start=1):
        month_match = MONTH_RE.match(line)
        if month_match:
            current_month = month_match.group("month")
            months.append(current_month)
            continue

        entry_match = ENTRY_RE.match(line)
        if entry_match:
            entries.append(
                {
                    "line": str(line_no),
                    "month": current_month or "",
                    "label": entry_match.group("label"),
                    "link": entry_match.group("link"),
                    "summary": entry_match.group("summary").strip(),
                }
            )
    return months, entries


def parse_table_index(index_file: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for line_no, line in enumerate(index_file.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or all(set(cell) <= {"-", ":", " "} for cell in cells):
            continue
        links = [{"label": match.group(1), "link": match.group(2)} for match in TABLE_LINK_RE.finditer(line)]
        if links:
            entries.append({"line": str(line_no), "links": links})
    return entries


def _normalize_roots(root: Path) -> tuple[Path, Path]:
    root = root.resolve()
    if root.name == "superpowers" and root.parent.name == "docs":
        return root.parent.parent, root
    if root.name == "docs":
        return root.parent, root / "superpowers"
    if (root / "docs" / "superpowers").is_dir():
        return root, root / "docs" / "superpowers"
    if any((root / area).is_dir() for area in INDEXED_AREAS):
        return root, root
    return root, root / "docs" / "superpowers"


def _area_root(root: Path, area: str) -> Path:
    config = ASSET_AREAS[area]
    configured_root = str(config.get("root", ""))
    repo_root, superpowers_root = _normalize_roots(root)
    if configured_root.startswith("docs/superpowers/"):
        return superpowers_root / area
    if configured_root.startswith("docs/"):
        return repo_root / Path(configured_root)
    return root / area


def _is_local_link(link: str) -> bool:
    return bool(link) and "://" not in link and not link.startswith("#")


def _issue(severity: str, area: str, code: str, message: str) -> dict[str, str]:
    return {"severity": severity, "area": area, "code": code, "message": message}


def _asset_files(area_root: Path, suffix: str, index_name: str) -> list[Path]:
    return sorted(path for path in area_root.rglob(f"*{suffix}") if path.name != index_name)


def _check_month_index(area: str, area_root: Path, index_name: str, suffix: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    index_file = area_root / index_name
    asset_files = _asset_files(area_root, suffix, index_name)
    if not index_file.exists():
        if asset_files:
            issues.append(_issue("error", area, "missing_index", f"Missing {index_file}"))
        return issues

    months, entries = parse_index(index_file)
    expected_months = sorted(set(months), reverse=True)
    if months != expected_months:
        issues.append(
            _issue(
                "error",
                area,
                "month_order",
                f"Month headings are not newest-first: {months}",
            )
        )

    seen_targets: dict[str, str] = {}
    indexed_targets: set[Path] = set()
    entries_by_month: dict[str, list[dict[str, str]]] = {}
    for entry in entries:
        link = entry["link"].split("#", 1)[0]
        target = (index_file.parent / link).resolve()
        indexed_targets.add(target)
        entries_by_month.setdefault(entry["month"], []).append(entry)

        if str(target) in seen_targets:
            issues.append(
                _issue("error", area, "duplicate_entry", f"Duplicate link at line {entry['line']}: {entry['link']}")
            )
        seen_targets[str(target)] = entry["line"]

        if not target.exists():
            issues.append(_issue("error", area, "dead_link", f"Dead link at line {entry['line']}: {entry['link']}"))
            continue

        parsed = date_slug_from_name(target.name, suffix)
        if parsed and entry["month"] and parsed[0][:7] != entry["month"]:
            issues.append(
                _issue("error", area, "wrong_month_group", f"{target.name} is under index month {entry['month']}")
            )

        if not entry["summary"]:
            issues.append(
                _issue("warning", area, "missing_summary", f"Missing summary at line {entry['line']}: {entry['link']}")
            )

    for month, month_entries in entries_by_month.items():
        sortable: list[tuple[str, str, dict[str, str]]] = []
        for entry in month_entries:
            target = (index_file.parent / entry["link"].split("#", 1)[0]).resolve()
            parsed = date_slug_from_name(target.name, suffix)
            if parsed:
                sortable.append((parsed[0], parsed[1], entry))
        expected = sorted(sortable, key=lambda item: (-int(item[0].replace("-", "")), item[1]))
        if sortable != expected:
            issues.append(
                _issue("error", area, "entry_order", f"Entries under {month} are not newest-first then slug-sorted")
            )

    for asset_file in asset_files:
        if asset_file.resolve() not in indexed_targets:
            issues.append(
                _issue(
                    "error",
                    area,
                    "orphan_asset",
                    f"Asset file is missing from index: {asset_file.relative_to(area_root)}",
                )
            )

    return issues


def _check_table_index(area: str, area_root: Path, index_name: str, suffix: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    index_file = area_root / index_name
    asset_files = _asset_files(area_root, suffix, index_name)
    if not index_file.exists():
        if asset_files:
            issues.append(_issue("error", area, "missing_index", f"Missing {index_file}"))
        return issues

    seen_targets: dict[str, str] = {}
    indexed_targets: set[Path] = set()
    for entry in parse_table_index(index_file):
        links = entry["links"]
        assert isinstance(links, list)
        for link_info in links:
            link = str(link_info["link"]).split("#", 1)[0]
            if not _is_local_link(link):
                continue
            target = (index_file.parent / link).resolve()
            if str(target) in seen_targets:
                issues.append(
                    _issue(
                        "error",
                        area,
                        "duplicate_entry",
                        f"Duplicate link at line {entry['line']}: {link_info['link']}",
                    )
                )
            seen_targets[str(target)] = str(entry["line"])

            if target.name.endswith(suffix):
                indexed_targets.add(target)

            if not target.exists():
                issues.append(
                    _issue("error", area, "dead_link", f"Dead link at line {entry['line']}: {link_info['link']}")
                )

    for asset_file in asset_files:
        if asset_file.resolve() not in indexed_targets:
            issues.append(
                _issue(
                    "error",
                    area,
                    "orphan_asset",
                    f"Asset file is missing from index: {asset_file.relative_to(area_root)}",
                )
            )

    return issues


def check_area(root: Path, area: str) -> list[dict[str, str]]:
    config = ASSET_AREAS[area]
    index_name = config.get("index")
    if not index_name:
        return []

    area_root = _area_root(root, area)
    issues: list[dict[str, str]] = []
    if not area_root.exists():
        return issues

    suffix = str(config["suffix"])
    if config.get("month_index"):
        return _check_month_index(area, area_root, str(index_name), suffix)
    return _check_table_index(area, area_root, str(index_name), suffix)
