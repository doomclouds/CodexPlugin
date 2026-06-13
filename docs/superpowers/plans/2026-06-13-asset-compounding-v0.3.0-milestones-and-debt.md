# Asset Compounding v0.3.0 Milestones and Technical Debt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add v0.3.0 milestone and technical-debt asset support while separating script responsibilities and preserving existing asset closeout behavior.

**Architecture:** Keep existing command-line entry points stable, but move shared parsing, discovery, index, issue, and topic logic into focused helper modules. Add milestone and technical-debt writer/checker scripts plus two new skills, then integrate their status into `asset_status.py` and `asset_closeout.py` without extending `asset_gate.route`.

**Tech Stack:** Python 3 standard library, `unittest`, Codex plugin skill folders, markdown templates, existing local plugin cache validation tools.

---

## File Structure

Create these shared script modules under `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/`:

- `asset_core/__init__.py`: package marker for shared script helpers.
- `asset_core/areas.py`: asset area registry for `specs`, `plans`, `archives`, `problems`, `inbox`, `milestones`, and `technical-debt`.
- `asset_core/topics.py`: topic slug normalization and dated filename parsing.
- `asset_core/issues.py`: shared issue/result helpers.
- `asset_core/discovery.py`: repository root and asset discovery helpers.
- `asset_core/indexes.py`: index parser and index health checker.
- `checks/__init__.py`: package marker for domain checks.
- `checks/archive_checks.py`: spec+plan versus archive coverage checks.
- `checks/handoff_checks.py`: `asset_gate` handoff text checks.
- `checks/repo_structure_checks.py`: existing solution-layout checks split out of completion gate.
- `checks/milestone_checks.py`: milestone README/checklist/index consistency checks.
- `checks/technical_debt_checks.py`: technical-debt detail/index/closure checks.
- `milestone_assets.py`: milestone create/update/recompute/check command facade.
- `technical_debt_assets.py`: technical-debt create/status/close/check command facade.

Modify these existing scripts to use the shared modules while preserving CLI names:

- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/_asset_utils.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_indexes.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_status.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_closeout.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/bootstrap_asset_compounding.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/find_related_assets.py`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/suggest_asset_route.py`

Create these skill folders:

- `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/SKILL.md`
- `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/agents/openai.yaml`
- `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/references/milestone-readme-template.md`
- `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/references/milestone-checklist-template.md`
- `plugins/superpowers-asset-compounding/skills/manage-technical-debt/SKILL.md`
- `plugins/superpowers-asset-compounding/skills/manage-technical-debt/agents/openai.yaml`
- `plugins/superpowers-asset-compounding/skills/manage-technical-debt/references/technical-debt-template.md`

Modify plugin docs and metadata:

- `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
- `plugins/superpowers-asset-compounding/README.md`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/SKILL.md`
- `plugins/superpowers-asset-compounding/skills/using-asset-compounding/SKILL.md`
- `plugins/superpowers-asset-compounding/skills/compound-development-asset/references/agents-asset-guidance-template.md`
- `AGENTS.md`

Modify tests:

- `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

Create closeout assets after implementation:

- `docs/superpowers/archives/2026-06/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md`
- update `docs/superpowers/archives/INDEX.md`

---

### Task 1: Extract Shared Asset Core Without Behavior Changes

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_core/__init__.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_core/areas.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_core/topics.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_core/issues.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_core/discovery.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/_asset_utils.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add failing tests for the shared core module API**

Add this test method near the existing helper tests in `AssetScriptTests`:

```python
    def test_asset_core_registry_includes_project_level_assets(self) -> None:
        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        spec = importlib.util.spec_from_file_location("asset_core_areas", scripts_root / "asset_core" / "areas.py")
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)

        self.assertEqual(module.ASSET_AREAS["archives"]["suffix"], "-archives.md")
        self.assertEqual(module.ASSET_AREAS["milestones"]["kind"], "milestone")
        self.assertEqual(module.ASSET_AREAS["technical-debt"]["kind"], "technical-debt")
        self.assertEqual(module.ASSET_AREAS["milestones"]["root"], "docs/milestones")
        self.assertEqual(module.ASSET_AREAS["technical-debt"]["root"], "docs/technical-debt")

    def test_asset_core_canonical_slug_matches_existing_suffixes(self) -> None:
        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        spec = importlib.util.spec_from_file_location("asset_core_topics", scripts_root / "asset_core" / "topics.py")
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)

        self.assertEqual(module.canonical_slug("2026-05-01-demo-feature-archives.md"), "demo-feature")
        self.assertEqual(module.canonical_slug("Demo Feature"), "demo-feature")
        self.assertEqual(module.canonical_slug("2026-05-01-demo-feature-debt.md"), "demo-feature")
        self.assertEqual(
            module.date_slug_from_name("2026-05-01-demo-feature-archives.md", "-archives.md"),
            ("2026-05-01", "demo-feature"),
        )
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_core_registry_includes_project_level_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_core_canonical_slug_matches_existing_suffixes
```

Expected: FAIL because `asset_core/areas.py` and `asset_core/topics.py` do not exist.

- [ ] **Step 3: Create `asset_core/__init__.py`**

Create the file with this content:

```python
"""Shared helpers for asset-compounding scripts."""
```

- [ ] **Step 4: Create `asset_core/areas.py`**

Create the file with this content:

```python
from __future__ import annotations

ASSET_AREAS: dict[str, dict[str, object]] = {
    "specs": {
        "root": "docs/superpowers/specs",
        "suffix": "-design.md",
        "kind": "spec",
        "index": None,
        "month_index": False,
    },
    "plans": {
        "root": "docs/superpowers/plans",
        "suffix": "-implementation-plan.md",
        "kind": "plan",
        "index": None,
        "month_index": False,
    },
    "archives": {
        "root": "docs/superpowers/archives",
        "suffix": "-archives.md",
        "kind": "archive",
        "index": "INDEX.md",
        "month_index": True,
    },
    "problems": {
        "root": "docs/superpowers/problems",
        "suffix": "-problem.md",
        "kind": "problem",
        "index": "INDEX.md",
        "month_index": True,
    },
    "inbox": {
        "root": "docs/superpowers/inbox",
        "suffix": "-inbox.md",
        "kind": "inbox",
        "index": "INDEX.md",
        "month_index": True,
    },
    "milestones": {
        "root": "docs/milestones",
        "suffix": "README.md",
        "kind": "milestone",
        "index": "INDEX.md",
        "month_index": False,
    },
    "technical-debt": {
        "root": "docs/technical-debt",
        "suffix": "-debt.md",
        "kind": "technical-debt",
        "index": "INDEX.md",
        "month_index": False,
    },
}


