from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from asset_core.areas import ASSET_AREAS


DATE_SLUG_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<slug>.+)$")


@dataclass(frozen=True)
class AssetFile:
    area: str
    kind: str
    path: Path
    date: str | None
    slug: str
    title: str | None


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def discover_superpowers_root(root: Path) -> Path:
    root = root.resolve()
    if root.name == "superpowers" and root.is_dir():
        return root

    candidate = root / "docs" / "superpowers"
    if candidate.is_dir():
        return candidate.resolve()

    if (root / "archives").is_dir() or (root / "problems").is_dir() or (root / "inbox").is_dir():
        return root

    raise FileNotFoundError(f"Cannot find docs/superpowers under {root}")


def split_date_slug(path: Path, suffix: str) -> tuple[str | None, str]:
    name = path.name
    stem = name[:-len(suffix)] if suffix and name.endswith(suffix) else path.stem
    match = DATE_SLUG_RE.match(stem)
    if not match:
        return None, stem
    return match.group("date"), match.group("slug")


def read_title(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def _repo_root_from_asset_root(root: Path) -> Path:
    if root.name == "superpowers" and root.parent.name == "docs":
        return root.parent.parent
    if (root / "docs" / "superpowers").is_dir():
        return root
    return root


def _area_root(root: Path, area: str) -> Path:
    configured_root = str(ASSET_AREAS[area].get("root", ""))
    if configured_root.startswith("docs/"):
        return _repo_root_from_asset_root(root) / Path(configured_root)
    return root / area


def iter_assets(root: Path, areas: list[str] | None = None) -> list[AssetFile]:
    selected = areas or list(ASSET_AREAS)
    assets: list[AssetFile] = []
    for area in selected:
        config = ASSET_AREAS[area]
        area_root = _area_root(root, area)
        if not area_root.is_dir():
            continue
        suffix = str(config["suffix"])
        pattern = "*.md" if area == "plans" else f"*{suffix}"
        for path in sorted(area_root.rglob(pattern)):
            if path.name == "INDEX.md":
                continue
            text = read_text(path)
            date, slug = split_date_slug(path, suffix)
            assets.append(
                AssetFile(
                    area=area,
                    kind=str(config["kind"]),
                    path=path,
                    date=date,
                    slug=slug,
                    title=read_title(text),
                )
            )
    return assets


def extract_metadata(text: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for line in text.splitlines():
        if not line.startswith("- "):
            continue
        raw = line[2:].strip()
        if ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        value = value.strip().strip("`")
        metadata[key.strip()] = value
    return metadata


def extract_sections(text: str) -> set[str]:
    sections: set[str] = set()
    for line in text.splitlines():
        if line.startswith("## "):
            sections.add(line[3:].strip())
    return sections


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


def tokenize_query(raw_terms: list[str]) -> list[str]:
    terms: list[str] = []
    for raw in raw_terms:
        for part in re.split(r"[\s,;:/\\|]+", raw.strip().lower()):
            if not part:
                continue
            terms.append(part)
            if "-" in part:
                terms.extend(token for token in part.split("-") if token)
    seen: set[str] = set()
    result: list[str] = []
    for term in terms:
        if term not in seen:
            seen.add(term)
            result.append(term)
    return result


parse_date_slug = split_date_slug
first_heading = read_title
