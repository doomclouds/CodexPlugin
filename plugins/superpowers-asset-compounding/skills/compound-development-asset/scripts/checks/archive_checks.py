from __future__ import annotations

from pathlib import Path

from asset_core.discovery import discover_superpowers_root, iter_assets
from asset_core.issues import issue


ARCHIVE_TOPIC_SUFFIXES = (
    "-implementation-plan",
    "-implementation",
    "-design",
    "-archives",
    "-problem",
    "-inbox",
)


def canonical_archive_topic(slug: object) -> str:
    value = str(slug).strip().lower().replace("_", "-").replace(" ", "-")
    if value.endswith(".md"):
        value = value[:-3]
    if len(value) > 11 and value[4] == "-" and value[7] == "-":
        value = value[11:]
    for suffix in ARCHIVE_TOPIC_SUFFIXES:
        if value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def collect_archive_coverage(root: Path) -> tuple[dict[str, set[str]], dict[str, list[Path]], list[dict[str, str]]]:
    try:
        superpowers_root = discover_superpowers_root(root)
    except FileNotFoundError:
        return {}, {}, [
            issue(
                "warning",
                "superpowers_assets_missing",
                "docs/superpowers could not be found; archive coverage could not be checked.",
            )
        ]

    assets = iter_assets(superpowers_root, ["specs", "plans", "archives"])
    by_slug: dict[str, set[str]] = {}
    paths_by_slug: dict[str, list[Path]] = {}
    for asset in assets:
        slug = canonical_archive_topic(asset.slug)
        by_slug.setdefault(slug, set()).add(asset.kind)
        paths_by_slug.setdefault(slug, []).append(asset.path)
    return by_slug, paths_by_slug, []


def check_archive_coverage(root: Path, topics: list[str]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    normalized_topics = {canonical_archive_topic(topic) for topic in topics if str(topic).strip()}
    by_slug, paths_by_slug, discovery_issues = collect_archive_coverage(root)
    if discovery_issues:
        if normalized_topics:
            return [
                issue(
                    "error",
                    "superpowers_assets_missing",
                    "Completed topic check was requested, but docs/superpowers could not be found.",
                )
            ]
        return []

    if not normalized_topics:
        for slug, kinds in sorted(by_slug.items()):
            if {"spec", "plan"}.issubset(kinds) and "archive" not in kinds:
                related_paths = ", ".join(relative(root, path) for path in sorted(paths_by_slug.get(slug, [])))
                issues.append(
                    issue(
                        "warning",
                        "possible_missing_requirement_archive",
                        (
                            f"Topic '{slug}' has spec+plan coverage but no archive. "
                            "If this thread is complete, run with --completed-topic or route to archive."
                        ),
                        path=related_paths,
                    )
                )
        return issues

    matched = False
    for slug in sorted(normalized_topics):
        kinds = by_slug.get(slug, set())
        if kinds:
            matched = True
        if {"spec", "plan"}.issubset(kinds) and "archive" not in kinds:
            related_paths = ", ".join(relative(root, path) for path in sorted(paths_by_slug.get(slug, [])))
            issues.append(
                issue(
                    "error",
                    "missing_requirement_archive",
                    (
                        f"Completed topic '{slug}' has spec+plan coverage but no archive. "
                        "Route to archive or update-existing before close-out."
                    ),
                    path=related_paths,
                )
            )
    if not matched:
        issues.append(
            issue(
                "error",
                "completed_topic_not_found",
                "Completed topic check did not find matching spec, plan, or archive assets.",
                path=", ".join(sorted(normalized_topics)),
            )
        )
    return issues