SUPERPOWERS_AREAS = ("specs", "plans", "archives", "problems", "inbox")
INDEXED_SUPERPOWERS_AREAS = ("archives", "problems", "inbox")
PROJECT_INDEXED_AREAS = ("milestones", "technical-debt")
```

- [ ] **Step 5: Create `asset_core/topics.py`**

Create the file with this content:

```python
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
```

- [ ] **Step 6: Create `asset_core/issues.py`**

Create the file with this content:

```python
from __future__ import annotations


def issue(severity: str, code: str, message: str, *, path: str | None = None, area: str | None = None) -> dict[str, str]:
    item = {"severity": severity, "code": code, "message": message}
    if path:
        item["path"] = path
    if area:
        item["area"] = area
    return item
```

- [ ] **Step 7: Create `asset_core/discovery.py`**

Move the `AssetFile`, `discover_superpowers_root`, `split_date_slug`, `read_title`, and `iter_assets` logic from `_asset_utils.py` into this file, keeping these public names:

```python
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from asset_core.areas import ASSET_AREAS


@dataclass(frozen=True)
class AssetFile:
    area: str
    kind: str
    path: Path
    date: str | None
    slug: str
    title: str | None
```

Keep `iter_assets(root, areas)` behavior identical for existing Superpowers areas. Add support for project-level areas by resolving each area root from the registry relative to the repository root when the configured root starts with `docs/`.

- [ ] **Step 8: Turn `_asset_utils.py` into a compatibility wrapper**

Replace `_asset_utils.py` with imports that preserve existing consumers:

```python
from __future__ import annotations

from asset_core.areas import ASSET_AREAS
from asset_core.discovery import AssetFile, discover_superpowers_root, iter_assets, read_title, split_date_slug

__all__ = [
    "ASSET_AREAS",
    "AssetFile",
    "discover_superpowers_root",
    "iter_assets",
    "read_title",
    "split_date_slug",
]
```

- [ ] **Step 9: Run the focused tests again**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_core_registry_includes_project_level_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_core_canonical_slug_matches_existing_suffixes
```

Expected: PASS.

- [ ] **Step 10: Run the existing full plugin test suite**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS with the existing test count plus the two new tests.

- [ ] **Step 11: Commit the compatibility refactor**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\asset_core plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\_asset_utils.py plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "refactor: extract asset core helpers"
```

---

### Task 2: Move Index Checks Into Shared Core

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_core/indexes.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_indexes.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add failing tests for project-level index checking**

Add this test method:

```python
    def test_check_indexes_accepts_milestone_and_technical_debt_areas(self) -> None:
        repo = self.create_repo()
        milestone_root = repo / "docs/milestones/2026-06/demo-milestone"
        milestone_root.mkdir(parents=True, exist_ok=True)
        (milestone_root / "README.md").write_text("# Demo Milestone\n\n## Strategic Significance\n\nImportant.\n", encoding="utf-8")
        (milestone_root / "CHECKLIST.md").write_text(
            """# Demo Milestone Checklist

## Progress Summary

- Status: In Progress
- Progress: 0/1
- Done: 0
- In progress: 1
- Not started: 0

## Checklist

- [ ] 1. Demo slice
  - Status: In Progress
  - Related spec: None yet.
  - Related plan: None yet.
  - Related archive: None yet.
  - Completion signal: Pending.
""",
            encoding="utf-8",
        )
        (repo / "docs/milestones/INDEX.md").write_text(
            """# Milestones

| Month | Milestone | Checklist | Status | Progress | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-06 | [Demo Milestone](2026-06/demo-milestone/README.md) | [Checklist](2026-06/demo-milestone/CHECKLIST.md) | In Progress | 0/1 | Important |
""",
            encoding="utf-8",
        )
        debt_root = repo / "docs/technical-debt/2026-06"
        debt_root.mkdir(parents=True, exist_ok=True)
        (debt_root / "2026-06-13-demo-debt-debt.md").write_text(
            """# Demo Debt

- Date: `2026-06-13`
- Topic slug: `demo-debt`
- Status: `Open`
- Milestone: `Demo Milestone`
- Debt type: `Architecture`
- Priority: `Medium`
- Revisit trigger: `Before adding another demo slice.`
- Scope: `Demo`
- Related slice: `Demo slice`

## Summary

Debt.

## Why This Is Debt

It blocks future work.

## Current Impact

More code drift.

## Resolution Criteria

- Shared helper exists.

## Initial Resolution Direction

Extract helper.

## Non-Goals

- New behavior.

## Related Assets

- None yet.
""",
            encoding="utf-8",
        )
        (repo / "docs/technical-debt/INDEX.md").write_text(
            """# Technical Debt Index

| Month | Debt | Status | Priority | Milestone | Revisit Trigger | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-06 | [Demo debt](2026-06/2026-06-13-demo-debt-debt.md) | Open | Medium | Demo Milestone | Before adding another demo slice. | Demo |
""",
            encoding="utf-8",
        )

        self.assertEqual(self.run_json(CHECKER, repo, "--area", "milestones", "--json")["issues"], [])
        self.assertEqual(self.run_json(CHECKER, repo, "--area", "technical-debt", "--json")["issues"], [])
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_check_indexes_accepts_milestone_and_technical_debt_areas
```

Expected: FAIL because `check_indexes.py --area` only accepts `archives`, `problems`, and `inbox`.

- [ ] **Step 3: Create `asset_core/indexes.py`**

Move `ENTRY_RE`, `MONTH_RE`, `parse_index`, `date_slug_from_name` usage, and `check_area` behavior from `check_indexes.py` into `asset_core/indexes.py`. Keep this public function signature:

```python
def check_area(root: Path, area: str) -> list[dict[str, str]]:
    ...
