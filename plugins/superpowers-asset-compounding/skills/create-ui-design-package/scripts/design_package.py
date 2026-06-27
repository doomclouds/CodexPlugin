#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path


TOKEN_KEYS = ("colors", "typography", "spacing", "shape", "elevation", "breakpoints", "motion")
PACKAGE_FILES = (
    "START_HERE.md",
    "design-brief.md",
    "visual-source.md",
    "visual-decision-log.md",
    "prototype-implementation.md",
    "subagent-task-pack.md",
    "visual-fidelity-checklist.md",
    "design-tokens.json",
    "asset-manifest.json",
    "traceability.md",
    "component-board.md",
)
PACKAGE_DIRS = (
    "contracts",
    "guides",
    "assets/generated-options",
    "assets/source",
    "assets/screenshots",
    "assets/component-assets",
    "assets/component-assets/raw",
    "assets/component-assets/preview",
    "prototype",
    "prototype/src/assets/generated",
)
CONTRACT_FILES = (
    "contracts/visual-system.md",
    "contracts/layout-and-regions.md",
    "contracts/component-contracts.md",
    "contracts/states-and-variants.md",
    "contracts/interaction-flows.md",
    "contracts/accessibility-and-responsive.md",
    "contracts/design-tokens.md",
)
GUIDE_FILES = (
    "guides/implementation-readiness.md",
    "guides/subagent-implementation-guide.md",
    "guides/design-readiness-review.md",
)
PLACEHOLDER_MARKERS = ("TODO", "TBD")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SAFE_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SECONDARY_SCREENSHOT_MARKERS = ("mobile", "narrow", "no-color", "no_color", "nocolor")
IGNORED_MARKDOWN_DIR_PARTS = {
    "node_modules",
    ".npm-cache",
    "dist",
    ".vite",
    "coverage",
    "__pycache__",
}
ASSET_STRATEGIES = {"none", "atomic-generated-assets"}
ASSET_REQUIRED_KEYS = (
    "id",
    "role",
    "target_region",
    "display_intent",
    "target_size",
    "final_path",
    "prototype_path",
    "transparent",
)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def title_from_slug(slug: str) -> str:
    return " ".join(part.capitalize() for part in slug.split("-") if part)


def resolve_package_path(root: Path, package: Path | str) -> Path:
    package_path = Path(package)
    if package_path.is_absolute():
        return package_path.resolve()
    return (root / package_path).resolve()


def designs_root(root: Path) -> Path:
    return (root / "docs" / "designs").resolve()


def validate_package_location(root: Path, package: Path) -> list[dict[str, str]]:
    allowed_root = designs_root(root)
    if package.is_relative_to(allowed_root):
        return []
    return [
        issue(
            "design_package_outside_docs_designs",
            "Package path must resolve inside <repo>/docs/designs.",
            package,
        )
    ]


def validate_design_slug(root: Path, slug: str) -> list[dict[str, str]]:
    package = package_path(root, slug)
    if not SAFE_SLUG_RE.fullmatch(slug):
        return [
            issue(
                "invalid_design_slug",
                "Slug must be a lowercase hyphen slug made of letters, numbers, and hyphens.",
                package,
            )
        ]
    allowed_root = designs_root(root)
    resolved_package = package.resolve()
    if not resolved_package.is_relative_to(allowed_root):
        return [
            issue(
                "invalid_design_slug",
                "Slug must resolve inside docs/designs.",
                package,
            )
        ]
    return []


