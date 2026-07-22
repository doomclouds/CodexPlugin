from __future__ import annotations

import re


ASSET_SUFFIXES = (
    "-implementation-plan",
    "-implementation",
    "-design",
    "-archives",
    "-problem",
    "-inbox",
    "-debt",
)


def canonical_slug(slug: object) -> str:
    value = str(slug).strip().lower().replace("_", "-").replace(" ", "-")
    if value.endswith(".md"):
        value = value[:-3]
    if len(value) > 11 and value[4] == "-" and value[7] == "-":
        value = value[11:]
    for suffix in ASSET_SUFFIXES:
        if value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def date_slug_from_name(name: str, suffix: str) -> tuple[str, str] | None:
    if not name.endswith(suffix):
        return None
    stem = name[: -len(suffix)]
    match = re.match(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<slug>.+)$", stem)
    if not match:
        return None
    return match.group("date"), match.group("slug")
