#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import os
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import design_package  # noqa: E402


def resolve_output_path(package: Path, output: str) -> Path | None:
    candidate = (package / output).resolve()
    if not candidate.is_relative_to(package.resolve()):
        return None
    return candidate


def relative_to_package(package: Path, path: Path) -> str:
    return path.relative_to(package).as_posix()


def issue_path_text(issue_item: dict[str, object]) -> str | None:
    value = issue_item.get("path")
    return str(value) if value else None


def load_manifest_for_preview(package: Path) -> list[dict[str, object]]:
    path = package / "asset-manifest.json"
    if not path.exists():
        return []
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    assets = manifest.get("assets", [])
    if not isinstance(assets, list):
        return []
    return [asset for asset in assets if isinstance(asset, dict)]


def relative_from(base_dir: Path, target: Path) -> str:
    return Path(os.path.relpath(target, start=base_dir)).as_posix()


def resolve_manifest_path(package: Path, value: object) -> Path | None:
    return design_package.manifest_local_path(package, value)


def issue_messages_for_path(issues: list[dict[str, str]], path: Path | None) -> list[str]:
    if path is None:
        return []
    target = str(path)
    return [str(issue_item["message"]) for issue_item in issues if issue_path_text(issue_item) == target]


def asset_preview_state(package: Path, asset: dict[str, object], issues: list[dict[str, str]]) -> tuple[str, list[str], Path | None]:
    final_path = resolve_manifest_path(package, asset.get("final_path"))
    messages: list[str] = []
    if final_path is None:
        messages.append("Invalid manifest path")
        return "Invalid manifest", messages, None
    messages.extend(issue_messages_for_path(issues, final_path))
    if not final_path.is_file():
        if not messages:
            messages.append("Missing file")
        return "Missing file", messages, final_path
    if messages:
        return "Invalid manifest", messages, final_path
    return "Ready", [], final_path