```

Rules:

- For `archives`, `problems`, and `inbox`, preserve month-heading behavior.
- For `milestones` and `technical-debt`, parse markdown tables instead of month headings.
- For table indexes, report `dead_link`, `duplicate_entry`, `orphan_asset`, and `missing_index`.
- Do not require month heading order for table indexes.

- [ ] **Step 4: Refactor `check_indexes.py` into a CLI facade**

Keep the same command name. Update allowed areas:

```python
parser.add_argument("--area", choices=["all", "archives", "problems", "inbox", "milestones", "technical-debt"], default="all")
```

Set `all` to include:

```python
areas = ["archives", "problems", "inbox", "milestones", "technical-debt"] if args.area == "all" else [args.area]
```

Call `asset_core.indexes.check_area(root, area)` for every area.

- [ ] **Step 5: Run the focused test again**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_check_indexes_accepts_milestone_and_technical_debt_areas
```

Expected: PASS.

- [ ] **Step 6: Run existing index and validator tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_archive_and_problem_validators_plus_index_checker plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_archive_validator_rejects_missing_contract_sections
```

Expected: PASS.

- [ ] **Step 7: Run the full plugin test suite**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 8: Commit index refactor**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\asset_core\indexes.py plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_indexes.py plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "refactor: share asset index checks"
```

---

### Task 3: Split Completion Gate Domain Checks

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/__init__.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/archive_checks.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/repo_structure_checks.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add focused import and behavior tests**

Add this test method:

```python
    def test_completion_gate_domain_checks_are_importable(self) -> None:
        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        for relative in (
            "checks/archive_checks.py",
            "checks/handoff_checks.py",
            "checks/repo_structure_checks.py",
        ):
            spec = importlib.util.spec_from_file_location(relative.replace("/", "_"), scripts_root / relative)
            self.assertIsNotNone(spec)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(module)

        repo = self.create_repo()
        result = self.run_json_fail(COMPLETION_GATE, repo, "--completed-topic", "demo-feature", "--json")
        self.assertEqual(result["issues"][0]["code"], "missing_requirement_archive")
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_domain_checks_are_importable
```

Expected: FAIL because `checks/*.py` files do not exist.

- [ ] **Step 3: Create `checks/__init__.py`**

Create:

```python
"""Domain-specific checks for asset-compounding scripts."""
```

- [ ] **Step 4: Move archive coverage logic**

Create `checks/archive_checks.py` with public functions:

```python
from __future__ import annotations

from pathlib import Path

from asset_core.discovery import discover_superpowers_root, iter_assets
from asset_core.issues import issue
from asset_core.topics import canonical_slug
```

Move `collect_archive_coverage` and `check_archive_coverage` from `check_completion_gate.py` into this file. Preserve issue codes:

- `superpowers_assets_missing`
- `possible_missing_requirement_archive`
- `missing_requirement_archive`
- `completed_topic_not_found`

- [ ] **Step 5: Move handoff checks**

Create `checks/handoff_checks.py` and move `check_asset_gate_text` into it. Preserve required fields:

```python
REQUIRED_ASSET_GATE_FIELDS = (
    "event_type:",
    "route:",
    "reason:",
    "evidence:",
    "related_assets:",
    "asset_candidates:",
    "deferred_signals:",
    "next_step:",
)
```

- [ ] **Step 6: Move repository structure checks**

Create `checks/repo_structure_checks.py` and move these functions from `check_completion_gate.py`:

- `git_ignored`
- `project_names_under`
- `check_relayout_leftovers`
- `slnx_folders`
- `check_solution_folders`
- `discover_possible_root_dirs`

Keep `STRUCTURE_IGNORES` in this module.

- [ ] **Step 7: Refactor `check_completion_gate.py`**

Keep argument parsing and output formatting in `check_completion_gate.py`. Import domain checks:

```python
from checks.archive_checks import check_archive_coverage
from checks.handoff_checks import check_asset_gate_text
from checks.repo_structure_checks import check_relayout_leftovers, check_solution_folders, discover_possible_root_dirs
from asset_core.issues import issue
from asset_core.topics import canonical_slug
```

Remove duplicated function bodies from `check_completion_gate.py`.

- [ ] **Step 8: Run focused tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_domain_checks_are_importable plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_blocks_completed_topic_without_archive plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_accepts_completed_topic_with_archive
```

Expected: PASS.

- [ ] **Step 9: Run full tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 10: Commit domain split**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\checks plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_completion_gate.py plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "refactor: split completion gate checks"
```

---

