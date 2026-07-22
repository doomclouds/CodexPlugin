#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ARCHIVE_METADATA = ["Date", "Topic slug", "Status", "Scope", "Tags"]
ARCHIVE_SECTIONS = [
    "Summary",
    "Delivered Scope",
    "Out of Scope",
    "Verification Snapshot",
    "Source Documents",
    "Related Problems",
    "Notes",
]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract_metadata(text: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for line in text.splitlines():
        if not line.startswith("- "):
            continue
        raw = line[2:].strip()
        if ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        metadata[key.strip()] = value.strip().strip("`")
    return metadata


def extract_sections(text: str) -> set[str]:
    return {line[3:].strip() for line in text.splitlines() if line.startswith("## ")}


def markdown_links(text: str) -> list[tuple[str, str]]:
    return [(match.group(1), match.group(2)) for match in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", text)]


def is_external_or_placeholder(link: str) -> bool:
    if "://" in link or link.startswith("#"):
        return True
    if "<" in link or ">" in link:
        return True
    return link in {"None yet.", "None found for this topic.", ""}


def resolve_link(base_file: Path, link: str) -> Path:
    link_path = link.split("#", 1)[0]
    return (base_file.parent / link_path).resolve()


def expected_date_slug(path: Path) -> tuple[str | None, str | None]:
    suffix = "-archives.md"
    if not path.name.endswith(suffix):
        return None, None
    stem = path.name[: -len(suffix)]
    match = re.match(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<slug>.+)$", stem)
    if not match:
        return None, None
    return match.group("date"), match.group("slug")


def check_links(path: Path, text: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for label, link in markdown_links(text):
        if is_external_or_placeholder(link):
            continue
        target = resolve_link(path, link)
        if not target.exists():
            issues.append({"severity": "error", "code": "dead_link", "message": f"Dead link '{label}' -> {link}"})
    return issues


def validate(path: Path) -> dict[str, object]:
    text = read_text(path)
    metadata = extract_metadata(text)
    sections = extract_sections(text)
    issues: list[dict[str, str]] = []

    for key in ARCHIVE_METADATA:
        if key not in metadata:
            issues.append({"severity": "error", "code": "missing_metadata", "message": f"Missing metadata: {key}"})

    for section in ARCHIVE_SECTIONS:
        if section not in sections:
            issues.append({"severity": "error", "code": "missing_section", "message": f"Missing section: {section}"})

    expected_date, expected_slug = expected_date_slug(path)
    if expected_date and metadata.get("Date") and metadata["Date"] != expected_date:
        issues.append({"severity": "error", "code": "date_mismatch", "message": f"Date metadata {metadata['Date']} does not match file date {expected_date}"})
    if expected_slug and metadata.get("Topic slug") and metadata["Topic slug"] != expected_slug:
        issues.append({"severity": "error", "code": "slug_mismatch", "message": f"Topic slug {metadata['Topic slug']} does not match file slug {expected_slug}"})

    status = metadata.get("Status")
    if status and status != "Archived":
        issues.append({"severity": "warning", "code": "unexpected_status", "message": "Archive Status is usually `Archived`"})

    issues.extend(check_links(path, text))
    return {"path": str(path), "kind": "archive", "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Superpowers archive asset document.")
    parser.add_argument("file", help="Archive markdown file.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = validate(Path(args.file).resolve())
    issues = result["issues"]
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if not issues:
            print(f"OK: archive asset is valid: {result['path']}")
        else:
            for issue in issues:
                print(f"{issue['severity'].upper()} [{issue['code']}]: {issue['message']}")

    return 1 if any(issue["severity"] == "error" for issue in issues) else 0


if __name__ == "__main__":
    sys.exit(main())