def emit(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(result["status"])
    for issue in result.get("issues", []):
        print(f"{issue['code']}: {issue['message']}")
    if "preview" in result:
        print(result["preview"])


def check_assets(root: Path, package_arg: str | Path) -> dict[str, object]:
    package = design_package.resolve_package_path(root, package_arg)
    issues = design_package.validate_package_location(root, package)
    if not issues and package.exists():
        issues.extend(design_package.validate_asset_manifest(package))
    elif not package.exists():
        issues.append(
            design_package.issue(
                "missing_design_package",
                "Design package directory does not exist.",
                package,
            )
        )
    status = "pass" if not issues else "needs_attention"
    return {"status": status, "package": str(package), "issues": issues}


def build_preview_html(package: Path, output_path: Path, assets: list[dict[str, object]], issues: list[dict[str, str]]) -> str:
    issue_items = "".join(
        f"<li><strong>{html.escape(str(issue_item['code']))}</strong>: {html.escape(str(issue_item['message']))}</li>"
        for issue_item in issues
    )
    issues_section = (
        "<section><h2>Validation issues</h2><ul class=\"issues\">"
        f"{issue_items}"
        "</ul></section>\n"
        if issue_items
        else ""
    )
    rows: list[str] = []
    for asset in assets:
        asset_id = html.escape(str(asset.get("id", "")))
        role = html.escape(str(asset.get("role", "")))
        target_size = html.escape(str(asset.get("target_size", "")))
        target_region = html.escape(str(asset.get("target_region", "")))
        display_intent = html.escape(str(asset.get("display_intent", "")))
        preview_state, state_messages, final_path = asset_preview_state(package, asset, issues)
        state_badge_class = "state-ok" if preview_state == "Ready" else "state-problem"
        state_lines = "".join(f"<li>{html.escape(message)}</li>" for message in state_messages)
        image_or_placeholder = (
            f"<img src=\"{html.escape(relative_from(output_path.parent, final_path))}\" alt=\"{asset_id}\">"
            if final_path is not None and final_path.is_file()
            else "<div class=\"placeholder\">Preview unavailable</div>"
        )
        notes_html = f"<ul class=\"notes\">{state_lines}</ul>" if state_lines else ""
        rows.append(
            "<article>"
            f"<h2>{asset_id}</h2>"
            f"<p class=\"state {state_badge_class}\">{html.escape(preview_state)}</p>"
            f"{image_or_placeholder}"
            f"<p><strong>Role:</strong> {role}</p>"
            f"<p><strong>Intent:</strong> {display_intent}</p>"
            f"<p><strong>Target:</strong> {target_size} · {target_region}</p>"
            f"{notes_html}"
            "</article>"
        )
    return (
        "<!doctype html>\n"
        "<html lang=\"en\">\n"
        "<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<title>Design Asset Preview</title>\n"
        "<style>"
        "body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f4f4f6;color:#171717;}"
        "header{padding:24px 24px 0;}"
        "main{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;padding:24px;}"
        "section{padding:0 24px;}"
        ".issues{margin:0;padding-left:18px;font-size:13px;line-height:1.5;}"
        "article{background:#fff;border:1px solid #d4d4d8;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.05);}"
        "img,.placeholder{display:flex;align-items:center;justify-content:center;width:100%;height:160px;object-fit:contain;background:#f5f5f5;border-radius:6px;}"
        ".placeholder{color:#52525b;font-size:13px;border:1px dashed #a1a1aa;box-sizing:border-box;}"
        "h2{font-size:16px;margin:0 0 12px;}"
        "p{font-size:13px;line-height:1.4;margin:8px 0 0;}"
        ".state{display:inline-block;margin:0 0 12px;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:600;}"
        ".state-ok{background:#dcfce7;color:#166534;}"
        ".state-problem{background:#fee2e2;color:#991b1b;}"
        ".notes{margin:8px 0 0;padding-left:18px;font-size:12px;color:#3f3f46;}"
        "</style>\n"
        "</head>\n"
        "<body>\n"
        "<header><h1>Design Asset Preview</h1></header>\n"
        f"{issues_section}"
        f"<main>{''.join(rows)}</main>\n"
        "</body>\n"
        "</html>\n"
    )


def preview_assets(root: Path, package_arg: str | Path, output: str, write: bool) -> dict[str, object]:
    package = design_package.resolve_package_path(root, package_arg)
    issues = design_package.validate_package_location(root, package)
    if not package.exists():
        issues.append(
            design_package.issue(
                "missing_design_package",
                "Design package directory does not exist.",
                package,
            )
        )
    output_path = resolve_output_path(package, output)
    if output_path is None:
        issues.append(
            design_package.issue(
                "asset_preview_outside_package",
                "Preview output must stay inside the design package.",
                package / output,
            )
        )
    assets: list[dict[str, object]] = []
    manifest_issues: list[dict[str, str]] = []
    if package.exists():
        manifest_issues.extend(design_package.validate_asset_manifest(package))
        assets = load_manifest_for_preview(package)
    issues.extend(manifest_issues)
    result: dict[str, object] = {
        "status": "needs_attention" if issues else ("preview_written" if write else "preview_dry_run"),
        "package": str(package),
        "issues": issues,
    }
    if output_path is not None:
        result["preview"] = relative_to_package(package, output_path)
    blocking_issue_codes = {"design_package_outside_repo", "design_package_outside_docs_designs", "asset_preview_outside_package", "missing_design_package"}
    if any(str(issue_item["code"]) in blocking_issue_codes for issue_item in issues):
        return result
    html_text = build_preview_html(package, output_path, assets, issues)
    if write:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(html_text, encoding="utf-8", newline="\n")
        result["status"] = "preview_written"
    else:
        result["status"] = "preview_dry_run"
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check and preview design package runtime assets.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("check")
    check.add_argument("root")
    check.add_argument("package")
    check.add_argument("--json", action="store_true")

    preview = subparsers.add_parser("preview")
    preview.add_argument("root")
    preview.add_argument("package")
    preview.add_argument("--output", default="assets/component-assets/preview/contact-sheet.html")
    preview.add_argument("--write", action="store_true")
    preview.add_argument("--json", action="store_true")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if args.command == "check":
        result = check_assets(root, args.package)
        emit(result, args.json)
        return 0 if result["status"] == "pass" else 1
    if args.command == "preview":
        result = preview_assets(root, args.package, args.output, args.write)
        emit(result, args.json)
        return 0 if result["status"] in {"preview_written", "preview_dry_run"} else 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
