#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from _problem_asset_utils import (
    extract_metadata,
    extract_sections,
    is_external_or_placeholder,
    markdown_links,
    read_text,
    resolve_link,
)


PROBLEM_METADATA = ["Date", "Topic slug", "Status", "Scope", "Tags"]
PROBLEM_SECTIONS = [
    "Symptom",
    "Trigger / Context",
    "Root Cause",
    "Fix",
    "Why This Fix",
    "Recognition Clues",
    "Applicability / Non-Applicability",
    "Related Artifacts",
]

INBOX_METADATA = ["Date", "Topic slug", "Status", "Scope", "Confidence", "Route candidate"]
INBOX_SECTIONS = [
    "Signal",
    "Why It Might Matter",
    "What Is Missing",
    "Likely Next Route",
    "Related Assets",
]

ROUTE_CANDIDATES = {"update-existing", "new-problem", "archive", "both", "unknown"}
CONFIDENCE_VALUES = {"Low", "Medium"}
LIFECYCLE_VALUES = {"Open", "Partially promoted", "Promoted", "Closed"}


def infer_kind(path: Path, metadata: dict[str, str]) -> str:
    if path.name.endswith("-inbox.md") or metadata.get("Status") == "Inbox":
        return "inbox"
    return "problem"


def expected_date_slug(path: Path, kind: str) -> tuple[str | None, str | None]:
    suffix = f"-{kind}.md"
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


def validate(path: Path, kind: str | None = None) -> dict[str, object]:
    text = read_text(path)
    metadata = extract_metadata(text)
    actual_kind = kind if kind and kind != "auto" else infer_kind(path, metadata)
    required_metadata = INBOX_METADATA if actual_kind == "inbox" else PROBLEM_METADATA
    required_sections = INBOX_SECTIONS if actual_kind == "inbox" else PROBLEM_SECTIONS
    sections = extract_sections(text)
    issues: list[dict[str, str]] = []

    for key in required_metadata:
        if key not in metadata:
            issues.append({"severity": "error", "code": "missing_metadata", "message": f"Missing metadata: {key}"})

    for section in required_sections:
        if section not in sections:
            issues.append({"severity": "error", "code": "missing_section", "message": f"Missing section: {section}"})

    expected_date, expected_slug = expected_date_slug(path, actual_kind)
    if expected_date and metadata.get("Date") and metadata["Date"] != expected_date:
        issues.append({"severity": "error", "code": "date_mismatch", "message": f"Date metadata {metadata['Date']} does not match file date {expected_date}"})
    if expected_slug and metadata.get("Topic slug") and metadata["Topic slug"] != expected_slug:
        issues.append({"severity": "error", "code": "slug_mismatch", "message": f"Topic slug {metadata['Topic slug']} does not match file slug {expected_slug}"})

    if actual_kind == "inbox":
        lifecycle = metadata.get("Lifecycle")
        revisit_trigger = metadata.get("Revisit trigger")
        if not lifecycle or not revisit_trigger:
            issues.append({
                "severity": "warning",
                "code": "missing_lifecycle",
                "message": "Inbox assets should include Lifecycle and Revisit trigger metadata.",
            })
        if lifecycle and lifecycle not in LIFECYCLE_VALUES:
            issues.append({"severity": "error", "code": "invalid_lifecycle", "message": f"Lifecycle must be one of {sorted(LIFECYCLE_VALUES)}"})
        confidence = metadata.get("Confidence")
        if confidence and confidence not in CONFIDENCE_VALUES:
            issues.append({"severity": "error", "code": "invalid_confidence", "message": f"Confidence must be one of {sorted(CONFIDENCE_VALUES)}"})
        route = metadata.get("Route candidate")
        if route and route not in ROUTE_CANDIDATES:
            issues.append({"severity": "error", "code": "invalid_route_candidate", "message": f"Route candidate must be one of {sorted(ROUTE_CANDIDATES)}"})
    else:
        status = metadata.get("Status")
        if status and status != "Captured":
            issues.append({"severity": "warning", "code": "unexpected_status", "message": "Problem Status is usually `Captured`"})
        if "Applies When" not in text or "Does Not Apply When" not in text:
            issues.append({"severity": "error", "code": "missing_applicability_boundary", "message": "Applicability section must include Applies When and Does Not Apply When"})

    issues.extend(check_links(path, text))
    return {"path": str(path), "kind": actual_kind, "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a problem or inbox asset document.")
    parser.add_argument("file", help="Problem or inbox markdown file.")
    parser.add_argument("--kind", choices=["auto", "problem", "inbox"], default="auto")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = validate(Path(args.file).resolve(), args.kind)
    issues = result["issues"]
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if not issues:
            print(f"OK: {result['kind']} asset is valid: {result['path']}")
        else:
            for issue in issues:
                print(f"{issue['severity'].upper()} [{issue['code']}]: {issue['message']}")

    return 1 if any(issue["severity"] == "error" for issue in issues) else 0


if __name__ == "__main__":
    sys.exit(main())
