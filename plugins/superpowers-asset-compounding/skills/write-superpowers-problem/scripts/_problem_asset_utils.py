from __future__ import annotations

import re
from pathlib import Path


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
    links: list[tuple[str, str]] = []
    for match in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", text):
        links.append((match.group(1), match.group(2)))
    return links


def is_external_or_placeholder(link: str) -> bool:
    if "://" in link or link.startswith("#"):
        return True
    if "<" in link or ">" in link:
        return True
    return link in {"None yet.", ""}


def resolve_link(base_file: Path, link: str) -> Path:
    link_path = link.split("#", 1)[0]
    return (base_file.parent / link_path).resolve()