### Task 4: Add Milestone Asset Script and Templates

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/milestone_checks.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/milestone_assets.py`
- Create: `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/references/milestone-readme-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/references/milestone-checklist-template.md`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add milestone script constants**

Add near the test constants:

```python
MILESTONE_ASSETS = SKILLS / "compound-development-asset" / "scripts" / "milestone_assets.py"
```

- [ ] **Step 2: Add failing tests for milestone create, recompute, and check**

Add these test methods:

```python
    def test_milestone_assets_create_recompute_and_check(self) -> None:
        repo = self.create_repo()
        result = self.run_json(
            MILESTONE_ASSETS,
            repo,
            "create",
            "--month",
            "2026-06",
            "--slug",
            "demo-alpha",
            "--title",
            "Demo Alpha",
            "--slice",
            "First Slice",
            "--slice",
            "Second Slice",
            "--strategic-significance",
            "Demo Alpha proves a strategically important two-stage project path.",
            "--acceptance",
            "Demo Alpha can complete both tracked stages.",
            "--write",
            "--json",
        )
        self.assertEqual(result["status"], "created")
        checklist = repo / "docs/milestones/2026-06/demo-alpha/CHECKLIST.md"
        self.assertTrue(checklist.is_file())

        updated = self.run_json(
            MILESTONE_ASSETS,
            repo,
            "update-slice",
            "--slug",
            "demo-alpha",
            "--slice",
            "First Slice",
            "--status",
            "Done",
            "--spec",
            "../../../superpowers/specs/2026-05-01-demo-feature-design.md",
            "--plan",
            "../../../superpowers/plans/2026-05-01-demo-feature.md",
            "--archive",
            "../../../superpowers/archives/2026-05/2026-05-01-demo-feature-archives.md",
            "--completion-signal",
            "Demo feature archive exists.",
            "--write",
            "--json",
        )
        self.assertEqual(updated["status"], "updated")
        recomputed = self.run_json(MILESTONE_ASSETS, repo, "recompute", "--slug", "demo-alpha", "--write", "--json")
        self.assertEqual(recomputed["progress"], "1/2")
        checked = self.run_json(MILESTONE_ASSETS, repo, "check", "--slug", "demo-alpha", "--json")
        self.assertEqual(checked["issues"], [])

    def test_milestone_check_warns_for_small_milestone_without_strategic_significance(self) -> None:
        repo = self.create_repo()
        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "create",
            "--month",
            "2026-06",
            "--slug",
            "thin-alpha",
            "--title",
            "Thin Alpha",
            "--slice",
            "First Slice",
            "--slice",
            "Second Slice",
            "--acceptance",
            "Thin Alpha completes both stages.",
            "--write",
            "--json",
        )
        result = self.run_json(MILESTONE_ASSETS, repo, "check", "--slug", "thin-alpha", "--json")
        self.assertEqual(result["issues"][0]["code"], "small_milestone_missing_strategic_significance")
        self.assertEqual(result["issues"][0]["severity"], "warning")
```

- [ ] **Step 3: Run the focused failing tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_milestone_assets_create_recompute_and_check plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_milestone_check_warns_for_small_milestone_without_strategic_significance
```

Expected: FAIL because `milestone_assets.py` does not exist.

- [ ] **Step 4: Add milestone templates**

Create `milestone-readme-template.md` with this content:

```markdown
# {{title}} Milestone

## Background

{{background}}

## Strategic Significance

{{strategic_significance}}

## Milestone Goal

{{goal}}

## Acceptance Statement

{{acceptance}}

## Scope

{{scope}}

## Non-Goals

{{non_goals}}

## Reference Signals

{{reference_signals}}

## Slice Boundaries

{{slice_boundaries}}

## Update Rules

- Keep `CHECKLIST.md` at slice granularity.
- Link detailed design docs under `docs/superpowers/specs/`.
- Link implementation plans under `docs/superpowers/plans/`.
- Link completed delivery archives under `docs/superpowers/archives/`.
- Recompute progress whenever any slice status changes.
- Update `docs/milestones/INDEX.md` whenever milestone status or progress changes.
```

Create `milestone-checklist-template.md` with this content:

```markdown
# {{title}} Checklist

This file is the progress ledger for the {{month}} {{title}} milestone.

Milestone standard: [README.md](README.md)

## Progress Summary

- Status: {{status}}
- Progress: {{progress}}
- Done: {{done}}
- In progress: {{in_progress}}
- Not started: {{not_started}}

## Checklist

{{slice_entries}}

## Update Rules

- Keep this file focused on milestone progress.
- Do not add task-level implementation steps here.
- Update the summary counts whenever any slice status changes.
- Update `docs/milestones/INDEX.md` whenever this milestone status or progress changes.
```

- [ ] **Step 5: Implement milestone checks**

Create `checks/milestone_checks.py` with functions:

```python
ALLOWED_MILESTONE_STATUSES = {"Not Started", "In Progress", "Done", "Deferred", "Split"}

def find_milestone(root: Path, slug: str) -> Path | None: ...
def parse_checklist(checklist: Path) -> dict[str, object]: ...
def recompute_summary(checklist: Path) -> dict[str, object]: ...
def check_milestone(root: Path, slug: str | None = None) -> list[dict[str, str]]: ...
```

Required issue codes:

- `milestone_missing_readme`
- `milestone_missing_checklist`
- `small_milestone_missing_strategic_significance`
- `milestone_progress_mismatch`
- `milestone_index_mismatch`
- `done_slice_missing_archive`
- `invalid_milestone_status`

- [ ] **Step 6: Implement `milestone_assets.py`**

Implement subcommands:

```python
create
update-slice
recompute
check
```

Argument rules:

- `create` requires `--month`, `--slug`, `--title`, at least one `--slice`, `--acceptance`, and `--write` to modify files.
- `update-slice` requires `--slug`, `--slice`, `--status`, and `--write`.
- `recompute` requires `--slug` and `--write` to update files.
- `check` supports optional `--slug`.
- Every subcommand supports `--json`.

JSON shapes:

```json
{"status": "created", "milestone": "docs/milestones/2026-06/demo-alpha/README.md"}
{"status": "updated", "milestone": "docs/milestones/2026-06/demo-alpha/CHECKLIST.md"}
{"status": "recomputed", "progress": "1/2"}
{"status": "pass", "issues": []}
```

- [ ] **Step 7: Run focused milestone tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_milestone_assets_create_recompute_and_check plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_milestone_check_warns_for_small_milestone_without_strategic_significance
```

Expected: PASS.

- [ ] **Step 8: Run index checks against generated milestone fixtures**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_check_indexes_accepts_milestone_and_technical_debt_areas
```

Expected: PASS.

