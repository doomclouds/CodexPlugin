from __future__ import annotations

import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from asset_core.issues import issue


STRUCTURE_IGNORES = {
    ".git",
    ".github",
    ".idea",
    ".vs",
    ".vscode",
    ".worktrees",
    "bin",
    "obj",
    "docs",
    "src",
    "tests",
}


def git_ignored(root: Path, path: Path) -> bool:
    try:
        completed = subprocess.run(
            ["git", "status", "--ignored", "--short", "--", str(path.relative_to(root))],
            cwd=root,
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, ValueError):
        return False
    return any(line.startswith("!! ") for line in completed.stdout.splitlines())


def relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def project_names_under(root: Path, area: str) -> set[str]:
    area_root = root / area
    if not area_root.is_dir():
        return set()
    return {path.parent.name for path in area_root.rglob("*.csproj")}


def check_relayout_leftovers(root: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    names = project_names_under(root, "src") | project_names_under(root, "tests")
    for name in sorted(names):
        old_dir = root / name
        if not old_dir.is_dir():
            continue
        code = "ignored_old_project_directory" if git_ignored(root, old_dir) else "old_project_directory_after_relayout"
        issues.append(
            issue(
                "warning",
                code,
                "Project layout uses src/tests, but a same-named root directory still exists.",
                path=relative(root, old_dir),
            )
        )
    return issues


def slnx_folders(path: Path) -> tuple[set[str], list[str]]:
    text = path.read_text(encoding="utf-8")
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        folders = set()
        project_paths: list[str] = []
        for line in text.splitlines():
            if 'Folder Name="' in line:
                start = line.find('Folder Name="') + len('Folder Name="')
                end = line.find('"', start)
                folders.add(line[start:end])
            if 'Project Path="' in line:
                start = line.find('Project Path="') + len('Project Path="')
                end = line.find('"', start)
                project_paths.append(line[start:end])
        return folders, project_paths

    folders = {element.attrib["Name"] for element in root.iter("Folder") if "Name" in element.attrib}
    project_paths = [element.attrib["Path"] for element in root.iter("Project") if "Path" in element.attrib]
    return folders, project_paths


def check_solution_folders(root: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for slnx in sorted(root.glob("*.slnx")):
        folders, project_paths = slnx_folders(slnx)
        normalized = [path.replace("\\", "/") for path in project_paths]
        has_src_projects = any(path.startswith("src/") for path in normalized)
        has_test_projects = any(path.startswith("tests/") for path in normalized)
        if has_src_projects and "/src/" not in folders:
            issues.append(
                issue(
                    "warning",
                    "missing_src_solution_folder",
                    "Solution references src projects but lacks a /src/ solution folder.",
                    path=relative(root, slnx),
                )
            )
        if has_test_projects and "/tests/" not in folders:
            issues.append(
                issue(
                    "warning",
                    "missing_tests_solution_folder",
                    "Solution references test projects but lacks a /tests/ solution folder.",
                    path=relative(root, slnx),
                )
            )
    return issues


def discover_possible_root_dirs(root: Path) -> list[str]:
    dirs: list[str] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name in STRUCTURE_IGNORES:
            continue
        if child.name.startswith("."):
            continue
        dirs.append(child.name)
    return dirs
