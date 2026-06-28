from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import importlib.util
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
ROUTER = SKILLS / "compound-development-asset" / "scripts" / "suggest_asset_route.py"
FINDER = SKILLS / "compound-development-asset" / "scripts" / "find_related_assets.py"
CHECKER = SKILLS / "compound-development-asset" / "scripts" / "check_indexes.py"
COMPLETION_GATE = SKILLS / "compound-development-asset" / "scripts" / "check_completion_gate.py"
EMIT_ASSET_GATE = SKILLS / "compound-development-asset" / "scripts" / "emit_asset_gate.py"
ASSET_STATUS = SKILLS / "compound-development-asset" / "scripts" / "asset_status.py"
ASSET_CLOSEOUT = SKILLS / "compound-development-asset" / "scripts" / "asset_closeout.py"
MILESTONE_ASSETS = SKILLS / "compound-development-asset" / "scripts" / "milestone_assets.py"
TECHNICAL_DEBT_ASSETS = SKILLS / "compound-development-asset" / "scripts" / "technical_debt_assets.py"
BOOTSTRAP = SKILLS / "compound-development-asset" / "scripts" / "bootstrap_asset_compounding.py"
AGENT_GUIDANCE = SKILLS / "compound-development-asset" / "scripts" / "ensure_agent_asset_guidance.py"
ARCHIVE_VALIDATOR = SKILLS / "archive-superpowers-feature" / "scripts" / "validate_archive_asset.py"
PROBLEM_VALIDATOR = SKILLS / "write-superpowers-problem" / "scripts" / "validate_problem_asset.py"
INBOX_INSPECTOR = SKILLS / "write-superpowers-problem" / "scripts" / "inspect_inbox_lifecycle.py"
HOOKS_CONFIG = ROOT / "hooks" / "hooks.json"
HOOK_SCRIPT = ROOT / "hooks" / "asset_hook.py"
HOOK_REPORT = ROOT / "hooks" / "asset_hook_report.py"
HOOK_LAUNCHER = ROOT / "hooks" / "run_asset_hook.cmd"
HOOK_BASH_LAUNCHER = ROOT / "hooks" / "run_asset_hook.sh"


class AssetScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp(prefix="asset_script_tests_"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def test_v030_skills_exist_with_required_metadata(self) -> None:
        milestone_skill = SKILLS / "manage-superpowers-milestone" / "SKILL.md"
        debt_skill = SKILLS / "manage-technical-debt" / "SKILL.md"
        milestone_agent = SKILLS / "manage-superpowers-milestone" / "agents" / "openai.yaml"
        debt_agent = SKILLS / "manage-technical-debt" / "agents" / "openai.yaml"
        self.assertTrue(milestone_skill.is_file())
        self.assertTrue(debt_skill.is_file())
        self.assertTrue(milestone_agent.is_file())
        self.assertTrue(debt_agent.is_file())
        milestone_text = milestone_skill.read_text(encoding="utf-8")
        debt_text = debt_skill.read_text(encoding="utf-8")
        milestone_agent_text = milestone_agent.read_text(encoding="utf-8")
        debt_agent_text = debt_agent.read_text(encoding="utf-8")
        self.assertIn("name: manage-superpowers-milestone", milestone_text)
        self.assertIn("description:", milestone_text)
        self.assertIn("milestone_assets.py", milestone_text)
        self.assertIn("strategic significance", milestone_text.lower())
        self.assertIn("target stage", milestone_text.lower())
        self.assertIn("acceptance criteria", milestone_text.lower())
        self.assertIn("slice boundary", milestone_text.lower())
        self.assertIn("ensure_agent_asset_guidance.py", milestone_text)
        self.assertIn("AGENTS.md", milestone_text)
        self.assertIn("docs/milestones/INDEX.md", milestone_text)
        self.assertNotIn("English `Milestone Navigation`", milestone_text)
        self.assertIn("After a slice is delivered, deferred, split", milestone_text)
        self.assertIn("name: manage-technical-debt", debt_text)
        self.assertIn("description:", debt_text)
        self.assertIn("technical_debt_assets.py", debt_text)
        self.assertIn("technical debt is not split into large and small", debt_text.lower())
        self.assertIn("why the debt exists", debt_text.lower())
        self.assertIn("how the debt was discovered", debt_text.lower())
        self.assertIn("initial resolution direction", debt_text.lower())
        self.assertIn("ensure_agent_asset_guidance.py", debt_text)
        self.assertIn("AGENTS.md", debt_text)
        self.assertIn("docs/technical-debt/INDEX.md", debt_text)
        self.assertNotIn("English `Technical Debt Navigation`", debt_text)
        self.assertIn("After debt is resolved, superseded, closed", debt_text)
        self.assertIn('interface:\n  display_name: "Manage Superpowers Milestone"', milestone_agent_text)
        self.assertIn('  short_description: "Create and maintain milestone ledgers."', milestone_agent_text)
        self.assertIn(
            '  default_prompt: "Use $manage-superpowers-milestone to create, update, recompute, or check a docs/milestones progress ledger."',
            milestone_agent_text,
        )
        self.assertIn('interface:\n  display_name: "Manage Technical Debt"', debt_agent_text)
        self.assertIn('  short_description: "Create and maintain technical-debt records."', debt_agent_text)
        self.assertIn(
            '  default_prompt: "Use $manage-technical-debt to create, update, close, or check a docs/technical-debt record."',
            debt_agent_text,
        )

    def test_asset_compounding_plugin_metadata_mentions_v032_audit_archive(self) -> None:
        manifest = json.loads((ROOT / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "0.3.3")
        self.assertIn("milestones", manifest["interface"]["longDescription"])
        self.assertIn("technical debt", manifest["interface"]["longDescription"].lower())

        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("v0.3.3", readme)
        self.assertIn("manage-superpowers-milestone", readme)
        self.assertIn("manage-technical-debt", readme)
        self.assertIn("structured `asset_gate` validation", readme)
        self.assertIn("archive --before", readme)
        self.assertIn("--since", readme)
        self.assertIn("merge_only_closeout", readme)
        self.assertIn("session summaries", readme)
        self.assertIn("report filters", readme)
        self.assertIn(
            "The reports do not include raw commands, prompts, diffs, command output, full repository paths, or secrets",
            readme,
        )

        guidance = (
            SKILLS / "compound-development-asset" / "references" / "agents-asset-guidance-template.md"
        ).read_text(encoding="utf-8")
        milestone_template = (
            SKILLS / "manage-superpowers-milestone" / "references" / "milestone-readme-template.md"
        ).read_text(encoding="utf-8")
        debt_template = (
            SKILLS / "manage-technical-debt" / "references" / "technical-debt-template.md"
        ).read_text(encoding="utf-8")
        self.assertIn("docs/milestones/", guidance)
        self.assertIn("docs/technical-debt/", guidance)
        self.assertIn("Milestone Navigation", guidance)
        self.assertIn("docs/milestones/INDEX.md", guidance)
        self.assertIn("Technical Debt Navigation", guidance)
        self.assertIn("docs/technical-debt/INDEX.md", guidance)
        self.assertIn("asset-compounding-guidance:version=0.3.1", guidance)
        self.assertIn("Repository Context Guidance", guidance)
        self.assertIn("runtime commands", guidance)
        self.assertIn("current active milestone", guidance)
        self.assertIn("After completing, deferring, or splitting a milestone slice", guidance)
        self.assertIn("After resolving, closing, superseding, or intentionally keeping a debt item", guidance)
        self.assertIn("## Technical Context", milestone_template)
        self.assertIn("## Architecture Constraints", milestone_template)
        self.assertIn("## How Discovered", debt_template)
        self.assertIn("## Reference Signals", debt_template)
        self.assertIn("## Closure", debt_template)

    def run_json(self, *args: object) -> dict[str, object]:
        completed = subprocess.run(
            ["python", *map(str, args)],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        return json.loads(completed.stdout)

    def run_json_fail(self, *args: object) -> dict[str, object]:
        completed = subprocess.run(
            ["python", *map(str, args)],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertNotEqual(completed.returncode, 0)
        return json.loads(completed.stdout)

    def run_hook(self, event: dict[str, object], *, plugin_data: Path | None = None) -> tuple[int, str, str]:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PLUGIN_ROOT"] = str(ROOT)
        env["PLUGIN_DATA"] = str(plugin_data or (self.temp_root / "plugin-data"))
        completed = subprocess.run(
            ["python", str(HOOK_SCRIPT)],
            input=json.dumps(event),
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        return completed.returncode, completed.stdout, completed.stderr

    def run_hook_raw(self, payload: bytes, *, plugin_data: Path | None = None) -> tuple[int, str, str]:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PLUGIN_ROOT"] = str(ROOT)
        env["PLUGIN_DATA"] = str(plugin_data or (self.temp_root / "plugin-data"))
        completed = subprocess.run(
            ["python", str(HOOK_SCRIPT)],
            input=payload,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        return (
            completed.returncode,
            completed.stdout.decode("utf-8", errors="replace"),
            completed.stderr.decode("utf-8", errors="replace"),
        )

    def create_repo(self) -> Path:
        repo = self.temp_root / "repo"
        for area in ("specs", "plans", "archives/2026-05", "problems/2026-05"):
            (repo / "docs" / "superpowers" / area).mkdir(parents=True, exist_ok=True)
        (repo / "docs/superpowers/specs/2026-05-01-demo-feature-design.md").write_text(
            "# Demo Feature Design\n\nDemo feature verification.\n",
            encoding="utf-8",
        )
        (repo / "docs/superpowers/plans/2026-05-01-demo-feature.md").write_text(
            "# Demo Feature Plan\n\nDemo feature implementation plan.\n",
            encoding="utf-8",
        )
        return repo

    def create_debt_named_repo(self) -> Path:
        repo = self.temp_root / "debt_named_repo"
        for area in ("specs", "plans", "archives/2026-06"):
            (repo / "docs" / "superpowers" / area).mkdir(parents=True, exist_ok=True)
        topic = "asset-compounding-v0.3.0-milestones-and-debt"
        (repo / f"docs/superpowers/specs/2026-06-13-{topic}-design.md").write_text(
            "# Asset Compounding Milestones And Debt Design\n\nSpec.\n",
            encoding="utf-8",
        )
        (repo / f"docs/superpowers/plans/2026-06-13-{topic}.md").write_text(
            "# Asset Compounding Milestones And Debt Plan\n\nPlan.\n",
            encoding="utf-8",
        )
        return repo

    def audit_dir(self, plugin_data: Path, repo: Path, session_id: str = "session-1") -> Path:
        return plugin_data / f"{repo.name}--{session_id}"

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

    def test_asset_core_iter_assets_keeps_default_scope_and_allows_explicit_project_areas(self) -> None:
        repo = self.create_repo()
        milestone_root = repo / "docs/milestones/2026-06/demo-milestone"
        milestone_root.mkdir(parents=True)
        (milestone_root / "README.md").write_text("# Demo Milestone\n", encoding="utf-8")
        debt_root = repo / "docs/technical-debt/2026-06"
        debt_root.mkdir(parents=True)
        (debt_root / "2026-06-13-demo-debt-debt.md").write_text("# Demo Debt\n", encoding="utf-8")

        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        sys.path.insert(0, str(scripts_root))
        try:
            spec = importlib.util.spec_from_file_location(
                "asset_core_discovery",
                scripts_root / "asset_core" / "discovery.py",
            )
            self.assertIsNotNone(spec)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop("asset_core_discovery", None)
            sys.path.remove(str(scripts_root))

        superpowers_root = repo / "docs/superpowers"
        default_areas = {asset.area for asset in module.iter_assets(superpowers_root)}
        self.assertEqual(default_areas, {"specs", "plans"})

        milestone_assets = module.iter_assets(superpowers_root, ["milestones"])
        self.assertEqual(
            [(asset.area, asset.date, asset.slug, asset.title) for asset in milestone_assets],
            [("milestones", "2026-06", "demo-milestone", "Demo Milestone")],
        )
        debt_assets = module.iter_assets(superpowers_root, ["technical-debt"])
        self.assertEqual([(asset.area, asset.title) for asset in debt_assets], [("technical-debt", "Demo Debt")])

    def test_asset_core_iter_assets_preserves_legacy_asset_root_inputs(self) -> None:
        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        sys.path.insert(0, str(scripts_root))
        try:
            spec = importlib.util.spec_from_file_location(
                "asset_core_discovery",
                scripts_root / "asset_core" / "discovery.py",
            )
            self.assertIsNotNone(spec)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop("asset_core_discovery", None)
            sys.path.remove(str(scripts_root))

        repo = self.create_repo()
        superpowers_assets = module.iter_assets(repo / "docs/superpowers")
        self.assertIn(("specs", "demo-feature"), {(asset.area, asset.slug) for asset in superpowers_assets})
        self.assertIn(("plans", "demo-feature"), {(asset.area, asset.slug) for asset in superpowers_assets})

        asset_root = self.temp_root / "standalone_asset_root"
        archive_root = asset_root / "archives/2026-05"
        archive_root.mkdir(parents=True)
        (archive_root / "2026-05-01-standalone-feature-archives.md").write_text(
            "# Standalone Feature Archive\n",
            encoding="utf-8",
        )

        loose_assets = module.iter_assets(asset_root)
        self.assertEqual(
            [(asset.area, asset.slug, asset.title) for asset in loose_assets],
            [("archives", "standalone-feature", "Standalone Feature Archive")],
        )

    def add_archive(self, repo: Path) -> Path:
        archive = repo / "docs/superpowers/archives/2026-05/2026-05-01-demo-feature-archives.md"
        archive.write_text(
            """# Demo Feature Archive

- Date: `2026-05-01`
- Topic slug: `demo-feature`
- Status: `Archived`
- Scope: `Feature`
- Tags: `demo`

## Summary

Archived.

## Delivered Scope

- Delivered.

## Out of Scope

- Out.

## Verification Snapshot

- Verified.

## Source Documents

- Spec: [spec](../../specs/2026-05-01-demo-feature-design.md)
- Plan: [plan](../../plans/2026-05-01-demo-feature.md)

## Related Problems

- None yet.

## Notes

- Note.
""",
            encoding="utf-8",
        )
        (repo / "docs/superpowers/archives/INDEX.md").write_text(
            """# Superpowers Archive Index

## 2026-05

- [2026-05-01-demo-feature-archives.md](./2026-05/2026-05-01-demo-feature-archives.md): Demo archive.
""",
            encoding="utf-8",
        )
        return archive

    def add_problem(self, repo: Path) -> Path:
        problem = repo / "docs/superpowers/problems/2026-05/2026-05-01-demo-problem-problem.md"
        problem.write_text(
            """# Demo Problem

- Date: `2026-05-01`
- Topic slug: `demo-problem`
- Status: `Captured`
- Scope: `Test`
- Tags: `demo`

## Symptom

Symptom.

## Trigger / Context

- Trigger.

## Root Cause

Root cause.

## Fix

- Fix.

## Why This Fix

Reason.

## Recognition Clues

- Cue.

## Applicability / Non-Applicability

### Applies When

- Applies.

### Does Not Apply When

- Does not apply.

## Related Artifacts

- Archive: [archive](../../archives/2026-05/2026-05-01-demo-feature-archives.md)
""",
            encoding="utf-8",
        )
        (repo / "docs/superpowers/problems/INDEX.md").write_text(
            """# Superpowers Problem Index

## 2026-05

- [2026-05-01-demo-problem-problem.md](./2026-05/2026-05-01-demo-problem-problem.md): Demo problem.
""",
            encoding="utf-8",
        )
        return problem

    def add_inbox(self, repo: Path, *, include_lifecycle: bool = True) -> Path:
        inbox_root = repo / "docs/superpowers/inbox/2026-05"
        inbox_root.mkdir(parents=True, exist_ok=True)
        lifecycle_lines = ""
        if include_lifecycle:
            lifecycle_lines = "- Lifecycle: `Open`\n- Revisit trigger: `When the signal recurs or stabilizes.`\n"
        inbox = inbox_root / "2026-05-01-demo-signal-inbox.md"
        inbox.write_text(
            f"""# Demo Signal

- Date: `2026-05-01`
- Topic slug: `demo-signal`
- Status: `Inbox`
{lifecycle_lines if include_lifecycle else ""}- Scope: `Test`
- Confidence: `Medium`
- Route candidate: `new-problem`

## Signal

Signal.

## Why It Might Matter

It might recur.

## What Is Missing

- Stable root cause.

## Likely Next Route

Promote if repeated.

## Related Assets

- Problems:
  - None yet.
""",
            encoding="utf-8",
        )
        return inbox

    def add_project_index_assets(self, repo: Path, *, duplicate_checklist_link: bool = False) -> None:
        milestone_root = repo / "docs/milestones/2026-06/demo-milestone"
        milestone_root.mkdir(parents=True, exist_ok=True)
        (milestone_root / "README.md").write_text(
            "# Demo Milestone\n\n## Strategic Significance\n\nImportant.\n",
            encoding="utf-8",
        )
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
        checklist_cell = "[Checklist](2026-06/demo-milestone/CHECKLIST.md)"
        if duplicate_checklist_link:
            checklist_cell = (
                "[Checklist](2026-06/demo-milestone/CHECKLIST.md) "
                "[Checklist copy](2026-06/demo-milestone/CHECKLIST.md)"
            )
        (repo / "docs/milestones/INDEX.md").write_text(
            f"""# Milestones

| Month | Milestone | Checklist | Status | Progress | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-06 | [Demo Milestone](2026-06/demo-milestone/README.md) | {checklist_cell} | In Progress | 0/1 | Important |
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

    def create_technical_debt(
        self,
        repo: Path,
        *,
        date: str = "2026-06-13",
        slug: str = "demo-debt",
        title: str = "Demo Debt",
        priority: str = "Medium",
    ) -> dict[str, object]:
        return self.run_json(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "create",
            "--date",
            date,
            "--slug",
            slug,
            "--title",
            title,
            "--milestone",
            "Demo Alpha",
            "--debt-type",
            "Architecture",
            "--priority",
            priority,
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

    def load_index_module(self) -> object:
        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        sys.path.insert(0, str(scripts_root))
        try:
            spec = importlib.util.spec_from_file_location(
                "asset_core_indexes",
                scripts_root / "asset_core" / "indexes.py",
            )
            self.assertIsNotNone(spec)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            return module
        finally:
            sys.modules.pop("asset_core_indexes", None)
            sys.path.remove(str(scripts_root))

    def test_spec_plan_without_archive_routes_to_archive(self) -> None:
        repo = self.create_repo()
        result = self.run_json(ROUTER, repo, "--keywords", "demo", "feature", "--json")
        self.assertEqual(result["routes"], ["archive"])

    def test_finder_recognizes_plain_plan_markdown_files(self) -> None:
        repo = self.create_repo()
        result = self.run_json(FINDER, repo, "demo", "feature", "--json")
        self.assertIn("plans", {item["area"] for item in result["results"]})

    def test_finder_includes_project_level_ledgers_by_default(self) -> None:
        repo = self.create_repo()
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
            "--strategic-significance",
            "Demo Alpha proves a strategically important project path.",
            "--acceptance",
            "Demo Alpha can complete tracked stages.",
            "--write",
            "--json",
        )
        self.create_technical_debt(repo, slug="demo-feature", title="Demo Feature Debt")

        result = self.run_json(FINDER, repo, "demo", "feature", "--json")

        self.assertIn("milestones", {item["area"] for item in result["results"]})
        self.assertIn("technical-debt", {item["area"] for item in result["results"]})

    def test_existing_archive_routes_to_update_existing(self) -> None:
        repo = self.create_repo()
        self.add_archive(repo)
        result = self.run_json(ROUTER, repo, "--keywords", "demo", "feature", "completed", "--json")
        self.assertEqual(result["routes"], ["update-existing"])

    def test_changed_milestone_and_technical_debt_assets_route_to_update_existing(self) -> None:
        repo = self.create_repo()

        result = self.run_json(
            ROUTER,
            repo,
            "--changed-file",
            "docs/milestones/2026-06/demo-alpha/README.md",
            "--changed-file",
            "docs/technical-debt/2026-06/2026-06-13-demo-feature-debt.md",
            "--json",
        )

        self.assertEqual(result["routes"], ["update-existing"])
        self.assertIn("Changed files include milestone assets.", result["facts"])
        self.assertIn("Changed files include technical-debt assets.", result["facts"])

    def test_lightweight_polish_signal_routes_to_none(self) -> None:
        repo = self.temp_root / "lightweight_repo"
        (repo / "docs" / "superpowers").mkdir(parents=True)
        result = self.run_json(ROUTER, repo, "--keywords", "minor", "fix", "visual", "issue", "--json")
        self.assertEqual(result["routes"], ["none"])

    def test_uncertain_problem_signal_routes_to_inbox(self) -> None:
        repo = self.temp_root / "weak_repo"
        (repo / "docs" / "superpowers").mkdir(parents=True)
        result = self.run_json(
            ROUTER,
            repo,
            "--keywords",
            "minor",
            "fix",
            "visual",
            "issue",
            "possibly",
            "--json",
        )
        self.assertEqual(result["routes"], ["inbox"])

    def test_problem_gate_routes_lightweight_problem_signal_to_inbox(self) -> None:
        repo = self.temp_root / "problem_gate_repo"
        (repo / "docs" / "superpowers").mkdir(parents=True)
        result = self.run_json(
            ROUTER,
            repo,
            "--keywords",
            "minor",
            "fix",
            "visual",
            "issue",
            "--problem-gate",
            "--json",
        )
        self.assertEqual(result["routes"], ["inbox"])

    def test_problem_gate_review_candidate_routes_to_inbox(self) -> None:
        repo = self.temp_root / "review_gate_repo"
        (repo / "docs" / "superpowers").mkdir(parents=True)
        result = self.run_json(
            ROUTER,
            repo,
            "--keywords",
            "code",
            "quality",
            "review",
            "finding",
            "candidate",
            "--problem-gate",
            "--json",
        )
        self.assertEqual(result["routes"], ["inbox"])

    def test_stable_root_cause_signal_routes_to_new_problem(self) -> None:
        repo = self.temp_root / "strong_repo"
        (repo / "docs" / "superpowers").mkdir(parents=True)
        result = self.run_json(ROUTER, repo, "--keywords", "root", "cause", "recovery", "rule", "--json")
        self.assertEqual(result["routes"], ["new-problem"])

    def test_release_ci_warning_routes_to_inbox(self) -> None:
        repo = self.temp_root / "ci_warning_repo"
        (repo / "docs" / "superpowers").mkdir(parents=True)
        result = self.run_json(
            ROUTER,
            repo,
            "--keywords",
            "github",
            "actions",
            "node",
            "20",
            "deprecated",
            "warning",
            "release",
            "workflow",
            "--problem-gate",
            "--json",
        )
        self.assertEqual(result["routes"], ["inbox"])

    def test_release_ci_warning_updates_existing_release_asset(self) -> None:
        repo = self.create_repo()
        self.add_archive(repo)
        result = self.run_json(
            ROUTER,
            repo,
            "--keywords",
            "demo",
            "feature",
            "github",
            "actions",
            "node",
            "20",
            "deprecated",
            "warning",
            "release",
            "workflow",
            "--problem-gate",
            "--json",
        )
        self.assertEqual(result["routes"], ["update-existing"])

    def test_inbox_validator_warns_when_lifecycle_metadata_is_missing(self) -> None:
        repo = self.create_repo()
        inbox = self.add_inbox(repo, include_lifecycle=False)
        result = self.run_json(PROBLEM_VALIDATOR, inbox, "--kind", "inbox", "--json")
        issues = result["issues"]
        self.assertEqual([issue["severity"] for issue in issues], ["warning"])
        self.assertEqual(issues[0]["code"], "missing_lifecycle")

    def test_inbox_lifecycle_inspector_reports_revisit_candidates(self) -> None:
        repo = self.create_repo()
        self.add_inbox(repo, include_lifecycle=True)
        result = self.run_json(INBOX_INSPECTOR, repo, "demo", "--json")

        self.assertEqual(len(result["items"]), 1)
        item = result["items"][0]
        self.assertEqual(item["lifecycle"], "Open")
        self.assertTrue(item["needs_revisit"])
        self.assertEqual(item["issues"], [])

    def test_inbox_lifecycle_inspector_flags_legacy_notes(self) -> None:
        repo = self.create_repo()
        self.add_inbox(repo, include_lifecycle=False)
        result = self.run_json(INBOX_INSPECTOR, repo, "demo", "--json")

        self.assertEqual(result["items"][0]["issues"], ["missing_lifecycle"])

    def test_archive_and_problem_validators_plus_index_checker(self) -> None:
        repo = self.create_repo()
        archive = self.add_archive(repo)
        problem = self.add_problem(repo)
        self.assertEqual(self.run_json(ARCHIVE_VALIDATOR, archive, "--json")["issues"], [])
        self.assertEqual(self.run_json(PROBLEM_VALIDATOR, problem, "--json")["issues"], [])
        self.assertEqual(self.run_json(CHECKER, repo, "--json")["issues"], [])

    def test_check_area_accepts_repo_root_for_superpowers_indexes(self) -> None:
        repo = self.create_repo()
        self.add_archive(repo)
        (repo / "docs/superpowers/archives/INDEX.md").write_text(
            """# Superpowers Archive Index

## 2026-05

- [missing-archive.md](./2026-05/missing-archive.md): Missing archive.
""",
            encoding="utf-8",
        )
        module = self.load_index_module()

        issues = module.check_area(repo, "archives")

        self.assertIn("dead_link", {issue["code"] for issue in issues})

    def test_check_indexes_accepts_docs_root_for_all_areas(self) -> None:
        repo = self.create_repo()
        self.add_archive(repo)
        self.add_problem(repo)
        self.add_project_index_assets(repo)

        result = self.run_json(CHECKER, repo / "docs", "--area", "all", "--json")

        self.assertEqual(result["issues"], [])

    def test_check_indexes_accepts_docs_root_without_superpowers_for_milestones(self) -> None:
        repo = self.temp_root / "project_only_repo"
        milestones_root = repo / "docs/milestones"
        milestones_root.mkdir(parents=True, exist_ok=True)
        (milestones_root / "INDEX.md").write_text(
            """# Milestones

| Month | Milestone | Checklist | Status | Progress | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-06 | [Missing Milestone](2026-06/missing-milestone/README.md) | [Checklist](2026-06/missing-milestone/CHECKLIST.md) | In Progress | 0/1 | Missing |
""",
            encoding="utf-8",
        )

        result = self.run_json_fail(CHECKER, repo / "docs", "--area", "milestones", "--json")

        self.assertIn("dead_link", {issue["code"] for issue in result["issues"]})

    def test_check_indexes_reports_duplicate_table_local_links(self) -> None:
        repo = self.create_repo()
        self.add_project_index_assets(repo, duplicate_checklist_link=True)

        result = self.run_json_fail(CHECKER, repo, "--area", "milestones", "--json")

        self.assertIn("duplicate_entry", {issue["code"] for issue in result["issues"]})

    def test_check_indexes_accepts_milestone_and_technical_debt_areas(self) -> None:
        repo = self.create_repo()
        self.add_project_index_assets(repo)

        self.assertEqual(self.run_json(CHECKER, repo, "--area", "milestones", "--json")["issues"], [])
        self.assertEqual(self.run_json(CHECKER, repo, "--area", "technical-debt", "--json")["issues"], [])

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

    def test_technical_debt_check_requires_archive_link_in_closure_section(self) -> None:
        repo = self.create_repo()
        archive = self.add_archive(repo)
        self.create_technical_debt(repo, slug="closure-link-debt", title="Closure Link Debt")
        debt = repo / "docs/technical-debt/2026-06/2026-06-13-closure-link-debt-debt.md"
        archive_link = str(archive.relative_to(repo).as_posix())
        text = debt.read_text(encoding="utf-8")
        text = text.replace("- Status: `Open`", "- Status: `Closed`")
        text = text.replace("- None yet.", f"- Archive: [{archive.name}]({archive_link})")
        debt.write_text(text + "\n## Closure\n\nClosed without a closure-local archive link.\n", encoding="utf-8")

        result = self.run_json_fail(TECHNICAL_DEBT_ASSETS, repo, "check", "--slug", "closure-link-debt", "--json")

        self.assertIn("closed_debt_missing_archive", {issue["code"] for issue in result["issues"]})

    def test_technical_debt_create_rejects_duplicate_slug_across_months(self) -> None:
        repo = self.create_repo()
        self.create_technical_debt(repo, date="2026-06-13", slug="duplicate-debt", title="Duplicate Debt")

        result = self.run_json_fail(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "create",
            "--date",
            "2026-07-01",
            "--slug",
            "duplicate-debt",
            "--title",
            "Duplicate Debt Again",
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

        self.assertEqual(result["issues"][0]["code"], "duplicate_technical_debt_slug")

    def test_technical_debt_check_and_commands_reject_duplicate_slugs(self) -> None:
        repo = self.create_repo()
        self.create_technical_debt(repo, date="2026-06-13", slug="ambiguous-debt", title="Ambiguous Debt")
        first = repo / "docs/technical-debt/2026-06/2026-06-13-ambiguous-debt-debt.md"
        second = repo / "docs/technical-debt/2026-07/2026-07-01-ambiguous-debt-debt.md"
        second.parent.mkdir(parents=True)
        second.write_text(
            first.read_text(encoding="utf-8").replace("- Date: `2026-06-13`", "- Date: `2026-07-01`"),
            encoding="utf-8",
        )

        checked = self.run_json_fail(TECHNICAL_DEBT_ASSETS, repo, "check", "--slug", "ambiguous-debt", "--json")
        updated = self.run_json_fail(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "set-status",
            "--slug",
            "ambiguous-debt",
            "--status",
            "In Progress",
            "--write",
            "--json",
        )

        self.assertEqual(checked["issues"][0]["code"], "duplicate_technical_debt_slug")
        self.assertEqual(updated["issues"][0]["code"], "duplicate_technical_debt_slug")

    def test_technical_debt_check_requires_metadata_and_filename_match(self) -> None:
        repo = self.create_repo()
        self.create_technical_debt(repo, slug="metadata-debt", title="Metadata Debt")
        debt = repo / "docs/technical-debt/2026-06/2026-06-13-metadata-debt-debt.md"
        lines = [
            line
            for line in debt.read_text(encoding="utf-8").splitlines()
            if not line.startswith("- Milestone: ")
        ]
        text = "\n".join(lines).replace("- Topic slug: `metadata-debt`", "- Topic slug: `different-debt`")
        debt.write_text(text + "\n", encoding="utf-8")

        result = self.run_json_fail(TECHNICAL_DEBT_ASSETS, repo, "check", "--slug", "metadata-debt", "--json")
        codes = {issue["code"] for issue in result["issues"]}

        self.assertIn("missing_debt_metadata", codes)
        self.assertIn("debt_filename_metadata_mismatch", codes)

    def test_technical_debt_set_status_missing_slug_returns_json_error(self) -> None:
        repo = self.create_repo()

        result = self.run_json_fail(
            TECHNICAL_DEBT_ASSETS,
            repo,
            "set-status",
            "--slug",
            "missing-debt",
            "--status",
            "In Progress",
            "--write",
            "--json",
        )

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "technical_debt_not_found")

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

    def test_milestone_update_slice_keeps_index_current_without_recompute(self) -> None:
        repo = self.create_repo()
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

        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "update-slice",
            "--slug",
            "demo-alpha",
            "--slice",
            "First Slice",
            "--status",
            "Done",
            "--archive",
            "../../../superpowers/archives/2026-05/2026-05-01-demo-feature-archives.md",
            "--write",
            "--json",
        )

        checked = self.run_json(MILESTONE_ASSETS, repo, "check", "--slug", "demo-alpha", "--json")
        self.assertEqual(checked["issues"], [])

    def test_milestone_deferred_slice_is_counted_and_indexed(self) -> None:
        repo = self.create_repo()
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
            "First Slice",
            "--strategic-significance",
            "Demo Alpha proves a strategically important project path.",
            "--acceptance",
            "Demo Alpha can complete its tracked stage.",
            "--write",
            "--json",
        )

        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "update-slice",
            "--slug",
            "demo-alpha",
            "--slice",
            "First Slice",
            "--status",
            "Deferred",
            "--write",
            "--json",
        )

        checklist = repo / "docs/milestones/2026-06/demo-alpha/CHECKLIST.md"
        text = checklist.read_text(encoding="utf-8")
        self.assertIn("- Status: Deferred", text)
        self.assertIn("- Deferred: 1", text)
        self.assertIn("- Split: 0", text)
        checked = self.run_json(MILESTONE_ASSETS, repo, "check", "--slug", "demo-alpha", "--json")
        self.assertEqual(checked["issues"], [])
        index = (repo / "docs/milestones/INDEX.md").read_text(encoding="utf-8")
        self.assertIn("| 2026-06 | [Demo Alpha](2026-06/demo-alpha/README.md) | [Checklist](2026-06/demo-alpha/CHECKLIST.md) | Deferred | 0/1 |", index)

    def test_milestone_split_slice_is_counted_and_indexed(self) -> None:
        repo = self.create_repo()
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
            "First Slice",
            "--strategic-significance",
            "Demo Alpha proves a strategically important project path.",
            "--acceptance",
            "Demo Alpha can complete its tracked stage.",
            "--write",
            "--json",
        )

        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "update-slice",
            "--slug",
            "demo-alpha",
            "--slice",
            "First Slice",
            "--status",
            "Split",
            "--write",
            "--json",
        )

        checklist = repo / "docs/milestones/2026-06/demo-alpha/CHECKLIST.md"
        text = checklist.read_text(encoding="utf-8")
        self.assertIn("- Status: Split", text)
        self.assertIn("- Deferred: 0", text)
        self.assertIn("- Split: 1", text)
        checked = self.run_json(MILESTONE_ASSETS, repo, "check", "--slug", "demo-alpha", "--json")
        self.assertEqual(checked["issues"], [])
        index = (repo / "docs/milestones/INDEX.md").read_text(encoding="utf-8")
        self.assertIn("| 2026-06 | [Demo Alpha](2026-06/demo-alpha/README.md) | [Checklist](2026-06/demo-alpha/CHECKLIST.md) | Split | 0/1 |", index)

    def test_milestone_check_missing_slug_returns_error(self) -> None:
        repo = self.create_repo()

        result = self.run_json_fail(MILESTONE_ASSETS, repo, "check", "--slug", "missing-alpha", "--json")

        self.assertEqual(result["issues"][0]["code"], "milestone_not_found")
        self.assertEqual(result["issues"][0]["severity"], "error")

    def test_milestone_create_rejects_duplicate_without_clobbering(self) -> None:
        repo = self.create_repo()
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
            "First Slice",
            "--acceptance",
            "Demo Alpha can complete the tracked stage.",
            "--write",
            "--json",
        )
        readme = repo / "docs/milestones/2026-06/demo-alpha/README.md"
        readme.write_text("original milestone sentinel\n", encoding="utf-8")

        result = self.run_json_fail(
            MILESTONE_ASSETS,
            repo,
            "create",
            "--month",
            "2026-06",
            "--slug",
            "demo-alpha",
            "--title",
            "Clobber Alpha",
            "--slice",
            "Replacement Slice",
            "--acceptance",
            "This duplicate must not overwrite existing files.",
            "--write",
            "--json",
        )

        self.assertEqual(result["issues"][0]["code"], "milestone_already_exists")
        self.assertEqual(readme.read_text(encoding="utf-8"), "original milestone sentinel\n")

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

    def test_archive_validator_rejects_missing_contract_sections(self) -> None:
        repo = self.create_repo()
        bad_archive = repo / "docs/superpowers/archives/2026-05/2026-05-02-bad-archive-archives.md"
        bad_archive.write_text("# Bad Archive\n\n- Date: `2026-05-02`\n", encoding="utf-8")
        result = self.run_json_fail(ARCHIVE_VALIDATOR, bad_archive, "--json")
        codes = {issue["code"] for issue in result["issues"]}
        self.assertIn("missing_metadata", codes)
        self.assertIn("missing_section", codes)

    def test_bootstrap_creates_standard_layout_and_agents_guidance(self) -> None:
        repo = self.temp_root / "bootstrap_repo"
        repo.mkdir()
        (repo / "AGENTS.md").write_text("# Repository Guidelines\n\nExisting rules.\n", encoding="utf-8")

        result = self.run_json(BOOTSTRAP, repo, "--write", "--json")

        self.assertTrue(result["changed"])
        self.assertEqual(result["created_dirs"], [
            "docs/superpowers",
            "docs/superpowers/specs",
            "docs/superpowers/plans",
            "docs/superpowers/archives",
            "docs/superpowers/problems",
            "docs/superpowers/inbox",
            "docs/milestones",
            "docs/technical-debt",
        ])
        agents_text = (repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("Existing rules.", agents_text)
        self.assertEqual(agents_text.count("<!-- asset-compounding-guidance:start -->"), 1)
        self.assertIn("docs/superpowers/inbox/", agents_text)
        self.assertIn("docs/milestones/", agents_text)
        self.assertIn("docs/technical-debt/", agents_text)
        self.assertIn("asset-compounding-guidance:version=0.3.1", agents_text)
        self.assertIn("Repository Context Guidance", agents_text)
        self.assertIn("Milestone Navigation", agents_text)
        self.assertIn("docs/milestones/INDEX.md", agents_text)
        self.assertIn("Technical Debt Navigation", agents_text)
        self.assertIn("docs/technical-debt/INDEX.md", agents_text)
        self.assertFalse((repo / "docs/milestones/INDEX.md").exists())
        self.assertFalse((repo / "docs/technical-debt/INDEX.md").exists())
        self.assertIn("hook-assisted asset compounding", agents_text)
        self.assertIn("rg -n", agents_text)
        self.assertIn("/hooks", agents_text)
        self.assertNotIn("### Routing Boundaries", agents_text)
        self.assertNotIn("### Completion Gates", agents_text)
        self.assertNotIn("### Problem Gate Output", agents_text)
        self.assertNotIn("--completed-topic", agents_text)

    def test_bootstrap_is_idempotent_after_initialization(self) -> None:
        repo = self.temp_root / "idempotent_bootstrap_repo"
        repo.mkdir()

        first = self.run_json(BOOTSTRAP, repo, "--write", "--json")
        second = self.run_json(BOOTSTRAP, repo, "--write", "--json")

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        agents_text = (repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertEqual(agents_text.count("<!-- asset-compounding-guidance:start -->"), 1)
        self.assertEqual(second["created_dirs"], [])

    def test_agent_guidance_refreshes_unversioned_block_and_preserves_project_guidance(self) -> None:
        repo = self.temp_root / "old_guidance_repo"
        repo.mkdir()
        (repo / "AGENTS.md").write_text(
            """# Repository Guidelines

## TypeScript 工程规则

- 使用 ESM。
- Node.js 目标版本为 20+。

## Milestone 导航

长期复刻路线和月度进度台账放在 `docs/milestones/`。

## 技术债导航

未解决技术债放在 `docs/technical-debt/`。

<!-- asset-compounding-guidance:start -->
## Asset Compounding Retrieval Guide

### Asset Directories

- Specs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`
- Archives: `docs/superpowers/archives/`
- Problems: `docs/superpowers/problems/`
- Inbox: `docs/superpowers/inbox/`
- Milestones: `docs/milestones/`
- Technical debt: `docs/technical-debt/`
<!-- asset-compounding-guidance:end -->
""",
            encoding="utf-8",
        )

        dry_run = self.run_json_fail(AGENT_GUIDANCE, repo, "--json")
        self.assertTrue(dry_run["needs_update"])
        self.assertTrue(dry_run["managed_block_stale"])
        self.assertIsNone(dry_run["managed_block_version"])
        self.assertIsNotNone(dry_run["expected_version"])
        self.assertTrue(dry_run["project_guidance_present"])
        self.assertTrue(dry_run["localized_guidance_present"])

        updated = self.run_json(AGENT_GUIDANCE, repo, "--write", "--json")

        self.assertTrue(updated["changed"])
        self.assertTrue(updated["managed_block_stale"])
        agents_text = (repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertEqual(agents_text.count("<!-- asset-compounding-guidance:start -->"), 1)
        self.assertIn("## TypeScript 工程规则", agents_text)
        self.assertIn("## Milestone 导航", agents_text)
        self.assertIn("## 技术债导航", agents_text)
        self.assertIn("asset-compounding-guidance:version=0.3.1", agents_text)
        self.assertIn("Repository Context Guidance", agents_text)
        self.assertIn("Milestone Navigation", agents_text)
        self.assertIn("docs/milestones/INDEX.md", agents_text)
        self.assertIn("Technical Debt Navigation", agents_text)
        self.assertIn("docs/technical-debt/INDEX.md", agents_text)

        second = self.run_json(AGENT_GUIDANCE, repo, "--json")
        self.assertFalse(second["needs_update"])
        self.assertFalse(second["managed_block_stale"])
        self.assertEqual(second["managed_block_version"], second["expected_version"])

    def test_completion_gate_detects_solution_folder_and_relayout_drift(self) -> None:
        repo = self.temp_root / "relayout_repo"
        (repo / "src/LightRAGNet.Core").mkdir(parents=True)
        (repo / "tests/LightRAGNet.Tests").mkdir(parents=True)
        (repo / "LightRAGNet.Core/bin").mkdir(parents=True)
        (repo / "src/LightRAGNet.Core/LightRAGNet.Core.csproj").write_text(
            "<Project Sdk=\"Microsoft.NET.Sdk\" />",
            encoding="utf-8",
        )
        (repo / "tests/LightRAGNet.Tests/LightRAGNet.Tests.csproj").write_text(
            "<Project Sdk=\"Microsoft.NET.Sdk\" />",
            encoding="utf-8",
        )
        (repo / "LightRAGNet.slnx").write_text(
            """<Solution>
  <Project Path="src\\LightRAGNet.Core\\LightRAGNet.Core.csproj" />
  <Project Path="tests\\LightRAGNet.Tests\\LightRAGNet.Tests.csproj" />
</Solution>
""",
            encoding="utf-8",
        )

        result = self.run_json(COMPLETION_GATE, repo, "--json")

        codes = {issue["code"] for issue in result["issues"]}
        self.assertEqual(result["status"], "needs_attention")
        self.assertIn("old_project_directory_after_relayout", codes)
        self.assertIn("missing_src_solution_folder", codes)
        self.assertIn("missing_tests_solution_folder", codes)

    def test_completion_gate_passes_when_solution_folders_match_structure(self) -> None:
        repo = self.temp_root / "clean_relayout_repo"
        (repo / "src/LightRAGNet.Core").mkdir(parents=True)
        (repo / "tests/LightRAGNet.Tests").mkdir(parents=True)
        (repo / "src/LightRAGNet.Core/LightRAGNet.Core.csproj").write_text(
            "<Project Sdk=\"Microsoft.NET.Sdk\" />",
            encoding="utf-8",
        )
        (repo / "tests/LightRAGNet.Tests/LightRAGNet.Tests.csproj").write_text(
            "<Project Sdk=\"Microsoft.NET.Sdk\" />",
            encoding="utf-8",
        )
        (repo / "LightRAGNet.slnx").write_text(
            """<Solution>
  <Folder Name="/src/">
    <Project Path="src\\LightRAGNet.Core\\LightRAGNet.Core.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests\\LightRAGNet.Tests\\LightRAGNet.Tests.csproj" />
  </Folder>
</Solution>
""",
            encoding="utf-8",
        )

        result = self.run_json(COMPLETION_GATE, repo, "--json")

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])

    def test_completion_gate_warns_on_unarchived_spec_plan_without_topic(self) -> None:
        repo = self.create_repo()

        result = self.run_json(COMPLETION_GATE, repo, "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "possible_missing_requirement_archive")

    def test_completion_gate_preserves_debt_suffix_in_archive_warning(self) -> None:
        repo = self.create_debt_named_repo()

        result = self.run_json(COMPLETION_GATE, repo, "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "possible_missing_requirement_archive")
        self.assertIn("asset-compounding-v0.3.0-milestones-and-debt", result["issues"][0]["message"])

    def test_completion_gate_completed_topic_without_debt_does_not_match_debt_topic(self) -> None:
        repo = self.create_debt_named_repo()

        result = self.run_json_fail(
            COMPLETION_GATE,
            repo,
            "--completed-topic",
            "asset-compounding-v0.3.0-milestones-and",
            "--json",
        )

        self.assertEqual(result["issues"][0]["code"], "completed_topic_not_found")

    def test_completion_gate_archive_topic_normalization_keeps_legacy_suffix_stripping(self) -> None:
        repo = self.create_repo()

        result = self.run_json_fail(
            COMPLETION_GATE,
            repo,
            "--completed-topic",
            "2026-05-01-demo-feature-implementation-plan.md",
            "--json",
        )

        self.assertEqual(result["issues"][0]["code"], "missing_requirement_archive")
        self.assertEqual(result["checks"]["completed_topics"], ["demo-feature"])

    def test_completion_gate_domain_checks_are_importable(self) -> None:
        scripts_root = SKILLS / "compound-development-asset" / "scripts"
        script_path = str(scripts_root)
        relatives = (
            "checks/archive_checks.py",
            "checks/handoff_checks.py",
            "checks/repo_structure_checks.py",
        )
        sys.path.insert(0, script_path)
        try:
            for relative in relatives:
                spec = importlib.util.spec_from_file_location(relative.replace("/", "_"), scripts_root / relative)
                self.assertIsNotNone(spec)
                module = importlib.util.module_from_spec(spec)
                assert spec and spec.loader
                spec.loader.exec_module(module)
        finally:
            sys.path.remove(script_path)

        repo = self.create_repo()
        result = self.run_json_fail(COMPLETION_GATE, repo, "--completed-topic", "demo-feature", "--json")
        self.assertEqual(result["issues"][0]["code"], "missing_requirement_archive")

    def test_completion_gate_blocks_completed_topic_without_archive(self) -> None:
        repo = self.create_repo()

        result = self.run_json_fail(COMPLETION_GATE, repo, "--completed-topic", "demo feature", "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "missing_requirement_archive")

    def test_completion_gate_accepts_completed_topic_with_archive(self) -> None:
        repo = self.create_repo()
        self.add_archive(repo)

        result = self.run_json(COMPLETION_GATE, repo, "--completed-topic", "demo-feature", "--json")

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["checks"]["completed_topics"], ["demo-feature"])

    def test_asset_status_reports_archived_topic_and_related_problem(self) -> None:
        repo = self.create_repo()
        archive = self.add_archive(repo)
        problem = self.add_problem(repo)

        result = self.run_json(ASSET_STATUS, repo, "--topic", "demo-feature", "--json")

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["requirement_archive"]["status"], "found")
        self.assertEqual(result["requirement_archive"]["path"], archive.relative_to(repo).as_posix())
        self.assertEqual(result["problem_assets"][0]["path"], problem.relative_to(repo).as_posix())
        self.assertEqual(result["inbox_assets"], [])
        self.assertEqual(result["indexes"]["status"], "pass")
        self.assertEqual(result["completion_gate"]["status"], "pass")

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

    def test_asset_closeout_ignores_unrelated_milestone_progress_mismatch(self) -> None:
        repo = self.create_repo()
        archive = self.add_archive(repo)
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
            "--strategic-significance",
            "Demo Alpha proves a strategically important project path.",
            "--acceptance",
            "Demo Alpha can complete tracked stages.",
            "--write",
            "--json",
        )
        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "update-slice",
            "--slug",
            "demo-alpha",
            "--slice",
            "Demo Feature",
            "--status",
            "Done",
            "--spec",
            "../../../superpowers/specs/2026-05-01-demo-feature-design.md",
            "--plan",
            "../../../superpowers/plans/2026-05-01-demo-feature.md",
            "--archive",
            str(archive.relative_to(repo).as_posix()),
            "--completion-signal",
            "Demo feature archive exists.",
            "--write",
            "--json",
        )
        self.run_json(
            MILESTONE_ASSETS,
            repo,
            "create",
            "--month",
            "2026-06",
            "--slug",
            "unrelated-beta",
            "--title",
            "Unrelated Beta",
            "--slice",
            "Unrelated Slice",
            "--strategic-significance",
            "Unrelated Beta tracks a separate project path.",
            "--acceptance",
            "Unrelated Beta can complete tracked stages.",
            "--write",
            "--json",
        )
        unrelated_checklist = repo / "docs/milestones/2026-06/unrelated-beta/CHECKLIST.md"
        unrelated_text = unrelated_checklist.read_text(encoding="utf-8")
        unrelated_checklist.write_text(unrelated_text.replace("- Progress: 0/1", "- Progress: 1/1"), encoding="utf-8")

        closeout = self.run_json(ASSET_CLOSEOUT, repo, "--topic", "demo-feature", "--json")

        self.assertEqual(closeout["route"], "none")
        self.assertNotIn("update milestone progress", closeout["required_actions"])
        self.assertEqual(len(closeout["related_assets"]["milestones"]), 1)
        self.assertEqual(closeout["related_assets"]["milestones"][0], "docs/milestones/2026-06/demo-alpha/README.md")

    def test_asset_status_treats_inbox_only_topic_as_not_requiring_archive(self) -> None:
        repo = self.create_repo()
        inbox_root = repo / "docs/superpowers/inbox/2026-06"
        inbox_root.mkdir(parents=True, exist_ok=True)
        inbox = inbox_root / "2026-06-06-ros-2-wsl-python-environment-inbox.md"
        inbox.write_text(
            """# ROS 2 WSL Python Environment Inbox

- Date: `2026-06-06`
- Topic slug: `ros-2-wsl-python-environment`
- Lifecycle: `Open`
- Route candidate: `unknown`
- Revisit trigger: `WSL Python path evidence becomes stable.`

## Signal

ROS 2 WSL Python environment is an uncertain inbox signal, not a completed requirement.
""",
            encoding="utf-8",
        )
        (repo / "docs/superpowers/inbox/INDEX.md").write_text(
            "# Inbox\n\n## 2026-06\n\n"
            "- [2026-06-06-ros-2-wsl-python-environment-inbox.md](./2026-06/2026-06-06-ros-2-wsl-python-environment-inbox.md): ROS 2 WSL Python environment signal.\n",
            encoding="utf-8",
        )

        result = self.run_json(ASSET_STATUS, repo, "--topic", "ROS 2 WSL Python environment", "--json")

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["requirement_archive"]["status"], "not_required")
        self.assertEqual(result["completion_gate"]["status"], "not_required")
        self.assertEqual(result["inbox_assets"][0]["path"], inbox.relative_to(repo).as_posix())

    def test_asset_status_still_requires_archive_when_spec_plan_match_inbox_topic(self) -> None:
        repo = self.create_repo()
        inbox_root = repo / "docs/superpowers/inbox/2026-06"
        inbox_root.mkdir(parents=True, exist_ok=True)
        (inbox_root / "2026-06-06-demo-feature-inbox.md").write_text(
            """# Demo Feature Inbox

- Date: `2026-06-06`
- Topic slug: `demo-feature`
- Lifecycle: `Open`
- Route candidate: `archive`
- Revisit trigger: `Demo feature closes without archive.`

## Signal

Demo feature has inbox context, but the spec and plan still need requirement archive coverage.
""",
            encoding="utf-8",
        )
        (repo / "docs/superpowers/inbox/INDEX.md").write_text(
            "# Inbox\n\n## 2026-06\n\n"
            "- [2026-06-06-demo-feature-inbox.md](./2026-06/2026-06-06-demo-feature-inbox.md): Demo feature archive signal.\n",
            encoding="utf-8",
        )

        result = self.run_json_fail(ASSET_STATUS, repo, "--topic", "demo feature", "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["requirement_archive"]["status"], "missing")
        self.assertEqual(result["completion_gate"]["issues"][0]["code"], "missing_requirement_archive")

    def test_asset_closeout_blocks_completed_topic_without_archive(self) -> None:
        repo = self.create_repo()

        result = self.run_json_fail(ASSET_CLOSEOUT, repo, "--topic", "demo-feature", "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["route"], "archive")
        self.assertEqual(result["missing"], ["requirement_archive"])
        self.assertIn("write archive for topic demo-feature", result["required_actions"])
        self.assertEqual(result["handoff_block"]["gate"], "fail")

    def test_completion_gate_blocks_unknown_completed_topic(self) -> None:
        repo = self.create_repo()

        result = self.run_json_fail(COMPLETION_GATE, repo, "--completed-topic", "unknown feature", "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "completed_topic_not_found")

    def test_completion_gate_requires_asset_gate_when_requested(self) -> None:
        repo = self.temp_root / "handoff_repo"
        repo.mkdir()

        result = self.run_json_fail(COMPLETION_GATE, repo, "--require-asset-gate", "--handoff-text", "done", "--json")

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "missing_asset_gate_output")

    def test_completion_gate_blocks_incomplete_asset_gate_as_error(self) -> None:
        repo = self.temp_root / "incomplete_gate_repo"
        repo.mkdir()

        result = self.run_json_fail(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            "asset_gate:\n  route: none\nreason: too short",
            "--json",
        )

        codes = {issue["code"] for issue in result["issues"]}
        self.assertIn("invalid_asset_gate_output", codes)
        messages = "\n".join(issue["message"] for issue in result["issues"])
        self.assertIn("event_type", messages)
        self.assertIn("evidence", messages)
        self.assertIn("asset_candidates", messages)

    def test_completion_gate_blocks_unknown_asset_gate_route(self) -> None:
        repo = self.temp_root / "bad_route_gate_repo"
        repo.mkdir()

        result = self.run_json_fail(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            (
                "asset_gate:\n"
                "  event_type: implementation-boundary\n"
                "  route: skip\n"
                "reason: tested\n"
                "evidence: unit tests\n"
                "related_assets: none\n"
                "asset_candidates: none\n"
                "deferred_signals: none\n"
                "next_step: none"
            ),
            "--json",
        )

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "invalid_asset_gate_output")
        self.assertIn("route", result["issues"][0]["message"])
        self.assertIn("skip", result["issues"][0]["message"])

    def test_completion_gate_accepts_structured_asset_gate(self) -> None:
        repo = self.temp_root / "valid_gate_repo"
        repo.mkdir()

        result = self.run_json(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            (
                "asset_gate:\n"
                "  event_type: implementation-boundary\n"
                "  route: none\n"
                "reason: no reusable signal\n"
                "evidence: focused unit tests passed\n"
                "related_assets: none\n"
                "asset_candidates: none\n"
                "deferred_signals: none\n"
                "next_step: none"
            ),
            "--json",
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])

    def test_completion_gate_accepts_yaml_asset_gate_lists(self) -> None:
        repo = self.temp_root / "yaml_gate_repo"
        repo.mkdir()

        result = self.run_json(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            (
                "```yaml\n"
                "asset_gate:\n"
                "  event_type: artifact-generation\n"
                "  route: none\n"
                "  reason: Generated an external Visio artifact without repo changes.\n"
                "  evidence:\n"
                "    - strict scene validation passed\n"
                "    - exported c01_method_flow.vsdx\n"
                "  related_assets: []\n"
                "  asset_candidates: []\n"
                "  deferred_signals: []\n"
                "  next_step: none\n"
                "```"
            ),
            "--json",
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])

    def test_completion_gate_normalizes_asset_gate_aliases(self) -> None:
        repo = self.temp_root / "alias_gate_repo"
        repo.mkdir()

        result = self.run_json(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            (
                "asset_gate:\n"
                "  event_type: artifact_generation\n"
                "  route: none\n"
                "  reason: Generated external artifact.\n"
                "  evidence: exported file\n"
                "  related_assets: none\n"
                "  asset_candidates: none\n"
                "  deferred_signals: none\n"
                "  next_step: none"
            ),
            "--json",
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])

    def test_emit_asset_gate_outputs_valid_canonical_block(self) -> None:
        repo = self.temp_root / "emit_gate_repo"
        repo.mkdir()

        emitted = subprocess.run(
            [
                sys.executable,
                str(EMIT_ASSET_GATE),
                "--event-type",
                "artifact-generation",
                "--route",
                "none",
                "--reason",
                "Generated external Visio artifact.",
                "--evidence",
                "strict validation passed",
                "--evidence",
                "exported vsdx",
                "--related-assets",
                "none",
                "--asset-candidates",
                "none",
                "--deferred-signals",
                "none",
                "--next-step",
                "none",
            ],
            text=True,
            capture_output=True,
            check=True,
        )

        self.assertIn("asset_gate:", emitted.stdout)
        self.assertIn("event_type: artifact-generation", emitted.stdout)
        result = self.run_json(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            emitted.stdout,
            "--json",
        )
        self.assertEqual(result["status"], "pass")

    def test_completion_gate_accepts_asset_candidates_and_asset_gate(self) -> None:
        repo = self.temp_root / "candidate_repo"
        repo.mkdir()

        result = self.run_json(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--require-asset-candidates",
            "--handoff-text",
            (
                "asset_gate:\n"
                "  event_type: implementation-boundary\n"
                "  route: none\n"
                "reason: tested\n"
                "evidence: unit tests\n"
                "related_assets: none\n"
                "asset_candidates: subagent reported no reusable issue\n"
                "deferred_signals: none\n"
                "next_step: none"
            ),
            "--asset-candidate",
            "subagent reported no reusable issue",
            "--json",
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["asset_candidates"], ["subagent reported no reusable issue"])

    def test_hook_config_registers_lifecycle_events_without_user_prompt_submit(self) -> None:
        config = json.loads(HOOKS_CONFIG.read_text(encoding="utf-8"))
        hooks = config["hooks"]

        for event_name in (
            "SessionStart",
            "PostToolUse",
            "Stop",
            "PreCompact",
            "PostCompact",
        ):
            self.assertIn(event_name, hooks)
            command = hooks[event_name][0]["hooks"][0]["command"]
            self.assertIn("run_asset_hook.cmd", command)

        self.assertNotIn("UserPromptSubmit", hooks)
        self.assertNotIn("SubagentStart", hooks)
        self.assertNotIn("SubagentStop", hooks)
        self.assertIn("functions.update_plan", hooks["PostToolUse"][0]["matcher"])

    def test_hook_config_uses_launcher_instead_of_naked_interpreter(self) -> None:
        config = json.loads(HOOKS_CONFIG.read_text(encoding="utf-8"))
        forbidden = r'(^|[;&|]\s*)(python|python\.exe|py|bash|node|npm)\b'

        self.assertTrue(HOOK_LAUNCHER.is_file())
        self.assertTrue(HOOK_BASH_LAUNCHER.is_file())
        for registrations in config["hooks"].values():
            command = registrations[0]["hooks"][0]["command"]
            self.assertIn("run_asset_hook.cmd", command)
            self.assertNotRegex(command, forbidden)

    def test_hook_state_directory_includes_project_name_and_session_id(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "git status --short"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        self.assertTrue((plugin_data / "repo--session-1" / "state.json").is_file())
        self.assertTrue((plugin_data / "repo--session-1" / "events.jsonl").is_file())

    def test_session_start_injects_context_only_for_asset_repo(self) -> None:
        repo = self.create_repo()

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "SessionStart",
                "session_id": "session-1",
                "cwd": str(repo),
                "source": "startup",
            }
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("hook-assisted asset compounding", context)
        self.assertIn("asset_gate", context)

        no_asset_repo = self.temp_root / "plain_repo"
        no_asset_repo.mkdir()
        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "SessionStart",
                "session_id": "session-1",
                "cwd": str(no_asset_repo),
                "source": "startup",
            }
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

    def test_hook_accepts_utf8_bom_input(self) -> None:
        repo = self.create_repo()
        payload = json.dumps(
            {
                "hook_event_name": "SessionStart",
                "session_id": "session-1",
                "cwd": str(repo),
                "source": "startup",
            }
        ).encode("utf-8")

        code, stdout, stderr = self.run_hook_raw(b"\xef\xbb\xbf" + payload)

        self.assertEqual(code, 0, stderr)
        self.assertIn("asset_gate", json.loads(stdout)["hookSpecificOutput"]["additionalContext"])

    def test_hook_times_out_when_stdin_never_closes(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PLUGIN_ROOT"] = str(ROOT)
        env["PLUGIN_DATA"] = str(plugin_data)
        env["ASSET_HOOK_STDIN_TIMEOUT_MS"] = "100"
        process = subprocess.Popen(
            ["python", str(HOOK_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.assertIsNotNone(process.stdin)
        process.stdin.write(b"{")
        process.stdin.flush()

        return_code = process.wait(timeout=3)
        try:
            process.stdin.close()
        except OSError:
            pass
        stdout = process.stdout.read().decode("utf-8", errors="replace") if process.stdout else ""
        stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()

        self.assertEqual(return_code, 1, stdout)
        self.assertEqual(stdout, "")
        self.assertIn("stdin read timed out", stderr)
        events = [
            json.loads(line)
            for line in (plugin_data / "_hook" / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["hookEventName"], "HookInput")
        self.assertEqual(events[-1]["reasonCode"], "stdin_timeout")
        self.assertEqual(events[-1]["timeoutMs"], 100)

    def test_subagent_lifecycle_events_are_noops_when_called_directly(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        for event in (
            {
                "hook_event_name": "SubagentStart",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "agent_id": "agent-1",
                "agent_type": "reviewer",
            },
            {
                "hook_event_name": "SubagentStop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "agent_id": "agent-1",
                "agent_type": "reviewer",
                "last_assistant_message": "asset_candidates:\n  - transient dotnet test DLL lock",
            },
        ):
            code, stdout, stderr = self.run_hook(event, plugin_data=plugin_data)

            self.assertEqual(code, 0, stderr)
            self.assertEqual(stdout, "")

        self.assertFalse((self.audit_dir(plugin_data, repo) / "state.json").exists())
        self.assertFalse((self.audit_dir(plugin_data, repo) / "events.jsonl").exists())

    def test_post_tool_use_update_plan_marks_plan_boundary_without_prompting(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "functions.update_plan",
                "tool_input": {
                    "plan": [
                        {"step": "Implement hook change", "status": "completed"},
                        {"step": "Run validation", "status": "in_progress"},
                    ]
                },
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], ["plan-boundary"])

        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["hookEventName"], "PostToolUse")
        self.assertEqual(events[-1]["commandKind"], "plan-update")
        self.assertEqual(events[-1]["signalsAdded"], ["plan-boundary"])

    def test_post_tool_use_update_plan_reminds_before_next_task_when_gate_due(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "update_plan",
                "tool_input": {
                    "plan": [
                        {"step": "Implement hook change", "status": "completed"},
                        {"step": "Run validation", "status": "pending"},
                    ]
                },
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(state["assetGateDue"])

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-2",
                "cwd": str(repo),
                "tool_name": "update_plan",
                "tool_input": {
                    "plan": [
                        {"step": "Implement hook change", "status": "completed"},
                        {"step": "Run validation", "status": "in_progress"},
                    ]
                },
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertIn("systemMessage", payload)
        self.assertIn("asset", payload["systemMessage"])
        self.assertIn("before starting the next planned task", payload["systemMessage"].lower())

    def test_stop_allows_plan_boundary_only_without_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "update_plan",
                "tool_input": {
                    "plan": [
                        {"step": "Explore context", "status": "completed"},
                        {"step": "Ask clarifying question", "status": "in_progress"},
                    ]
                },
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "设计阶段确认了一小段，等待用户继续。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(state["assetGateDue"])
        self.assertEqual(state["meaningfulWorkSignals"], ["plan-boundary"])

    def test_stop_with_asset_gate_clears_asset_gate_due(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "update_plan",
                "tool_input": {"plan": [{"step": "Implement hook change", "status": "completed"}]},
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": (
                    "asset_gate:\n"
                    "  event_type: cleanup-only\n"
                    "  route: none\n"
                    "  reason: cleanup-only\n"
                    "  evidence: tool output\n"
                    "  related_assets: none\n"
                    "  asset_candidates: none\n"
                    "  deferred_signals: none\n"
                    "  next_step: none"
                ),
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertFalse(state["assetGateDue"])

    def test_stop_blocks_invalid_asset_gate_without_clearing_state(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet test .\\LightRAGNet.slnx"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "asset_gate:\n  route: none\nreason: missing fields",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("invalid asset_gate", payload["reason"])
        self.assertIn("asset_gate:", payload["reason"])
        self.assertIn("event_type: implementation-boundary", payload["reason"])
        self.assertIn("evidence: <", payload["reason"])
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["reasonCode"], "invalid_asset_gate")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertIn("verification-ran", state["meaningfulWorkSignals"])

    def test_stop_invalid_asset_gate_audit_event_omits_free_form_field_values(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        fake_secret = "FAKE-SECRET-12345"
        raw_invalid_event_type = f"event_type={fake_secret}"
        raw_invalid_route = f"route={fake_secret}"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": (
                    "asset_gate:\n"
                    f"  event_type: {fake_secret}\n"
                    f"  route: {fake_secret}\n"
                    f"  reason: leaked {fake_secret}\n"
                    f"  evidence: copied {fake_secret}\n"
                    "  related_assets: none\n"
                    "  asset_candidates: none\n"
                    "  deferred_signals: none\n"
                    "  next_step: none\n"
                ),
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(payload["decision"], "block")
        events_text = (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8")
        self.assertNotIn(fake_secret, events_text)
        self.assertNotIn(raw_invalid_event_type, events_text)
        self.assertNotIn(raw_invalid_route, events_text)
        self.assertNotIn("leaked", events_text)
        self.assertNotIn("copied", events_text)
        events = [json.loads(line) for line in events_text.splitlines()]
        validation = events[-1]["validation"]
        self.assertEqual(validation["code"], "invalid_asset_gate_output")
        self.assertEqual(validation["missing"], [])
        self.assertEqual(validation["invalid"], ["event_type", "route"])
        self.assertNotIn("fields", validation)

    def test_stop_allows_merge_only_closeout_without_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "git merge --no-ff feature/demo"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "已 merge 回 main，仅同步分支历史。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["reasonCode"], "merge_only_closeout")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], [])

    def test_stop_requires_asset_gate_when_merge_follows_verification(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        for command in ("dotnet test .\\LightRAGNet.slnx", "git merge --no-ff feature/demo"):
            self.run_hook(
                {
                    "hook_event_name": "PostToolUse",
                    "session_id": "session-1",
                    "turn_id": "turn-1",
                    "cwd": str(repo),
                    "tool_name": "Bash",
                    "tool_input": {"command": command},
                    "tool_response": {"exit_code": 0},
                },
                plugin_data=plugin_data,
            )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "验证后已 merge。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout)["decision"], "block")

    def test_post_tool_use_marks_meaningful_work_and_stop_requires_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet test .\\LightRAGNet.slnx --verbosity minimal"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "实现完成，测试通过。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("asset_gate", payload["reason"])

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "stop_hook_active": True,
                "last_assistant_message": "实现完成，测试通过。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertIn("systemMessage", json.loads(stdout))

    def test_stop_with_asset_gate_clears_closeout_signals_for_later_turns(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet test .\\LightRAGNet.slnx"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": (
                    "asset_gate:\n"
                    "  event_type: cleanup-only\n"
                    "  route: none\n"
                    "  reason: cleanup-only\n"
                    "  evidence: tool output\n"
                    "  related_assets: none\n"
                    "  asset_candidates: none\n"
                    "  deferred_signals: none\n"
                    "  next_step: none"
                ),
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-2",
                "cwd": str(repo),
                "last_assistant_message": "Just answered a read-only question.",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], [])
        self.assertEqual(state["verificationEvidence"], [])

    def test_stop_allows_push_only_closeout_without_reprompting_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "git push origin main"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "已 push，main 和 origin/main 已同步。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["reasonCode"], "push_only_closeout")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], [])

    def test_stop_allows_cleanup_only_abandonment_without_reprompting_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "apply_patch",
                "tool_input": {
                    "patch": "*** Begin Patch\n*** Delete File: docs/superpowers/specs/old-feature.md\n*** End Patch"
                },
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "已清理并删除废弃需求，放弃这个插件方向。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["reasonCode"], "cleanup_only_auto_none")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], [])
        self.assertFalse(state["assetFilesChanged"])

    def test_session_start_context_mentions_worktree_workspace(self) -> None:
        repo = self.temp_root / ".worktrees" / "feature-demo"
        for area in ("specs", "plans", "archives", "problems"):
            (repo / "docs" / "superpowers" / area).mkdir(parents=True, exist_ok=True)
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "SessionStart",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("feature-demo", context)
        self.assertIn("worktree", context.lower())

    def test_post_tool_use_records_failed_verification_separately(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet test .\\LightRAGNet.slnx"},
                "tool_response": {"exit_code": 1},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], ["verification-failed"])
        self.assertEqual(state["verificationEvidence"][0]["status"], "failed")
        self.assertEqual(state["verificationEvidence"][0]["exitCode"], 1)

    def test_post_tool_use_does_not_count_dotnet_build_version_as_verification(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet build --version"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], [])
        self.assertEqual(state["verificationEvidence"], [])

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "Read dotnet build version.",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

    def test_post_tool_use_readonly_docs_search_does_not_mark_asset_files_changed(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "rg -n asset_gate docs/superpowers"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        self.assertFalse((repo / "AGENTS.md").exists())
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertFalse(state["assetFilesChanged"])
        self.assertEqual(state["meaningfulWorkSignals"], [])

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "Read-only asset search complete.",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

    def test_post_tool_use_bootstraps_guidance_when_first_asset_is_written(self) -> None:
        repo = self.temp_root / "first_asset_repo"
        (repo / "docs/superpowers/specs").mkdir(parents=True)
        (repo / "docs/superpowers/specs/2026-06-01-demo-design.md").write_text(
            "# Demo Design\n",
            encoding="utf-8",
        )
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "apply_patch",
                "tool_input": {
                    "patch": "*** Begin Patch\n*** Add File: docs/superpowers/plans/2026-06-01-demo.md\n+# Demo Plan\n*** End Patch"
                },
                "tool_response": {},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        agents_text = (repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("<!-- asset-compounding-guidance:start -->", agents_text)
        self.assertIn("docs/superpowers/inbox/", agents_text)
        self.assertTrue((repo / "docs/superpowers/problems").is_dir())
        self.assertTrue((repo / "docs/superpowers/inbox").is_dir())

        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(state["assetFilesChanged"])
        self.assertEqual(state["assetBootstrap"]["action"], "written")
        self.assertIn("docs/superpowers/problems", state["assetBootstrap"]["createdDirs"])

    def test_post_tool_use_refreshes_guidance_when_project_asset_is_written(self) -> None:
        repo = self.temp_root / "project_asset_repo"
        (repo / "docs/milestones/2026-06/demo").mkdir(parents=True)
        (repo / "AGENTS.md").write_text(
            """# Repository Guidelines

Existing project context.

<!-- asset-compounding-guidance:start -->
## Asset Compounding Retrieval Guide

Old managed block.
<!-- asset-compounding-guidance:end -->
""",
            encoding="utf-8",
        )
        plugin_data = self.temp_root / "plugin-data"

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "apply_patch",
                "tool_input": {
                    "patch": "*** Begin Patch\n*** Add File: docs/milestones/2026-06/demo/CHECKLIST.md\n+# Demo Checklist\n*** End Patch"
                },
                "tool_response": {},
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        agents_text = (repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("Existing project context.", agents_text)
        self.assertIn("asset-compounding-guidance:version=0.3.1", agents_text)
        self.assertTrue((repo / "docs/superpowers").is_dir())

        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(state["assetFilesChanged"])
        self.assertEqual(state["assetBootstrap"]["action"], "written")

    def test_stop_allows_messages_that_already_include_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "apply_patch",
                "tool_input": {"command": "*** Begin Patch\n*** End Patch"},
                "tool_response": {},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": (
                    "asset_gate:\n"
                    "  event_type: cleanup-only\n"
                    "  route: none\n"
                    "  reason: cleanup-only\n"
                    "  evidence: tool output\n"
                    "  related_assets: none\n"
                    "  asset_candidates: none\n"
                    "  deferred_signals: none\n"
                    "  next_step: none"
                ),
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")

    def test_post_compact_records_pending_state_without_stdout(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "functions.update_plan",
                "tool_input": {"plan": [{"step": "Review completed work", "status": "completed"}]},
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "PostCompact",
                "session_id": "session-1",
                "turn_id": "turn-2",
                "cwd": str(repo),
                "trigger": "auto",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        post_compact_event = events[-1]
        self.assertEqual(post_compact_event["hookEventName"], "PostCompact")
        self.assertEqual(post_compact_event["decision"], "recorded")
        self.assertEqual(post_compact_event["reasonCode"], "pending_state_restored")
        self.assertEqual(post_compact_event["candidateCount"], 0)
        self.assertEqual(post_compact_event["signals"], ["plan-boundary"])

    def test_hook_writes_sanitized_usage_events(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"

        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "functions.exec_command",
                "tool_input": {"cmd": "dotnet test .\\LightRAGNet.slnx --verbosity minimal"},
                "tool_response": {"exit_code": 1},
            },
            plugin_data=plugin_data,
        )
        self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "Verification failed.",
            },
            plugin_data=plugin_data,
        )

        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]

        self.assertGreaterEqual(len(events), 2)
        post_tool_event = events[0]
        stop_event = events[1]
        self.assertEqual(post_tool_event["hookEventName"], "PostToolUse")
        self.assertEqual(post_tool_event["commandKind"], "dotnet-test")
        self.assertTrue(post_tool_event["commandPresent"])
        self.assertGreater(post_tool_event["commandLength"], 0)
        self.assertIn("commandHash", post_tool_event)
        self.assertIn("durationMs", post_tool_event)
        self.assertIn("processId", post_tool_event)
        self.assertEqual(post_tool_event["exitCode"], 1)
        self.assertEqual(post_tool_event["verificationStatus"], "failed")
        self.assertEqual(post_tool_event["signalsAdded"], ["verification-failed"])
        self.assertEqual(post_tool_event["signals"], ["verification-failed"])
        self.assertFalse(post_tool_event["assetFilesChangedThisTool"])
        self.assertNotIn("command", post_tool_event)
        self.assertNotIn("cwd", post_tool_event)
        self.assertEqual(stop_event["hookEventName"], "Stop")
        self.assertEqual(stop_event["decision"], "block")
        self.assertEqual(stop_event["reasonCode"], "missing_asset_gate")
        self.assertTrue(stop_event["hasMeaningfulWork"])

    def test_hook_report_summarizes_usage_events(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet test .\\LightRAGNet.slnx"},
                "tool_response": {"exit_code": 1},
            },
            plugin_data=plugin_data,
        )
        self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "Verification failed.",
            },
            plugin_data=plugin_data,
        )
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "functions.update_plan",
                "tool_input": {"plan": [{"step": "Review failed verification", "status": "in_progress"}]},
                "tool_response": {"ok": True},
            },
            plugin_data=plugin_data,
        )

        report = self.run_json(HOOK_REPORT, plugin_data, "--json")

        self.assertEqual(report["total_events"], 3)
        self.assertEqual(report["stop_blocks"], 1)
        self.assertEqual(report["verification_failed_detected"], 1)
        self.assertEqual(report["subagent_candidates_collected"], 0)
        self.assertEqual(report["command_kinds"]["dotnet-test"], 1)
        self.assertEqual(report["command_kinds"]["plan-update"], 1)
        self.assertEqual(report["unknown_command_kind_ratio"], 0.0)
        self.assertEqual(report["hook_duration_ms"]["count"], 3)
        self.assertGreaterEqual(report["hook_duration_ms"]["max"], 0)
        self.assertEqual(len(report["slow_events"]), 3)

    def test_hook_report_clusters_unknown_commands_without_raw_command_text(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session_dir = plugin_data / "session-unknown"
        session_dir.mkdir(parents=True)
        events_path = session_dir / "events.jsonl"
        events = [
            {
                "hookEventName": "PostToolUse",
                "decision": "recorded",
                "reasonCode": "tool_observed",
                "toolName": "Bash",
                "commandKind": "unknown",
                "commandHash": "abc123",
                "commandLength": 42,
                "commandPresent": True,
                "repoName": "CodexPlugin",
                "durationMs": 4,
                "command": "this raw command must not be reported",
            },
            {
                "hookEventName": "PostToolUse",
                "decision": "recorded",
                "reasonCode": "tool_observed",
                "toolName": "Bash",
                "commandKind": "unknown",
                "commandHash": "abc123",
                "commandLength": 42,
                "commandPresent": True,
                "repoName": "CodexPlugin",
                "durationMs": 5,
            },
            {
                "hookEventName": "PostToolUse",
                "decision": "recorded",
                "reasonCode": "tool_observed",
                "toolName": "apply_patch",
                "commandKind": "unknown",
                "commandPresent": False,
                "repoName": "CodexPlugin",
                "durationMs": 2,
            },
        ]
        events_path.write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in events)
            + "\n{broken json\n",
            encoding="utf-8",
        )

        report = self.run_json(HOOK_REPORT, plugin_data, "--json")

        self.assertEqual(report["invalid_json_lines"], 1)
        self.assertEqual(report["invalid_json_files"], 1)
        self.assertEqual(report["unknown_command_tools"]["Bash"], 2)
        self.assertEqual(report["unknown_command_tools"]["apply_patch"], 1)
        self.assertEqual(report["unknown_command_repos"]["CodexPlugin"], 3)
        self.assertEqual(report["unknown_command_clusters"][0]["count"], 2)
        self.assertEqual(report["unknown_command_clusters"][0]["commandHash"], "abc123")
        self.assertEqual(report["unknown_command_clusters"][0]["commandLength"], 42)
        self.assertEqual(report["unknown_command_clusters"][0]["toolName"], "Bash")
        self.assertEqual(report["unknown_command_clusters"][0]["repoName"], "CodexPlugin")
        self.assertNotIn("command", report["unknown_command_clusters"][0])

    def test_hook_report_filters_events_and_summarizes_sessions(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session_a = plugin_data / "RepoA--session-a"
        session_b = plugin_data / "RepoB--session-b"
        session_a.mkdir(parents=True)
        session_b.mkdir(parents=True)
        session_a.joinpath("events.jsonl").write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "timestampUtc": "2026-06-10T00:00:00Z",
                            "hookEventName": "PostToolUse",
                            "decision": "recorded",
                            "reasonCode": "tool_observed",
                            "repoName": "RepoA",
                            "signals": ["edited-files"],
                            "signalsAdded": ["edited-files"],
                            "assetGateDue": True,
                            "commandKind": "file-edit",
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "timestampUtc": "2026-06-10T00:01:00Z",
                            "hookEventName": "Stop",
                            "decision": "block",
                            "reasonCode": "missing_asset_gate",
                            "repoName": "RepoA",
                            "signals": ["edited-files"],
                        },
                        ensure_ascii=False,
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        session_b.joinpath("events.jsonl").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-11T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "no_meaningful_work",
                    "repoName": "RepoB",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json(
            HOOK_REPORT,
            plugin_data,
            "--since",
            "2026-06-10",
            "--until",
            "2026-06-10",
            "--repo",
            "RepoA",
            "--reason",
            "missing_asset_gate",
            "--json",
        )

        self.assertEqual(result["filters"]["since"], "2026-06-10")
        self.assertEqual(result["filters"]["until"], "2026-06-10")
        self.assertEqual(result["filters"]["repo"], "RepoA")
        self.assertEqual(result["filters"]["reason"], "missing_asset_gate")
        self.assertEqual(result["total_events"], 1)
        self.assertEqual(result["stop_blocks_by_reason"], {"missing_asset_gate": 1})
        self.assertEqual(result["stop_block_sessions"][0]["session"], "RepoA--session-a")
        self.assertEqual(result["stop_block_sessions"][0]["finalSignals"], ["edited-files"])
        self.assertEqual(result["sessions_with_gate_due"], 1)
        self.assertEqual(result["signals_added"], {"edited-files": 1})
        self.assertEqual(result["top_signal_sets"][0]["signals"], ["edited-files"])
        self.assertEqual(result["command_kinds"], {})
        self.assertEqual(result["asset_files_changed_this_tool"], 0)
        self.assertEqual(result["hook_duration_ms"]["count"], 0)
        self.assertEqual(result["slow_events"], [])
        self.assertEqual(result["unknown_command_tools"], {})
        self.assertEqual(result["unknown_command_repos"], {})
        self.assertEqual(result["repos"], ["RepoA"])

    def test_hook_report_archive_dry_run_reports_eligible_sessions_without_moving(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        session.joinpath("events.jsonl").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-01T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "asset_gate_present",
                    "repoName": "RepoA",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--dry-run", "--json")

        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["sessionCount"], 1)
        self.assertEqual(result["eventCount"], 1)
        self.assertTrue(session.exists())
        self.assertFalse((plugin_data / "_archives").exists())

    def test_hook_report_top_level_help_lists_archive_subcommand(self) -> None:
        completed = subprocess.run(
            ["python", str(HOOK_REPORT), "--help"],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        self.assertIn("{archive}", completed.stdout)
        self.assertRegex(completed.stdout, r"\n\s+archive\s+\S")

    def test_hook_report_archive_help_is_discoverable_as_subcommand(self) -> None:
        plugin_data = self.temp_root / "plugin-data"

        completed = subprocess.run(
            ["python", str(HOOK_REPORT), str(plugin_data), "archive", "--help"],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        self.assertIn("--before", completed.stdout)
        self.assertIn("--dry-run", completed.stdout)

    def test_hook_report_summary_mode_still_works_with_positional_plugin_data(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--summary-session"
        session.mkdir(parents=True)
        session.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","decision":"allow","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "--json")

        self.assertEqual(result["total_events"], 1)
        self.assertEqual(result["by_hook"], {"Stop": 1})
        self.assertEqual(result["repos"], ["RepoA"])

    def test_hook_report_archive_text_mode_dry_run_does_not_crash(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        session.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","decision":"allow","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )

        completed = subprocess.run(
            ["python", str(HOOK_REPORT), str(plugin_data), "archive", "--before", "2026-06-10", "--dry-run"],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        self.assertIn("status: dry_run", completed.stdout)
        self.assertIn("session_count: 1", completed.stdout)
        self.assertNotIn("archivePath", completed.stdout)

    def test_hook_report_archive_moves_sessions_and_writes_manifest(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        original_text = (
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-01T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "asset_gate_present",
                    "repoName": "RepoA",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        session.joinpath("events.jsonl").write_text(original_text, encoding="utf-8")

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--json")

        self.assertEqual(result["status"], "archived")
        self.assertEqual(result["sessionCount"], 1)
        self.assertEqual(result["eventCount"], 1)
        self.assertFalse(session.exists())
        archive_root = Path(result["archivePath"])
        self.assertTrue(archive_root.is_dir())
        self.assertRegex(archive_root.as_posix(), r"_archives/2026-06-01_to_2026-06-01/[0-9a-f]{16}")
        archived_events = archive_root / "RepoA--old-session" / "events.jsonl"
        self.assertEqual(archived_events.read_text(encoding="utf-8"), original_text)
        manifest = json.loads((archive_root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["archiveHash"], result["archiveHash"])
        self.assertEqual(manifest["files"][0]["eventCount"], 1)
        self.assertEqual(manifest["files"][0]["repoName"], "RepoA")

        summary = self.run_json(HOOK_REPORT, plugin_data, "--archives-only", "--json")
        self.assertEqual(summary["total_events"], 1)
        self.assertEqual(summary["repos"], ["RepoA"])

    def test_hook_report_archive_manifest_write_failure_keeps_source_session(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        session.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","decision":"allow","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )

        spec = importlib.util.spec_from_file_location("asset_hook_report_under_test", HOOK_REPORT)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        args = argparse.Namespace(
            plugin_data=str(plugin_data),
            before="2026-06-10",
            since=None,
            until=None,
            repo=None,
            dry_run=False,
            include_current=False,
            json=True,
        )

        original_write_text = Path.write_text

        def failing_write_text(path: Path, data: str, *args: object, **kwargs: object) -> int:
            if path.name == "manifest.json":
                raise OSError("manifest write failed")
            return original_write_text(path, data, *args, **kwargs)

        with mock.patch.object(Path, "write_text", autospec=True, side_effect=failing_write_text):
            with self.assertRaises(OSError):
                module.run_archive(args)

        self.assertTrue(session.exists(), "source session should remain if manifest write fails")
        archive_root = plugin_data / "_archives"
        archived_copy = next(archive_root.rglob("RepoA--old-session"), None)
        self.assertIsNotNone(archived_copy, "copied archive payload should still exist for inspection")

    def test_hook_report_archive_before_uses_session_last_event_boundary(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--mixed-session"
        session.mkdir(parents=True)
        session.joinpath("events.jsonl").write_text(
            "\n".join(
                [
                    '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","decision":"allow","reasonCode":"asset_gate_present","repoName":"RepoA"}',
                    '{"timestampUtc":"2026-06-20T00:00:00Z","hookEventName":"PostToolUse","repoName":"RepoA","toolName":"functions.update_plan"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--dry-run", "--json")

        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["sessionCount"], 0)
        self.assertEqual(result["eventCount"], 0)
        self.assertEqual(result["files"], [])
        self.assertIsNone(result["fromDate"])
        self.assertIsNone(result["untilDate"])
        self.assertTrue(session.exists())

    def test_hook_report_archive_excludes_current_sessions_by_default(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        current = plugin_data / "RepoA--current-session"
        old = plugin_data / "RepoA--old-session"
        current.mkdir(parents=True)
        old.mkdir(parents=True)
        current.joinpath("state.json").write_text("{}", encoding="utf-8")
        current.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )
        old.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--json")

        self.assertEqual(result["sessionCount"], 1)
        self.assertTrue(current.exists())
        self.assertFalse(old.exists())

    def test_hook_report_archive_uses_deterministic_suffix_when_hash_dir_exists(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        original_text = (
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-01T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "asset_gate_present",
                    "repoName": "RepoA",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        session.joinpath("events.jsonl").write_text(original_text, encoding="utf-8")

        dry_run = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--dry-run", "--json")
        base_archive_root = (
            plugin_data
            / "_archives"
            / "2026-06-01_to_2026-06-01"
            / str(dry_run["archiveHash"])
        )
        base_archive_root.mkdir(parents=True)
        (base_archive_root / "manifest.json").write_text("{}", encoding="utf-8")

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--json")

        self.assertEqual(result["archiveHash"], dry_run["archiveHash"])
        self.assertTrue(str(result["archivePath"]).endswith(f"{dry_run['archiveHash']}-2"))
        self.assertTrue(base_archive_root.exists())
        archive_root = Path(str(result["archivePath"]))
        manifest = json.loads((archive_root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["archiveHash"], dry_run["archiveHash"])
        self.assertEqual(manifest["files"][0]["archivedPath"], f"{archive_root.relative_to(plugin_data).as_posix()}/RepoA--old-session")

    def test_hook_jsonl_append_helper_serializes_concurrent_writers(self) -> None:
        spec = importlib.util.spec_from_file_location("asset_hook_under_test", HOOK_SCRIPT)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        events_path = self.temp_root / "plugin-data" / "session-1" / "events.jsonl"
        writer = self.temp_root / "writer.py"
        writer.write_text(
            f"""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("asset_hook_under_test", {str(HOOK_SCRIPT)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

for index in range(25):
    module.append_jsonl_event(Path(sys.argv[1]), {{"writer": sys.argv[2], "index": index}})
""",
            encoding="utf-8",
        )

        processes = [
            subprocess.Popen(
                ["python", str(writer), str(events_path), str(index)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            for index in range(8)
        ]
        results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=10)
            results.append((process.returncode, stdout, stderr))
        for returncode, stdout, stderr in results:
            self.assertEqual(returncode, 0, stderr or stdout)

        lines = events_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 200)
        events = [json.loads(line) for line in lines]
        self.assertEqual(
            {(event["writer"], event["index"]) for event in events},
            {(str(writer), index) for writer in range(8) for index in range(25)},
        )

    def test_post_tool_use_classifies_common_diagnostic_commands(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        commands = [
            ("Bash", {"command": "git status --short --branch"}, "git-status"),
            ("Bash", {"command": "git diff -- AGENTS.md"}, "git-diff"),
            ("Bash", {"command": "rg -n asset_hook plugins"}, "rg-search-readonly"),
            (
                "functions.exec_command",
                {"cmd": "Get-Content -LiteralPath 'AGENTS.md' -Encoding utf8"},
                "powershell-readonly",
            ),
            (
                "functions.exec_command",
                {"cmd": "python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts"},
                "python-unittest",
            ),
            ("functions.exec_command", {"cmd": "codex plugin list"}, "codex-plugin-cli"),
            ("apply_patch", {"patch": "*** Begin Patch\n*** End Patch"}, "file-edit"),
            ("functions.exec_command", {"cmd": "wsl -d Ubuntu -- uname -a"}, "wsl"),
            ("functions.exec_command", {"cmd": "wsl -d Ubuntu -- ros2 topic list"}, "ros2"),
            ("functions.exec_command", {"cmd": "colcon build --symlink-install"}, "colcon"),
            ("functions.exec_command", {"cmd": "curl.exe -I http://localhost:5088"}, "http-request"),
            (
                "functions.exec_command",
                {"cmd": "Get-Content -Encoding utf8 AGENTS.md; Test-Path docs\\superpowers"},
                "powershell-multi-command",
            ),
        ]

        for index, (tool_name, tool_input, expected_kind) in enumerate(commands):
            self.run_hook(
                {
                    "hook_event_name": "PostToolUse",
                    "session_id": "session-1",
                    "turn_id": f"turn-{index}",
                    "cwd": str(repo),
                    "tool_name": tool_name,
                    "tool_input": tool_input,
                    "tool_response": {"exit_code": 0},
                },
                plugin_data=plugin_data,
            )

        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]

        self.assertEqual(
            [event["commandKind"] for event in events],
            [expected_kind for _tool_name, _tool_input, expected_kind in commands],
        )

    def test_post_tool_use_classifies_common_script_and_runner_commands(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        cases = [
            ("python scripts\\audit.py --json", "python-script"),
            ("python -m pytest tests", "pytest"),
            ("pytest tests/test_demo.py", "pytest"),
            ("node scripts/report.mjs", "node-script"),
            ("node_modules\\.bin\\vitest run tests/demo.test.ts", "vitest"),
            ("Get-Content file.txt | Select-String demo", "powershell-readonly"),
            ("Set-Content file.txt 'demo'", "powershell-write"),
        ]

        for index, (command, expected_kind) in enumerate(cases, start=1):
            code, stdout, stderr = self.run_hook(
                {
                    "hook_event_name": "PostToolUse",
                    "session_id": f"session-{index}",
                    "turn_id": "turn-1",
                    "cwd": str(repo),
                    "tool_name": "Bash",
                    "tool_input": {"command": command},
                    "tool_response": {"exit_code": 0},
                },
                plugin_data=plugin_data,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(stdout, "")
            events_path = plugin_data / f"repo--session-{index}" / "events.jsonl"
            events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(events[-1]["commandKind"], expected_kind, command)
            self.assertNotIn("command", events[-1])

    def test_inbox_lifecycle_script_forces_utf8_stdout_for_chinese_text(self) -> None:
        repo = self.create_repo()
        inbox_root = repo / "docs/superpowers/inbox/2026-06"
        inbox_root.mkdir(parents=True, exist_ok=True)
        (inbox_root / "2026-06-06-ros-2-wsl-python-environment-inbox.md").write_text(
            """# ROS 2 WSL Python Environment Inbox

- Date: `2026-06-06`
- Topic slug: `ros-2-wsl-python-environment`
- Lifecycle: `Open`
- Route candidate: `unknown`
- Revisit trigger: `再次验证 WSL Python 环境。`

## Signal

ROS 2 WSL Python environment.
""",
            encoding="utf-8",
        )
        (repo / "docs/superpowers/inbox/INDEX.md").write_text(
            "# Inbox\n\n## 2026-06\n\n"
            "- [2026-06-06-ros-2-wsl-python-environment-inbox.md](./2026-06/2026-06-06-ros-2-wsl-python-environment-inbox.md): ROS 2 WSL Python environment signal.\n",
            encoding="utf-8",
        )
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "ascii"

        completed = subprocess.run(
            ["python", str(INBOX_INSPECTOR), str(repo), "ROS", "WSL"],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("再次验证 WSL Python 环境", completed.stdout)


if __name__ == "__main__":
    unittest.main()