- [ ] **Step 9: Run full tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 10: Commit milestone support**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\checks\milestone_checks.py plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\milestone_assets.py plugins\superpowers-asset-compounding\skills\manage-superpowers-milestone\references plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "feat: add milestone asset scripts"
```

---

### Task 5: Add Technical Debt Script and Template

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/technical_debt_checks.py`
- Create: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/technical_debt_assets.py`
- Create: `plugins/superpowers-asset-compounding/skills/manage-technical-debt/references/technical-debt-template.md`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add technical debt script constant**

Add near the test constants:

```python
TECHNICAL_DEBT_ASSETS = SKILLS / "compound-development-asset" / "scripts" / "technical_debt_assets.py"
```

- [ ] **Step 2: Add failing tests for technical debt create, close, and check**

Add these test methods:

```python
    def test_technical_debt_assets_create_close_and_check(self) -> None:
        repo = self.create_repo()
        archive = self.add_archive(repo)
        created = self.run_json(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "create",
            "--date",
            "2026-06-13",
            "--slug",
            "demo-debt",
            "--title",
            "Demo Debt",
            "--milestone",
            "Demo Alpha",
            "--debt-type",
            "Architecture",
            "--priority",
            "Medium",
            "--revisit-trigger",
            "Before adding another demo slice.",
            "--scope",
            "Demo runtime",
            "--related-slice",
            "Demo Slice",
            "--summary",
            "Demo runtime owns duplicated helper logic.",
            "--why",
            "The duplication will make future slices drift.",
            "--impact",
            "Future search tools will copy fallback behavior.",
            "--resolution-criteria",
            "Shared helper is extracted and used by both call sites.",
            "--resolution-direction",
            "Extract shared helper functions.",
            "--non-goal",
            "Changing public behavior.",
            "--write",
            "--json",
        )
        self.assertEqual(created["status"], "created")
        closed = self.run_json(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "close",
            "--slug",
            "demo-debt",
            "--archive",
            str(archive.relative_to(repo).as_posix()),
            "--closure",
            "Shared helper extraction is archived by the demo feature archive.",
            "--write",
            "--json",
        )
        self.assertEqual(closed["status"], "closed")
        checked = self.run_json(TECHNICAL_DEBT_ASSETS, repo, "check", "--slug", "demo-debt", "--json")
        self.assertEqual(checked["issues"], [])

    def test_technical_debt_check_rejects_closed_debt_without_archive(self) -> None:
        repo = self.create_repo()
        self.run_json(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "create",
            "--date",
            "2026-06-13",
            "--slug",
            "unlinked-debt",
            "--title",
            "Unlinked Debt",
            "--milestone",
            "Demo Alpha",
            "--debt-type",
            "Architecture",
            "--priority",
            "High",
            "--revisit-trigger",
            "Before release.",
            "--scope",
            "Demo",
            "--related-slice",
            "Demo Slice",
            "--summary",
            "Debt.",
            "--why",
            "It blocks future work.",
            "--impact",
            "It causes drift.",
            "--resolution-criteria",
            "Archive exists.",
            "--resolution-direction",
            "Refactor.",
            "--non-goal",
            "Feature work.",
            "--write",
            "--json",
        )
        debt = repo / "docs/technical-debt/2026-06/2026-06-13-unlinked-debt-debt.md"
        text = debt.read_text(encoding="utf-8").replace("- Status: `Open`", "- Status: `Closed`")
        debt.write_text(text + "\n## Closure\n\nClosed without archive.\n", encoding="utf-8")
        result = self.run_json_fail(TECHNICAL_DEBT_ASSETS, repo, "check", "--slug", "unlinked-debt", "--json")
        self.assertEqual(result["issues"][0]["code"], "closed_debt_missing_archive")
```

- [ ] **Step 3: Run the focused failing tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_technical_debt_assets_create_close_and_check plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_technical_debt_check_rejects_closed_debt_without_archive
```

Expected: FAIL because `technical_debt_assets.py` does not exist.

- [ ] **Step 4: Add technical debt template**

Create `technical-debt-template.md` with this content:

```markdown
# {{title}}

- Date: `{{date}}`
- Topic slug: `{{slug}}`
- Status: `{{status}}`
- Milestone: `{{milestone}}`
- Debt type: `{{debt_type}}`
- Priority: `{{priority}}`
- Revisit trigger: `{{revisit_trigger}}`
- Scope: `{{scope}}`
- Related slice: `{{related_slice}}`

## Summary

{{summary}}

## Why This Is Debt

{{why_this_is_debt}}

## Current Impact

{{current_impact}}

## Resolution Criteria

{{resolution_criteria}}

## Initial Resolution Direction

{{initial_resolution_direction}}

## Non-Goals

{{non_goals}}

## Related Assets

{{related_assets}}
```

- [ ] **Step 5: Implement technical debt checks**

Create `checks/technical_debt_checks.py` with public constants:

```python
ALLOWED_DEBT_STATUSES = {"Open", "In Progress", "Closed", "Superseded", "Won't Fix"}
ALLOWED_PRIORITIES = {"Low", "Medium", "High"}
```

Public functions:

```python
def find_debt(root: Path, slug: str) -> Path | None: ...
def parse_debt_metadata(path: Path) -> dict[str, str]: ...
def check_technical_debt(root: Path, slug: str | None = None) -> list[dict[str, str]]: ...
```

Required issue codes:

- `technical_debt_missing_index`
- `invalid_debt_status`
- `invalid_debt_priority`
- `debt_index_status_mismatch`
- `closed_debt_missing_closure`
- `closed_debt_missing_archive`
- `superseded_debt_missing_replacement`
- `wont_fix_debt_missing_reason`

- [ ] **Step 6: Implement `technical_debt_assets.py`**

Implement subcommands:

```python
create
set-status
close
check
```

Argument rules:

- `create` requires the fields shown in the test and `--write` for file changes.
- `set-status` requires `--slug`, `--status`, and `--write`.
- `close` requires `--slug`, `--archive`, `--closure`, and `--write`.
- `check` supports optional `--slug`.
- Every subcommand supports `--json`.

- [ ] **Step 7: Run focused technical debt tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_technical_debt_assets_create_close_and_check plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_technical_debt_check_rejects_closed_debt_without_archive
```

Expected: PASS.

- [ ] **Step 8: Run project-level index test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_check_indexes_accepts_milestone_and_technical_debt_areas
```

Expected: PASS.