def render_template(name: str, slug: str, mode: str, source: str) -> str:
    path = skill_root() / "references" / name
    text = path.read_text(encoding="utf-8")
    replacements = {
        "{{DESIGN_SLUG}}": slug,
        "{{DESIGN_TITLE}}": title_from_slug(slug),
        "{{DATE}}": date.today().isoformat(),
        "{{MODE}}": mode,
        "{{SOURCE_PACKAGE}}": source or "none",
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


def write_text(path: Path, text: str, write: bool) -> None:
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")


def package_path(root: Path, slug: str) -> Path:
    return root / "docs" / "designs" / slug


def create_package(root: Path, slug: str, mode: str, source: str, write: bool) -> dict[str, object]:
    errors = validate_design_slug(root, slug)
    package = package_path(root, slug)
    if errors:
        return {
            "status": "needs_attention",
            "package": str(package),
            "errors": errors,
            "warnings": [],
            "created": [],
        }

    created: list[str] = []
    for relative in PACKAGE_DIRS:
        target = package / relative
        created.append(str(target))
        if write:
            target.mkdir(parents=True, exist_ok=True)

    template_map = {
        "START_HERE.md": "start-here-template.md",
        "design-brief.md": "design-brief-template.md",
        "visual-source.md": "visual-source-template.md",
        "visual-decision-log.md": "visual-decision-log-template.md",
        "prototype-implementation.md": "prototype-implementation-template.md",
        "subagent-task-pack.md": "subagent-task-pack-template.md",
        "visual-fidelity-checklist.md": "visual-fidelity-checklist-template.md",
        "traceability.md": "traceability-template.md",
        "component-board.md": "component-board-template.md",
    }
    for relative, template in template_map.items():
        target = package / relative
        write_text(target, render_template(template, slug, mode, source), write)
        created.append(str(target))

    tokens = {key: {} for key in TOKEN_KEYS}
    tokens_path = package / "design-tokens.json"
    if write:
        tokens_path.parent.mkdir(parents=True, exist_ok=True)
        tokens_path.write_text(
            json.dumps(tokens, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    created.append(str(tokens_path))

    manifest = {
        "design_slug": slug,
        "source_image": "assets/source/selected-ui-design.png",
        "asset_strategy": "none",
        "reason": "No runtime bitmap assets are required for this package.",
        "assets": [],
    }
    manifest_path = package / "asset-manifest.json"
    if write:
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    created.append(str(manifest_path))

    for relative in CONTRACT_FILES:
        target = package / relative
        content = (
            f"# {title_from_slug(Path(relative).stem)}\n\n"
            f"Package: `{slug}`\n\n"
            "## Acceptance Checklist\n\n"
            "- Define contract details before implementation.\n"
        )
        write_text(target, content, write)
        created.append(str(target))

    for relative in GUIDE_FILES:
        target = package / relative
        content = (
            f"# {title_from_slug(Path(relative).stem)}\n\n"
            f"Package: `{slug}`\n\n"
            "## Guidance\n\n"
            "Use this file to record implementation readiness, subagent notes, or design review evidence.\n"
        )
        write_text(target, content, write)
        created.append(str(target))

    return {"status": "created" if write else "dry_run", "package": str(package), "created": created}


def issue(code: str, message: str, path: Path | None = None) -> dict[str, str]:
    result = {"code": code, "message": message}
    if path is not None:
        result["path"] = str(path)
    return result


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def png_metadata(path: Path) -> tuple[int, int, bool] | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if len(data) < 33 or not data.startswith(PNG_SIGNATURE):
        return None
    if data[12:16] != b"IHDR":
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    color_type = data[25]
    has_alpha = color_type in {4, 6}
    return width, height, has_alpha


def parse_size(value: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"(\d+)x(\d+)", str(value).strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def has_approved_source(package: Path) -> bool:
    source_text = read_text(package / "visual-source.md").lower()
    return "approval status: `approved`" in source_text or "approval status: approved" in source_text


def validate_tokens(package: Path) -> list[dict[str, str]]:
    path = package / "design-tokens.json"
    if not path.exists():
        return [issue("missing_design_tokens", "design-tokens.json is required.", path)]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [issue("invalid_design_tokens_json", f"design-tokens.json is invalid JSON: {exc}", path)]
    errors = []
    for key in TOKEN_KEYS:
        if key not in data:
            errors.append(issue("missing_design_token_key", f"Missing top-level token key: {key}", path))
    return errors


def is_ignored_markdown_path(path: Path) -> bool:
    return any(part in IGNORED_MARKDOWN_DIR_PARTS for part in path.parts)


def markdown_files(package: Path) -> list[Path]:
    return sorted(path for path in package.rglob("*.md") if not is_ignored_markdown_path(path.relative_to(package)))


def local_markdown_links(text: str) -> list[str]:
    return re.findall(r"\[[^\]]+\]\(([^)]+)\)", text)


def validate_links(package: Path) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    for md in markdown_files(package):
        text = md.read_text(encoding="utf-8")
        for target in local_markdown_links(text):
            if "://" in target or target.startswith("#"):
                continue
            clean = target.split("#", 1)[0].strip()
            if not clean:
                continue
            resolved = (md.parent / clean).resolve()
            if not resolved.exists():
                errors.append(issue("dead_markdown_link", f"Dead local link: {target}", md))
    return errors


def validate_placeholders(package: Path) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    for path in [*markdown_files(package), package / "design-tokens.json"]:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for marker in PLACEHOLDER_MARKERS:
            if marker in text:
                errors.append(issue("unresolved_placeholder", f"Unresolved marker {marker}", path))
    return errors


def screenshot_paths(package: Path) -> list[Path]:
    root = package / "assets" / "screenshots"
    if not root.exists():
        return []
    return sorted(path for path in root.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)


def generated_option_paths(package: Path) -> list[Path]:
    root = package / "assets" / "generated-options"
    if not root.exists():
        return []
    return sorted(path for path in root.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)


def screenshot_categories(paths: list[Path]) -> dict[str, set[Path]]:
    categories: dict[str, set[Path]] = {"desktop": set(), "secondary": set()}
    for path in paths:
        name = path.stem.lower()
        resolved = path.resolve()
        if "desktop" in name:
            categories["desktop"].add(resolved)
        if any(marker in name for marker in SECONDARY_SCREENSHOT_MARKERS):
            categories["secondary"].add(resolved)
    return categories


def validate_generated_option_references(package: Path, options: list[Path]) -> list[dict[str, str]]:
    if not options:
        return []
    decision_log_path = package / "visual-decision-log.md"
    decision_log = read_text(decision_log_path)
    errors: list[dict[str, str]] = []
    for option in options:
        relative = option.relative_to(package).as_posix()
        if relative not in decision_log:
            errors.append(
                issue(
                    "unreferenced_generated_option",
                    f"Generated option is not referenced by visual-decision-log.md: {relative}",
                    decision_log_path,
                )
            )
    return errors


def manifest_local_path(package: Path, value: object) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = Path(value)
    if candidate.is_absolute():
        return None
    resolved = (package / candidate).resolve()
    if not resolved.is_relative_to(package.resolve()):
        return None
    return resolved


def validate_asset_manifest(package: Path) -> list[dict[str, str]]:
    path = package / "asset-manifest.json"
    if not path.exists():
        return [issue("missing_asset_manifest", "asset-manifest.json is required.", path)]
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [issue("invalid_asset_manifest_json", f"asset-manifest.json is invalid JSON: {exc}", path)]

    errors: list[dict[str, str]] = []
    strategy = manifest.get("asset_strategy")
    if strategy not in ASSET_STRATEGIES:
        errors.append(issue("invalid_asset_manifest_strategy", f"Invalid asset_strategy: {strategy!r}.", path))
        return errors

    if strategy == "none":
        if not manifest.get("reason"):
            errors.append(issue("asset_manifest_missing_reason", "asset_strategy none must include a reason.", path))
        return errors

    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        errors.append(issue("asset_manifest_missing_assets", "atomic-generated-assets requires a non-empty assets list.", path))
        return errors

    package_root = package.resolve()
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            errors.append(issue("asset_manifest_invalid_asset", f"Asset entry {index} must be an object.", path))
            continue
        for key in ASSET_REQUIRED_KEYS:
            if key not in asset:
                errors.append(issue("asset_manifest_missing_required_key", f"Asset {index} missing required key: {key}", path))
        final_path = manifest_local_path(package, asset.get("final_path"))
        prototype_path = manifest_local_path(package, asset.get("prototype_path"))
        if final_path is None:
            errors.append(issue("asset_manifest_path_outside_package", f"Asset {index} final_path must be package-local.", path))
        elif not final_path.is_relative_to(package_root):
            errors.append(issue("asset_manifest_path_outside_package", f"Asset {index} final_path must stay inside the package.", path))
        elif not final_path.is_file():
            errors.append(issue("asset_manifest_missing_final_path", f"Missing final asset path: {asset.get('final_path')}", final_path))
        if prototype_path is None:
            errors.append(issue("asset_manifest_path_outside_package", f"Asset {index} prototype_path must be package-local.", path))
        elif not prototype_path.is_relative_to(package_root):
            errors.append(issue("asset_manifest_path_outside_package", f"Asset {index} prototype_path must stay inside the package.", path))
        elif not prototype_path.is_file():
            errors.append(issue("asset_manifest_missing_prototype_path", f"Missing prototype asset path: {asset.get('prototype_path')}", prototype_path))

        expected_size = parse_size(str(asset.get("target_size", "")))
        asset_label = asset.get("id", index)
        if expected_size is None:
            errors.append(
                issue(
                    "asset_manifest_dimension_mismatch",
                    f"Asset {asset_label} target_size must use WIDTHxHEIGHT format.",
                    path,
                )
            )
        if final_path is not None and final_path.is_file() and expected_size is not None:
            metadata = png_metadata(final_path)
            if metadata is None:
                errors.append(
                    issue(
                        "asset_manifest_dimension_mismatch",
                        f"Asset {asset_label} must be a readable PNG file.",
                        final_path,
                    )
                )
                continue
            width, height, has_alpha = metadata
            if (width, height) != expected_size:
                errors.append(
                    issue(
                        "asset_manifest_dimension_mismatch",
                        f"Asset {asset_label} is {width}x{height}, expected {expected_size[0]}x{expected_size[1]}.",
                        final_path,
                    )
                )
            if asset.get("transparent") is True and not has_alpha:
                errors.append(
                    issue(
                        "asset_manifest_transparent_without_alpha",
                        f"Asset {asset_label} is marked transparent but PNG has no alpha channel.",
                        final_path,
                    )
                )
    return errors


def validate_design_qa(package: Path, screenshots: list[Path]) -> list[dict[str, str]]:
    if not screenshots:
        return []
    path = package / "design-qa.md"
    if not path.is_file():
        return [issue("missing_design_qa_report", "design-qa.md is required after rendered screenshots exist.", path)]
    text = path.read_text(encoding="utf-8").lower()
    if "final result: `passed`" not in text and "final result: passed" not in text:
        return [issue("design_qa_not_passed", "design-qa.md must include final result: passed.", path)]
    if "source visual truth" not in text or "implementation screenshot" not in text:
        return [issue("incomplete_design_qa_report", "design-qa.md must cite source and implementation evidence.", path)]
    return []


def check_package(root: Path, package: Path) -> dict[str, object]:
    package = resolve_package_path(root, package)
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    errors.extend(validate_package_location(root, package))
    if errors:
        return {"status": "needs_attention", "package": str(package), "errors": errors, "warnings": warnings}
    if not package.exists():
        errors.append(issue("missing_design_package", "Design package directory does not exist.", package))
        return {"status": "needs_attention", "package": str(package), "errors": errors, "warnings": warnings}

    for relative in PACKAGE_FILES:
        path = package / relative
        if not path.is_file():
            errors.append(issue("missing_required_file", f"Missing required file: {relative}", path))
    for relative in PACKAGE_DIRS:
        path = package / relative
        if not path.is_dir():
            errors.append(issue("missing_required_directory", f"Missing required directory: {relative}", path))

    source_image = package / "assets" / "source" / "selected-ui-design.png"
    if not source_image.is_file():
        errors.append(issue("missing_approved_source_image", "Approved source image is required.", source_image))
    if not has_approved_source(package):
        errors.append(
            issue(
                "visual_source_not_approved",
                "visual-source.md must mark approval status as Approved.",
                package / "visual-source.md",
            )
        )

    screenshots = screenshot_paths(package)
    if not screenshots:
        errors.append(
            issue(
                "missing_rendered_screenshot",
                "At least one rendered implementation screenshot is required.",
                package / "assets" / "screenshots",
            )
        )
    else:
        categories = screenshot_categories(screenshots)
        if not categories["desktop"]:
            errors.append(
                issue(
                    "missing_desktop_screenshot_evidence",
                    "Rendered screenshot evidence must include a desktop screenshot.",
                    package / "assets" / "screenshots",
                )
            )
        if not categories["secondary"]:
            errors.append(
                issue(
                    "missing_secondary_screenshot_evidence",
                    "Rendered screenshot evidence must include at least one mobile, narrow, or no-color screenshot.",
                    package / "assets" / "screenshots",
                )
            )
        elif not any(
            desktop_path != secondary_path
            for desktop_path in categories["desktop"]
            for secondary_path in categories["secondary"]
        ):
            errors.append(
                issue(
                    "screenshot_evidence_requires_distinct_files",
                    "Rendered screenshot evidence must use separate desktop and mobile, narrow, or no-color files.",
                    package / "assets" / "screenshots",
                )
            )

    generated_options = generated_option_paths(package)
    if not generated_options:
        errors.append(
            issue(
                "missing_generated_options",
                "At least one persisted generated visual option is required in assets/generated-options.",
                package / "assets" / "generated-options",
            )
        )
    else:
        errors.extend(validate_generated_option_references(package, generated_options))

    errors.extend(validate_asset_manifest(package))
    errors.extend(validate_design_qa(package, screenshots))
    errors.extend(validate_tokens(package))
    errors.extend(validate_links(package))
    errors.extend(validate_placeholders(package))

    task_pack = read_text(package / "subagent-task-pack.md")
    if "DONE requires" not in task_pack or "BLOCKED: design detail missing" not in task_pack:
        errors.append(
            issue(
                "incomplete_subagent_task_pack",
                "subagent-task-pack.md must define BLOCKED and DONE protocols.",
                package / "subagent-task-pack.md",
            )
        )

    fidelity = read_text(package / "visual-fidelity-checklist.md")
    if "Desktop screenshot" not in fidelity or "Known deviations" not in fidelity:
        errors.append(
            issue(
                "incomplete_fidelity_checklist",
                "visual-fidelity-checklist.md must include screenshot and known-deviation fields.",
                package / "visual-fidelity-checklist.md",
            )
        )

    return {
        "status": "pass" if not errors else "needs_attention",
        "package": str(package),
        "errors": errors,
        "warnings": warnings,
    }


def summarize_package(root: Path, package: Path) -> dict[str, object]:
    package = resolve_package_path(root, package)
    check = check_package(root, package)
    source_image = package / "assets" / "source" / "selected-ui-design.png"
    screenshots = screenshot_paths(package)
    generated_options = generated_option_paths(package)
    return {
        "status": "implementation-ready" if check["status"] == "pass" else "needs_attention",
        "package": str(package),
        "approved_source_image": source_image.is_file() and has_approved_source(package),
        "screenshot_count": len(screenshots),
        "generated_option_count": len(generated_options),
        "errors": check["errors"],
        "warnings": check["warnings"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and validate docs/designs UI design packages.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("root")
    create.add_argument("slug")
    create.add_argument("--mode", choices=("new", "extend"), default="new")
    create.add_argument("--source", default="")
    create.add_argument("--write", action="store_true")
    create.add_argument("--json", action="store_true")

    check = subparsers.add_parser("check")
    check.add_argument("root")
    check.add_argument("package")
    check.add_argument("--json", action="store_true")

    summarize = subparsers.add_parser("summarize")
    summarize.add_argument("root")
    summarize.add_argument("package")
    summarize.add_argument("--json", action="store_true")

    return parser.parse_args()


def emit(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(f"{result['status']}: {result.get('package', '')}")
    for item in result.get("errors", []):
        print(f"ERROR {item['code']}: {item['message']}")
    for item in result.get("warnings", []):
        print(f"WARN {item['code']}: {item['message']}")


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if args.command == "create":
        result = create_package(root, args.slug, args.mode, args.source, args.write)
        emit(result, args.json)
        return 0 if not result.get("errors") else 1
    if args.command == "check":
        result = check_package(root, args.package)
        emit(result, args.json)
        return 0 if result["status"] == "pass" else 1
    if args.command == "summarize":
        result = summarize_package(root, args.package)
        emit(result, args.json)
        return 0 if result["status"] == "implementation-ready" else 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