- [ ] **Step 9: Run full tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 10: Commit technical debt support**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\checks\technical_debt_checks.py plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\technical_debt_assets.py plugins\superpowers-asset-compounding\skills\manage-technical-debt\references plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "feat: add technical debt asset scripts"
```

---

### Task 6: Integrate Milestone and Debt Signals Into Status and Closeout

**Files:**
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_status.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/asset_closeout.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/find_related_assets.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/suggest_asset_route.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add failing status and closeout tests**

Add this test method:

```python
    def test_asset_status_and_closeout_report_milestone_and_debt_gaps(self) -> None:
        repo = self.create_repo()
        self.add_archive(repo)
        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "create",
            "--month",
            "2026-06",
            "--slug",
            "demo-alpha",
            "--title",
            "Demo Alpha",
            "--slice",
            "Demo Feature",
            "--slice",
            "Second Slice",
            "--strategic-significance",
            "Demo Alpha proves a strategically important two-stage project path.",
            "--acceptance",
            "Demo Alpha can complete both tracked stages.",
            "--write",
            "--json",
        )
        self.run_json(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "create",
            "--date",
            "2026-06-13",
            "--slug",
            "demo-feature",
            "--title",
            "Demo Feature Debt",
            "--milestone",
            "Demo Alpha",
            "--debt-type",
            "Architecture",
            "--priority",
            "Medium",
            "--revisit-trigger",
            "Before adding another demo feature.",
            "--scope",
            "Demo",
            "--related-slice",
            "Demo Feature",
            "--summary",
            "Demo feature debt remains open.",
            "--why",
            "It affects future feature work.",
            "--impact",
            "Future slices will copy behavior.",
            "--resolution-criteria",
            "Archive proves repayment.",
            "--resolution-direction",
            "Refactor helper.",
            "--non-goal",
            "Changing behavior.",
            "--write",
            "--json",
        )

        status = self.run_json(ASSET_STATUS, repo, "--topic", "demo-feature", "--json")
        self.assertEqual(status["requirement_archive"]["status"], "found")
        self.assertEqual(len(status["milestone_assets"]), 1)
        self.assertEqual(len(status["technical_debt_assets"]), 1)

        closeout = self.run_json_fail(ASSET_CLOSEOUT, repo, "--topic", "demo-feature", "--json")
        self.assertEqual(closeout["route"], "update-existing")
        self.assertIn("update milestone progress", closeout["required_actions"])
        self.assertIn("resolve or update technical debt records", closeout["required_actions"])
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_status_and_closeout_report_milestone_and_debt_gaps
```

Expected: FAIL because `asset_status.py` does not emit `milestone_assets` or `technical_debt_assets`.

- [ ] **Step 3: Extend `asset_status.py`**

Update `build_status(root, topic)` to:

- collect matching milestone README/checklist entries by canonical topic text
- collect matching technical-debt records by filename slug or metadata topic slug
- run milestone and technical-debt checks
- add these keys:

```python
"milestone_assets": [...],
"technical_debt_assets": [...],
"milestone_status": {"status": "pass" | "needs_attention" | "not_found", "issues": [...]},
"technical_debt_status": {"status": "pass" | "needs_attention" | "not_found", "issues": [...]},
```

Keep existing keys stable.

- [ ] **Step 4: Extend `asset_closeout.py`**

Update `build_closeout(root, topic)`:

- if milestone issues mention status/progress drift, append `update milestone progress`
- if technical-debt issues exist or an open debt matches the completed topic, append `resolve or update technical debt records`
- keep route `archive` when requirement archive is missing
- use route `update-existing` when archive exists but milestone/debt/index checks require action

Add related assets:

```python
"milestones": [item["path"] for item in status["milestone_assets"]],
"technical_debt": [item["path"] for item in status["technical_debt_assets"]],
```

- [ ] **Step 5: Extend related asset search**

Update `find_related_assets.py` to include `milestones` and `technical-debt` when no `--area` limit is supplied. Keep the existing default priority with archives/problems/inbox ahead of project-level ledgers for requirement/problem routing.

- [ ] **Step 6: Keep route suggestion stable**

Update `suggest_asset_route.py` so changed milestone or technical-debt files can add `update-existing`, but do not add new route values. Add fact strings:

```text
Changed files include milestone assets.
Changed files include technical-debt assets.
```

- [ ] **Step 7: Run focused status and closeout tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_status_and_closeout_report_milestone_and_debt_gaps plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_status_reports_archived_topic_and_related_problem plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_closeout_blocks_completed_topic_without_archive
```

Expected: PASS.

- [ ] **Step 8: Run full tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 9: Commit status integration**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\asset_status.py plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\asset_closeout.py plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\find_related_assets.py plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\suggest_asset_route.py plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "feat: report milestone and debt closeout gaps"
```

---

### Task 7: Add New Skills and Skill Metadata

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/SKILL.md`
- Create: `plugins/superpowers-asset-compounding/skills/manage-superpowers-milestone/agents/openai.yaml`
- Create: `plugins/superpowers-asset-compounding/skills/manage-technical-debt/SKILL.md`
- Create: `plugins/superpowers-asset-compounding/skills/manage-technical-debt/agents/openai.yaml`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add skill existence and frontmatter tests**

Add this test method:

```python
    def test_v030_skills_exist_with_required_metadata(self) -> None:
        milestone_skill = SKILLS / "manage-superpowers-milestone" / "SKILL.md"
        debt_skill = SKILLS / "manage-technical-debt" / "SKILL.md"
        self.assertTrue(milestone_skill.is_file())
        self.assertTrue(debt_skill.is_file())
        milestone_text = milestone_skill.read_text(encoding="utf-8")
        debt_text = debt_skill.read_text(encoding="utf-8")
        self.assertIn("name: manage-superpowers-milestone", milestone_text)
        self.assertIn("description:", milestone_text)
        self.assertIn("milestone_assets.py", milestone_text)
        self.assertIn("strategic significance", milestone_text.lower())
        self.assertIn("name: manage-technical-debt", debt_text)
        self.assertIn("description:", debt_text)
        self.assertIn("technical_debt_assets.py", debt_text)
        self.assertIn("technical debt is not split into large and small", debt_text.lower())
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_v030_skills_exist_with_required_metadata
```

Expected: FAIL because the two skill folders do not exist.

- [ ] **Step 3: Create `manage-superpowers-milestone/SKILL.md`**

Use concise frontmatter:

```markdown
---
name: manage-superpowers-milestone
description: Create, update, check, and close project milestone ledgers under docs/milestones. Use when a strategically meaningful continuous development phase needs tracked slices, README/CHECKLIST templates, progress recomputation, status checks, or INDEX.md synchronization.
---
```

Body requirements:

- Explain large and small milestones.
- State that strategic significance defines a milestone more than slice count.
- Require scripts for state updates.
- Route creation/update/check commands through `milestone_assets.py`.
- Tell agents to keep `CHECKLIST.md` at progress-ledger level and keep implementation details in specs/plans.
- Tell agents to run `milestone_assets.py check --json` after edits.

- [ ] **Step 4: Create `manage-technical-debt/SKILL.md`**

Use concise frontmatter:

```markdown
---
name: manage-technical-debt
description: Create, update, close, and check technical-debt records under docs/technical-debt. Use when an engineering debt item needs a template, status transition, revisit trigger, resolution criteria, closure archive link, or INDEX.md synchronization.
---
```

Body requirements:

- State that technical debt is not split into large and small categories.
- Contrast technical debt with problem assets.
- Require scripts for state updates.
- Route creation/status/closure/check commands through `technical_debt_assets.py`.
- Require `Closed` debt to have a `Closure` section and archive link.
- Tell agents to run `technical_debt_assets.py check --json` after edits.

- [ ] **Step 5: Create `agents/openai.yaml` for milestone skill**

Create:

```yaml
name: manage-superpowers-milestone
display_name: Manage Superpowers Milestone
short_description: Create and maintain milestone ledgers.
default_prompt: Use $manage-superpowers-milestone to create, update, recompute, or check a docs/milestones progress ledger.
```

- [ ] **Step 6: Create `agents/openai.yaml` for technical debt skill**

Create:

```yaml
name: manage-technical-debt
display_name: Manage Technical Debt
short_description: Create and maintain technical-debt records.
default_prompt: Use $manage-technical-debt to create, update, close, or check a docs/technical-debt record.
```

- [ ] **Step 7: Validate skill folders**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python C:\Users\10062\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins\superpowers-asset-compounding\skills\manage-superpowers-milestone
python C:\Users\10062\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins\superpowers-asset-compounding\skills\manage-technical-debt
```

Expected: both validations pass.

- [ ] **Step 8: Run focused and full tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_v030_skills_exist_with_required_metadata
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 9: Commit skills**

Run:

```powershell
git add plugins\superpowers-asset-compounding\skills\manage-superpowers-milestone plugins\superpowers-asset-compounding\skills\manage-technical-debt plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "feat: add milestone and debt skills"
```

---

### Task 8: Update Documentation, Manifest, Bootstrap Guidance, and Version

**Files:**
- Modify: `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
- Modify: `plugins/superpowers-asset-compounding/README.md`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/SKILL.md`
- Modify: `plugins/superpowers-asset-compounding/skills/using-asset-compounding/SKILL.md`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/references/agents-asset-guidance-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/bootstrap_asset_compounding.py`
- Modify: `AGENTS.md`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Add docs/version tests**

Add this test method:

```python
    def test_v030_manifest_and_docs_mention_new_asset_types(self) -> None:
        manifest = json.loads((ROOT / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "0.3.0")
        self.assertIn("milestones", manifest["interface"]["longDescription"])
        self.assertIn("technical debt", manifest["interface"]["longDescription"].lower())

        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("Version `0.3.0`", readme)
        self.assertIn("manage-superpowers-milestone", readme)
        self.assertIn("manage-technical-debt", readme)

        guidance = (SKILLS / "compound-development-asset" / "references" / "agents-asset-guidance-template.md").read_text(encoding="utf-8")
        self.assertIn("docs/milestones/", guidance)
        self.assertIn("docs/technical-debt/", guidance)
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_v030_manifest_and_docs_mention_new_asset_types
```

Expected: FAIL because manifest is still `0.2.9` and docs do not mention the new skills.

- [ ] **Step 3: Update manifest**

In `.codex-plugin/plugin.json`:

- change `version` to `0.3.0`
- add keywords:

```json
"milestones",
"technical-debt"
```

- update `interface.longDescription` to mention milestone ledgers and technical-debt records.
- update `interface.defaultPrompt` to include:

```json
"Create or update a project milestone ledger.",
"Create or close a technical-debt record."
```

- [ ] **Step 4: Update README**

Change the version paragraph to `0.3.0`. Update the skill list from four skills to six skills:

- `using-asset-compounding`
- `compound-development-asset`
- `archive-superpowers-feature`
- `write-superpowers-problem`
- `manage-superpowers-milestone`
- `manage-technical-debt`

Add commands:

```powershell
python <plugin>\skills\compound-development-asset\scripts\milestone_assets.py . check --json
python <plugin>\skills\compound-development-asset\scripts\technical_debt_assets.py . check --json
```

Mention that `asset_status.py` and `asset_closeout.py` can report milestone and technical-debt gaps.

- [ ] **Step 5: Update compound and using skills**

In `compound-development-asset/SKILL.md`:

- add milestone and technical-debt layout under project asset directories
- mention `milestone_assets.py` and `technical_debt_assets.py`
- keep route choices unchanged
- state that project-level ledger gaps usually produce `update-existing` or required actions

In `using-asset-compounding/SKILL.md`:

- mention milestone/debt signals as related assets and closeout evidence
- do not add new route values

- [ ] **Step 6: Update AGENTS retrieval guidance**

In `agents-asset-guidance-template.md`, add:

```markdown
- Milestones: `docs/milestones/`
- Technical debt: `docs/technical-debt/`
```

Update `AGENTS.md` with the same repository-specific retrieval anchors outside generic workflow prose.

- [ ] **Step 7: Update bootstrap**

Modify `bootstrap_asset_compounding.py` so new repositories can create:

```text
docs/milestones/
docs/technical-debt/
```

Do not force milestone/debt indexes when no project-level assets exist unless the bootstrap already creates empty indexes for other areas. Preserve idempotency.

- [ ] **Step 8: Run focused docs/version test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_v030_manifest_and_docs_mention_new_asset_types
```

Expected: PASS.

- [ ] **Step 9: Validate manifest JSON**

Run:

```powershell
python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json
```

Expected: pretty-prints JSON and shows `"version": "0.3.0"`.

- [ ] **Step 10: Run full tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 11: Commit v0.3.0 metadata and docs**

Run:

```powershell
git add plugins\superpowers-asset-compounding\.codex-plugin\plugin.json plugins\superpowers-asset-compounding\README.md plugins\superpowers-asset-compounding\skills\compound-development-asset\SKILL.md plugins\superpowers-asset-compounding\skills\using-asset-compounding\SKILL.md plugins\superpowers-asset-compounding\skills\compound-development-asset\references\agents-asset-guidance-template.md plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\bootstrap_asset_compounding.py AGENTS.md plugins\superpowers-asset-compounding\tests\test_asset_scripts.py
git commit -m "docs: update asset compounding v0.3.0 guidance"
```

---

### Task 9: Full Verification, Local Plugin Sync, and Cache Validation

**Files:**
- No source files expected after this task unless validation exposes a defect.

- [ ] **Step 1: Run full source tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: PASS.

- [ ] **Step 2: Run whitespace check**

Run:

```powershell
git diff --check HEAD
```

Expected: no output.

- [ ] **Step 3: Sync local plugin cache**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python C:\Users\10062\.codex\skills\develop-local-codex-plugin\scripts\sync_local_plugin_cache.py superpowers-asset-compounding
```

Expected: sync succeeds and creates or updates `C:\Users\10062\.codex\plugins\cache\local-home\superpowers-asset-compounding\0.3.0`.

- [ ] **Step 4: Validate local plugin**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python C:\Users\10062\.codex\skills\develop-local-codex-plugin\scripts\validate_local_plugin.py superpowers-asset-compounding
```

Expected: validation reports that source, cache, marketplace, config, and skills are valid.

- [ ] **Step 5: Run cache smoke checks**

Run:

```powershell
$cache = 'C:\Users\10062\.codex\plugins\cache\local-home\superpowers-asset-compounding\0.3.0'
$env:PYTHONIOENCODING='utf-8'
python "$cache\skills\compound-development-asset\scripts\milestone_assets.py" . check --json
python "$cache\skills\compound-development-asset\scripts\technical_debt_assets.py" . check --json
```

Expected: both commands execute from cache and return JSON.

- [ ] **Step 6: Commit cache-relevant validation fixes**

If any source files changed because validation exposed defects, run the relevant focused tests again and commit:

```powershell
git add <changed-source-files>
git commit -m "fix: address v0.3.0 plugin validation"
```

If no files changed, record the validation evidence in the final handoff and continue.

---

### Task 10: Archive v0.3.0 Delivery and Final Asset Closeout

**Files:**
- Create: `docs/superpowers/archives/2026-06/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md`
- Modify: `docs/superpowers/archives/INDEX.md`

- [ ] **Step 1: Create the delivery archive**

Use `archive-superpowers-feature` rules to create:

```text
docs/superpowers/archives/2026-06/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md
```

Required metadata:

```markdown
- Date: `2026-06-13`
- Topic slug: `asset-compounding-v0.3.0-milestones-and-debt`
- Status: `Archived`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `milestones`, `technical-debt`, `scripts`, `skills`
```

Source documents:

```markdown
- Spec: [Asset Compounding v0.3.0 Milestones and Technical Debt Design](../../specs/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-design.md)
- Plan: [Asset Compounding v0.3.0 Milestones and Technical Debt Implementation Plan](../../plans/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt.md)
```

Verification snapshot must include:

- full source test result
- manifest JSON validation
- local cache sync result
- local plugin validation result
- cache smoke result

- [ ] **Step 2: Update archive index**

Add this line under `## 2026-06` in `docs/superpowers/archives/INDEX.md`:

```markdown
- [2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md](./2026-06/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md): 归档 superpowers-asset-compounding v0.3.0，新增 milestone 与 technical-debt 管理技能，拆分脚本职责，并把项目级账本状态接入 topic status 与 closeout。
```

- [ ] **Step 3: Validate archive document**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\archive-superpowers-feature\scripts\validate_archive_asset.py docs\superpowers\archives\2026-06\2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md
```

Expected: archive asset is valid.

- [ ] **Step 4: Validate all indexes**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_indexes.py . --json
```

Expected: JSON result has no issues.

- [ ] **Step 5: Run closeout for completed topic**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\asset_closeout.py . --topic "asset-compounding-v0.3.0-milestones-and-debt" --json
```

Expected: status is `pass`, route is `none`, requirement archive is present.

- [ ] **Step 6: Commit archive**

Run:

```powershell
git add docs\superpowers\archives\2026-06\2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-archives.md docs\superpowers\archives\INDEX.md
git commit -m "docs: archive asset compounding v0.3.0"
```

---

## Final Review Checklist

- [ ] Existing CLI script names still work.
- [ ] Existing archive/problem/inbox tests still pass.
- [ ] `asset_gate.route` values are unchanged.
- [ ] Milestone status updates are script-owned.
- [ ] Technical-debt status updates are script-owned.
- [ ] Two new skills exist and validate.
- [ ] README and manifest mention six skills and version `0.3.0`.
- [ ] `asset_status.py` reports milestone and technical-debt matches.
- [ ] `asset_closeout.py` reports milestone and technical-debt required actions.
- [ ] Local plugin cache is synced to `0.3.0`.
- [ ] Local plugin validation passes.
- [ ] v0.3.0 archive and archive index are updated.

## Self-Review

- Spec coverage: This plan covers both new skills, milestone definitions, technical-debt definitions, script-owned state updates, script responsibility split, status/closeout integration, unchanged route vocabulary, tests, docs, version bump, local cache sync, and final archive closeout.
- Placeholder scan: Avoided unresolved markers, vague implementation steps, and unspecified test commands.
- Type consistency: Script names, status values, issue codes, and JSON field names are consistent across tasks.
