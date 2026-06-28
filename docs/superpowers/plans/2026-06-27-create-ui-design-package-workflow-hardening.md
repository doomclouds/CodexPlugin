# Create UI Design Package Workflow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `create-ui-design-package` so rich UI design packages cannot skip asset inventory, atomic asset validation, rendered QA evidence, or package hygiene.

**Architecture:** Extend the existing single-file `design_package.py` validator with focused helpers for manifest parsing, image metadata, QA report checks, and ignored generated directories. Keep package creation and package validation in `design_package.py`; add a small `design_assets.py` helper only for asset-specific operations that are useful outside `check`.

**Tech Stack:** Python standard library, `unittest`, existing `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`, Markdown templates under `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/`.

## Global Constraints

- `docs/designs/` remains the durable design package location.
- `docs/superpowers/` remains the development-history asset system.
- Approved source image is visual truth, not a runtime sprite sheet.
- Rich bitmap UI packages require `asset-manifest.json`.
- Simple packages may declare `asset_strategy: none`.
- Do not persist `node_modules/`, `.npm-cache/`, or `dist/` as durable design package assets.
- Preserve existing CLI commands: `create`, `check`, and `summarize`.
- Validate with: `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`.
- Use UTF-8 for all text reads/writes on Windows.

---

## File Structure

- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
  - Owns staged workflow gates and hard rules.
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
  - Owns package shell creation, core validation, manifest validation, QA validation, and link-ignore behavior.
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_assets.py`
  - Owns asset-only commands: `check` and `preview`. It imports or mirrors manifest helpers from `design_package.py` only where needed.
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/asset-manifest-schema.md`
  - Human-readable manifest contract for agents.
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/*.md`
  - Update templates to mention manifest, atomic assets, QA comparison, and dependency hygiene.
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
  - Add RED/GREEN tests around manifest, QA report, dependency directory ignore, and asset helper.
- Optional compatibility update: `docs/designs/morning-journal-note-ui/asset-manifest.json`
  - Only if validator schema requires a small field migration.
- Modify: `docs/superpowers/inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md`
  - Mark lifecycle progress after implementation.
- Create after completion: `docs/superpowers/archives/2026-06/2026-06-27-create-ui-design-package-workflow-hardening-archives.md`
  - Archive this completed improvement after verification.

---

### Task 1: Add RED Tests For Workflow Gaps

**Files:**
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: existing `DESIGN_PACKAGE`, `self.run_json`, `self.run_json_fail`.
- Produces: failing tests that define error codes and behavior for later tasks.

- [ ] **Step 1: Add PNG helper functions near existing design package tests**

Add these helpers inside `AssetScriptTests`, above `test_design_package_create_scaffolds_docs_design_package`:

```python
    def write_png(self, path: Path, width: int = 1, height: int = 1, *, alpha: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        color_type = 6 if alpha else 2
        pixel = (b"\x00\x00\x00\xff" if alpha else b"\x00\x00\x00")
        raw = b"".join(b"\x00" + pixel * width for _ in range(height))
        import struct
        import zlib

        def chunk(kind: bytes, data: bytes) -> bytes:
            payload = kind + data
            return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

        path.write_bytes(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b"")
        )

    def approve_design_package(self, package: Path) -> None:
        visual_source = (package / "visual-source.md").read_text(encoding="utf-8")
        (package / "visual-source.md").write_text(
            visual_source.replace("Approval status: `Not approved`", "Approval status: `Approved`"),
            encoding="utf-8",
            newline="\n",
        )

    def add_basic_design_evidence(self, package: Path) -> None:
        self.write_png(package / "assets/source/selected-ui-design.png", 1536, 1024)
        self.write_png(package / "assets/generated-options/round-01-option-a.png", 1536, 1024)
        self.write_png(package / "assets/screenshots/implementation-desktop.png", 1536, 1024)
        self.write_png(package / "assets/screenshots/implementation-mobile.png", 390, 844)
        self.write_png(package / "assets/screenshots/qa-comparison-desktop.png", 3072, 1024)
        self.approve_design_package(package)
```

- [ ] **Step 2: Run existing design package tests to verify helpers are not used yet**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_passes_for_complete_reference_package
```

Expected: `OK`.

- [ ] **Step 3: Add failing test for missing rich asset manifest**

Add after `test_design_package_check_requires_generated_options`:

```python
    def test_design_package_check_requires_manifest_for_rich_assets(self) -> None:
        repo = self.temp_root / "missing_manifest_design_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        self.add_basic_design_evidence(package)

        result = self.run_json_fail(DESIGN_PACKAGE, "check", repo, package, "--json")

        codes = {issue["code"] for issue in result["errors"]}
        self.assertIn("missing_asset_manifest", codes)
```

- [ ] **Step 4: Add failing test for manifest path and dimension checks**

```python
    def test_design_package_check_validates_manifest_paths_and_dimensions(self) -> None:
        repo = self.temp_root / "bad_manifest_design_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        self.add_basic_design_evidence(package)
        self.write_png(package / "assets/component-assets/paper.png", 320, 180)
        self.write_png(package / "prototype/src/assets/generated/paper.png", 320, 180)
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "atomic-generated-assets",
                    "assets": [
                        {
                            "id": "paper",
                            "role": "paper surface",
                            "target_region": "WritingSanctuary",
                            "display_intent": "cover editor paper",
                            "target_size": "360x220",
                            "final_path": "assets/component-assets/paper.png",
                            "prototype_path": "prototype/src/assets/generated/paper.png",
                            "transparent": False,
                            "validation": "pending",
                        },
                        {
                            "id": "missing",
                            "role": "missing asset",
                            "target_region": "AppShell",
                            "display_intent": "must exist",
                            "target_size": "1x1",
                            "final_path": "assets/component-assets/missing.png",
                            "prototype_path": "prototype/src/assets/generated/missing.png",
                            "transparent": False,
                            "validation": "pending",
                        },
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json_fail(DESIGN_PACKAGE, "check", repo, package, "--json")

        codes = {issue["code"] for issue in result["errors"]}
        self.assertIn("asset_manifest_dimension_mismatch", codes)
        self.assertIn("asset_manifest_missing_final_path", codes)
        self.assertIn("asset_manifest_missing_prototype_path", codes)
```

- [ ] **Step 5: Add failing test for transparent PNG alpha requirement**

```python
    def test_design_package_check_requires_alpha_for_transparent_assets(self) -> None:
        repo = self.temp_root / "alpha_manifest_design_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        self.add_basic_design_evidence(package)
        self.write_png(package / "assets/component-assets/flower.png", 512, 512, alpha=False)
        self.write_png(package / "prototype/src/assets/generated/flower.png", 512, 512, alpha=False)
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "atomic-generated-assets",
                    "assets": [
                        {
                            "id": "flower",
                            "role": "transparent decoration",
                            "target_region": "RhythmPanel",
                            "display_intent": "absolute positioned decoration",
                            "target_size": "512x512",
                            "final_path": "assets/component-assets/flower.png",
                            "prototype_path": "prototype/src/assets/generated/flower.png",
                            "transparent": True,
                            "validation": "pending",
                        }
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json_fail(DESIGN_PACKAGE, "check", repo, package, "--json")

        codes = {issue["code"] for issue in result["errors"]}
        self.assertIn("asset_manifest_transparent_without_alpha", codes)
```

- [ ] **Step 6: Add failing test for QA report requirement**

```python
    def test_design_package_check_requires_passed_design_qa_report(self) -> None:
        repo = self.temp_root / "missing_qa_design_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        self.add_basic_design_evidence(package)
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "none",
                    "reason": "UI uses standard controls and icon library only.",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json_fail(DESIGN_PACKAGE, "check", repo, package, "--json")

        codes = {issue["code"] for issue in result["errors"]}
        self.assertIn("missing_design_qa_report", codes)
```

- [ ] **Step 7: Add failing test for ignored generated frontend directories**

```python
    def test_design_package_check_ignores_generated_frontend_dependency_dirs(self) -> None:
        repo = self.temp_root / "dependency_noise_design_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        self.add_basic_design_evidence(package)
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "none",
                    "reason": "UI uses standard controls and icon library only.",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (package / "design-qa.md").write_text(
            "# Design QA\n\n- final result: `passed`\n\n",
            encoding="utf-8",
            newline="\n",
        )
        noisy_readme = package / "prototype/node_modules/debug/README.md"
        noisy_readme.parent.mkdir(parents=True)
        noisy_readme.write_text("[missing](./examples/node/app.js)\n", encoding="utf-8")

        result = self.run_json(DESIGN_PACKAGE, "check", repo, package, "--json")

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
```

- [ ] **Step 8: Run new tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_manifest_for_rich_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_validates_manifest_paths_and_dimensions plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_alpha_for_transparent_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_passed_design_qa_report plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_ignores_generated_frontend_dependency_dirs
```

Expected: FAIL. Specific missing codes prove current behavior is incomplete.

- [ ] **Step 9: Commit RED tests**

```powershell
git add plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "test(asset-compounding): capture design package hardening gaps"
```

---

### Task 2: Add Asset Manifest Template And Skill Gates

**Files:**
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/asset-manifest-schema.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/start-here-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-source-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/component-board-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/subagent-task-pack-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/prototype-implementation-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/traceability-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-fidelity-checklist-template.md`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: `create_package(root, slug, mode, source, write)`.
- Produces: `asset-manifest.json` in created packages; templates that reference the manifest and gates.

- [ ] **Step 1: Extend package file and directory constants**

In `design_package.py`, add `asset-manifest.json` to `PACKAGE_FILES` after `design-tokens.json`, and add component asset directories to `PACKAGE_DIRS`:

```python
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
```

- [ ] **Step 2: Add manifest template writer to `create_package`**

After writing `design-tokens.json`, add:

```python
    manifest = {
        "design_slug": slug,
        "source_image": "assets/source/selected-ui-design.png",
        "asset_strategy": "none",
        "reason": "Set asset_strategy to atomic-generated-assets when the approved source needs bitmap textures, photos, decorations, or other runtime image assets.",
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
```

- [ ] **Step 3: Update scaffold test expectations**

In `test_design_package_create_scaffolds_docs_design_package`, add:

```python
        self.assertTrue((package / "asset-manifest.json").is_file())
        self.assertTrue((package / "assets" / "component-assets").is_dir())
        self.assertTrue((package / "assets" / "component-assets" / "raw").is_dir())
        self.assertTrue((package / "assets" / "component-assets" / "preview").is_dir())
        self.assertTrue((package / "prototype" / "src" / "assets" / "generated").is_dir())
```

Then assert default manifest:

```python
        manifest = json.loads((package / "asset-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["asset_strategy"], "none")
        self.assertEqual(manifest["source_image"], "assets/source/selected-ui-design.png")
        self.assertEqual(manifest["assets"], [])
```

- [ ] **Step 4: Create `asset-manifest-schema.md`**

Create `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/asset-manifest-schema.md`:

````markdown
# Asset Manifest Schema

Use this reference when a UI design package needs runtime bitmap assets.

## Strategies

- `none`: the UI uses standard controls and icon libraries only.
- `atomic-generated-assets`: the UI needs package-local bitmap textures, photos, decorations, avatars, product imagery, or other generated assets.

## Required Rich Asset Shape

```json
{
  "id": "paper-texture",
  "role": "paper grain material",
  "target_region": "WritingSanctuary",
  "display_intent": "cover editor paper surface",
  "target_size": "1024x1024",
  "final_path": "assets/component-assets/paper-texture.png",
  "prototype_path": "prototype/src/assets/generated/paper-texture.png",
  "transparent": false,
  "validation": "pending"
}
```

## Hard Rules

- The approved source image is visual truth, not a sprite sheet.
- Do not crop final runtime assets from the full-screen mock.
- Do not point manifest paths outside the design package.
- Transparent PNG assets must contain an alpha channel.
- Rich packages with bitmap assets use `atomic-generated-assets`.
````

- [ ] **Step 5: Update templates with manifest gates**

Add these lines to `start-here-template.md` under required reading:

```markdown
- Asset manifest: `asset-manifest.json`
- Runtime asset directory: `prototype/src/assets/generated/`
```

Add these hard rules:

```markdown
- Do not use `assets/source/selected-ui-design.png` as a live app background.
- Do not crop final runtime assets from the full-screen source mock.
- If the UI needs bitmap textures, photos, decorations, or avatars, complete `asset-manifest.json` before image-to-code.
```

In `visual-source-template.md`, change approval metadata to:

```markdown
- Approval status: `Not approved`
- Approval scope: `Not set`
```

In `subagent-task-pack-template.md`, add required input:

```markdown
- Asset manifest: `asset-manifest.json`
```

And add:

```markdown
- Use package-local runtime assets from paths listed in `asset-manifest.json`.
- The approved source image is visual reference only.
```

- [ ] **Step 6: Update `SKILL.md` hard gates and workflow**

Add to `## Hard Gates`:

```markdown
- For rich bitmap UI, no `asset-manifest.json`, no image-to-code.
- No package-local runtime assets for manifest entries, no final design package.
- No source-vs-implementation comparison and `design-qa.md`, no fidelity pass.
- No dependency hygiene, no package validation.
```

Add a new workflow section after approved source image:

```markdown
### 6. Inventory and prepare runtime assets

Catalog every image asset implied by the approved source image before image-to-code.

If the UI depends on bitmap textures, photos, avatars, decorations, note surfaces, hero images, thumbnails, or non-standard visual assets, set `asset_strategy` to `atomic-generated-assets` in `asset-manifest.json`.

The approved source image is visual truth, not a sprite sheet. Do not crop final runtime assets from the full-screen mock.
```

Renumber later sections.

- [ ] **Step 7: Run scaffold and metadata tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_skill_exists_with_required_metadata plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_create_scaffolds_docs_design_package
```

Expected: `OK`.

- [ ] **Step 8: Commit manifest and template gate**

```powershell
git add plugins/superpowers-asset-compounding/skills/create-ui-design-package plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): add design package asset manifest gate"
```

---

### Task 3: Implement Manifest And QA Validator Hardening

**Files:**
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: `asset-manifest.json`, screenshot files, `design-qa.md`, markdown links.
- Produces: validation helpers and error codes:
  - `missing_asset_manifest`
  - `invalid_asset_manifest_json`
  - `invalid_asset_manifest_strategy`
  - `asset_manifest_missing_required_key`
  - `asset_manifest_missing_final_path`
  - `asset_manifest_missing_prototype_path`
  - `asset_manifest_path_outside_package`
  - `asset_manifest_dimension_mismatch`
  - `asset_manifest_transparent_without_alpha`
  - `missing_design_qa_report`
  - `design_qa_not_passed`

- [ ] **Step 1: Add constants and ignored directory helper**

Near existing constants in `design_package.py`, add:

```python
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
```

Add:

```python
def is_ignored_markdown_path(path: Path) -> bool:
    return any(part in IGNORED_MARKDOWN_DIR_PARTS for part in path.parts)
```

Update `markdown_files`:

```python
def markdown_files(package: Path) -> list[Path]:
    return sorted(path for path in package.rglob("*.md") if not is_ignored_markdown_path(path.relative_to(package)))
```

- [ ] **Step 2: Add PNG metadata reader**

Add below `read_text`:

```python
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
```

- [ ] **Step 3: Add local path resolver for manifest entries**

```python
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
```

- [ ] **Step 4: Add manifest validator**

```python
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
        elif not final_path.is_file():
            errors.append(issue("asset_manifest_missing_final_path", f"Missing final asset path: {asset.get('final_path')}", final_path))
        if prototype_path is None:
            errors.append(issue("asset_manifest_path_outside_package", f"Asset {index} prototype_path must be package-local.", path))
        elif not prototype_path.is_file():
            errors.append(issue("asset_manifest_missing_prototype_path", f"Missing prototype asset path: {asset.get('prototype_path')}", prototype_path))

        expected_size = parse_size(str(asset.get("target_size", "")))
        if final_path is not None and final_path.is_file() and expected_size is not None:
            metadata = png_metadata(final_path)
            if metadata is not None:
                width, height, has_alpha = metadata
                if (width, height) != expected_size:
                    errors.append(
                        issue(
                            "asset_manifest_dimension_mismatch",
                            f"Asset {asset.get('id', index)} is {width}x{height}, expected {expected_size[0]}x{expected_size[1]}.",
                            final_path,
                        )
                    )
                if asset.get("transparent") is True and not has_alpha:
                    errors.append(
                        issue(
                            "asset_manifest_transparent_without_alpha",
                            f"Asset {asset.get('id', index)} is marked transparent but PNG has no alpha channel.",
                            final_path,
                        )
                    )
    return errors
```

- [ ] **Step 5: Add design QA validator**

```python
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
```

- [ ] **Step 6: Wire validators into `check_package`**

In `check_package`, after generated option validation and before tokens:

```python
    errors.extend(validate_asset_manifest(package))
    errors.extend(validate_design_qa(package, screenshots))
```

- [ ] **Step 7: Update existing passing tests to include manifest and QA**

For existing tests that currently expect a valid package, add:

```python
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "none",
                    "reason": "UI uses standard controls and icon library only.",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (package / "design-qa.md").write_text(
            "# Design QA\n\n- Source visual truth: `assets/source/selected-ui-design.png`\n- Implementation screenshot: `assets/screenshots/implementation-desktop.png`\n- final result: `passed`\n",
            encoding="utf-8",
            newline="\n",
        )
```

Apply to:

- `test_design_package_check_passes_for_complete_reference_package`
- `test_design_package_check_and_summarize_resolve_relative_package_under_repo_root`

- [ ] **Step 8: Run RED tests again and verify GREEN**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_manifest_for_rich_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_validates_manifest_paths_and_dimensions plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_alpha_for_transparent_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_passed_design_qa_report plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_ignores_generated_frontend_dependency_dirs
```

Expected: `OK`.

- [ ] **Step 9: Run all design package tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_skill_exists_with_required_metadata plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_create_scaffolds_docs_design_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_reports_missing_source_image_and_screenshots plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_passes_for_complete_reference_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_second_screenshot_evidence plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_rejects_single_mixed_screenshot_file plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_generated_options plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_and_summarize_resolve_relative_package_under_repo_root
```

Expected: `OK`.

- [ ] **Step 10: Commit validator hardening**

```powershell
git add plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): validate design package assets and qa"
```

---

### Task 4: Add Asset Helper CLI

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_assets.py`
- Modify: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- CLI:
  - `python .../design_assets.py check <repo-root> <package-path> --json`
  - `python .../design_assets.py preview <repo-root> <package-path> --output assets/component-assets/preview/contact-sheet.html --write --json`
- Produces JSON with `status`, `package`, `issues`, and optional `preview`.

- [ ] **Step 1: Add test constants**

At top of `test_asset_scripts.py`:

```python
DESIGN_ASSETS = SKILLS / "create-ui-design-package" / "scripts" / "design_assets.py"
```

- [ ] **Step 2: Add failing helper tests**

Add after design package validator tests:

```python
    def test_design_assets_check_reports_manifest_asset_issues(self) -> None:
        repo = self.temp_root / "design_assets_check_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "atomic-generated-assets",
                    "assets": [
                        {
                            "id": "missing",
                            "role": "missing",
                            "target_region": "AppShell",
                            "display_intent": "missing file",
                            "target_size": "1x1",
                            "final_path": "assets/component-assets/missing.png",
                            "prototype_path": "prototype/src/assets/generated/missing.png",
                            "transparent": False,
                            "validation": "pending",
                        }
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json_fail(DESIGN_ASSETS, "check", repo, package, "--json")

        codes = {issue["code"] for issue in result["issues"]}
        self.assertIn("asset_manifest_missing_final_path", codes)
        self.assertIn("asset_manifest_missing_prototype_path", codes)

    def test_design_assets_preview_writes_contact_sheet_html(self) -> None:
        repo = self.temp_root / "design_assets_preview_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(DESIGN_PACKAGE, "create", repo, "sample-dashboard", "--mode", "new", "--write", "--json")
        self.write_png(package / "assets/component-assets/paper.png", 1, 1)
        self.write_png(package / "prototype/src/assets/generated/paper.png", 1, 1)
        (package / "asset-manifest.json").write_text(
            json.dumps(
                {
                    "design_slug": "sample-dashboard",
                    "source_image": "assets/source/selected-ui-design.png",
                    "asset_strategy": "atomic-generated-assets",
                    "assets": [
                        {
                            "id": "paper",
                            "role": "paper",
                            "target_region": "Editor",
                            "display_intent": "preview",
                            "target_size": "1x1",
                            "final_path": "assets/component-assets/paper.png",
                            "prototype_path": "prototype/src/assets/generated/paper.png",
                            "transparent": False,
                            "validation": "pending",
                        }
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json(
            DESIGN_ASSETS,
            "preview",
            repo,
            package,
            "--output",
            "assets/component-assets/preview/contact-sheet.html",
            "--write",
            "--json",
        )

        preview = package / "assets/component-assets/preview/contact-sheet.html"
        self.assertEqual(result["status"], "preview_written")
        self.assertTrue(preview.is_file())
        self.assertIn("paper", preview.read_text(encoding="utf-8"))
```

- [ ] **Step 3: Run helper tests to verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_check_reports_manifest_asset_issues plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_preview_writes_contact_sheet_html
```

Expected: FAIL because `design_assets.py` does not exist.

- [ ] **Step 4: Implement `design_assets.py`**

Create file:

```python
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import design_package  # noqa: E402


def relative(package: Path, path: Path) -> str:
    try:
        return path.relative_to(package).as_posix()
    except ValueError:
        return str(path)


def check_assets(root: Path, package_arg: str | Path) -> dict[str, object]:
    package = design_package.resolve_package_path(root, package_arg)
    issues = design_package.validate_asset_manifest(package)
    status = "pass" if not issues else "needs_attention"
    return {"status": status, "package": str(package), "issues": issues}


def load_manifest(package: Path) -> dict[str, object]:
    path = package / "asset-manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


def build_preview_html(package: Path) -> str:
    manifest = load_manifest(package)
    assets = manifest.get("assets", [])
    rows = []
    for asset in assets if isinstance(assets, list) else []:
        if not isinstance(asset, dict):
            continue
        final_path = asset.get("final_path", "")
        src = final_path if isinstance(final_path, str) else ""
        rows.append(
            "<article>"
            f"<h2>{asset.get('id', '')}</h2>"
            f"<img src='../../{src}' alt=''>"
            f"<p>{asset.get('role', '')}</p>"
            f"<p>{asset.get('target_size', '')} · {asset.get('target_region', '')}</p>"
            "</article>"
        )
    return (
        "<!doctype html><meta charset='utf-8'>"
        "<title>Design Asset Preview</title>"
        "<style>body{font-family:Segoe UI,sans-serif;background:#f5efe4;color:#2f261f}"
        "main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:24px}"
        "article{background:white;border:1px solid #d8c9ad;border-radius:8px;padding:12px}"
        "img{max-width:100%;height:140px;object-fit:contain;background:#eee}</style>"
        "<main>"
        + "".join(rows)
        + "</main>"
    )


def preview_assets(root: Path, package_arg: str | Path, output: str, write: bool) -> dict[str, object]:
    package = design_package.resolve_package_path(root, package_arg)
    output_path = (package / output).resolve()
    if not output_path.is_relative_to(package.resolve()):
        return {
            "status": "needs_attention",
            "package": str(package),
            "issues": [
                design_package.issue(
                    "asset_preview_outside_package",
                    "Preview output must stay inside the design package.",
                    output_path,
                )
            ],
        }
    html = build_preview_html(package)
    if write:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(html, encoding="utf-8", newline="\n")
    return {
        "status": "preview_written" if write else "preview_dry_run",
        "package": str(package),
        "preview": str(output_path),
        "issues": [],
    }


def print_result(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["status"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check and preview UI design package assets.")
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
        print_result(result, args.json)
        return 0 if result["status"] == "pass" else 1
    if args.command == "preview":
        result = preview_assets(root, args.package, args.output, args.write)
        print_result(result, args.json)
        return 0 if result["status"] in {"preview_written", "preview_dry_run"} else 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Document helper in `SKILL.md`**

Add to asset workflow section:

````markdown
Use the asset helper when package assets need deterministic checks:

```powershell
python <skill>\scripts\design_assets.py check . docs/designs/<slug> --json
python <skill>\scripts\design_assets.py preview . docs/designs/<slug> --output assets/component-assets/preview/contact-sheet.html --write --json
```
````

- [ ] **Step 6: Run helper tests to verify GREEN**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_check_reports_manifest_asset_issues plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_preview_writes_contact_sheet_html
```

Expected: `OK`.

- [ ] **Step 7: Commit asset helper**

```powershell
git add plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_assets.py plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): add design package asset helper"
```

---

### Task 5: Validate Morning Journal Package And Finish Docs

**Files:**
- Modify if needed: `docs/designs/morning-journal-note-ui/asset-manifest.json`
- Modify: `docs/superpowers/inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md`
- Create: `docs/superpowers/archives/2026-06/2026-06-27-create-ui-design-package-workflow-hardening-archives.md`
- Modify: `docs/superpowers/archives/INDEX.md`

**Interfaces:**
- Consumes: new validator, existing morning journal package.
- Produces: validated compatibility evidence and archive.

- [ ] **Step 1: Run full unit test suite for asset scripts**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: `OK`.

- [ ] **Step 2: Validate current morning journal package**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check . docs\designs\morning-journal-note-ui --json
```

Expected: `status` is `pass`.

- [ ] **Step 3: If morning journal fails only on legacy asset directory, migrate manifest paths**

If error codes mention `assets/components/asset-samples`, update `docs/designs/morning-journal-note-ui/asset-manifest.json` paths to `assets/component-assets/...` only after copying the files with native PowerShell:

```powershell
New-Item -ItemType Directory -Force docs\designs\morning-journal-note-ui\assets\component-assets | Out-Null
Copy-Item docs\designs\morning-journal-note-ui\assets\components\asset-samples\*.png docs\designs\morning-journal-note-ui\assets\component-assets\ -Force
```

Then update manifest entries so `final_path` points at `assets/component-assets/<same-file-name>`.

Expected after rerun:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check . docs\designs\morning-journal-note-ui --json
```

Expected: `status` is `pass`.

- [ ] **Step 4: Validate asset helper against morning journal package**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_assets.py check . docs\designs\morning-journal-note-ui --json
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_assets.py preview . docs\designs\morning-journal-note-ui --output assets/component-assets/preview/contact-sheet.html --write --json
```

Expected: first command `status` is `pass`; second command `status` is `preview_written`.

- [ ] **Step 5: Update inbox lifecycle**

Edit `docs/superpowers/inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md`:

```markdown
- Lifecycle: `Promoted`
```

Under `Likely Next Route`, add:

```markdown
This signal has been promoted into the workflow-hardening spec, implementation plan, and archive for `create-ui-design-package-workflow-hardening`.
```

- [ ] **Step 6: Create archive**

Create `docs/superpowers/archives/2026-06/2026-06-27-create-ui-design-package-workflow-hardening-archives.md`:

```markdown
# Create UI Design Package Workflow Hardening Archive

- Date: `2026-06-27`
- Topic slug: `create-ui-design-package-workflow-hardening`
- Status: `Completed`
- Scope: `Plugin skill`
- Tags: `asset-compounding`, `ui-design`, `asset-manifest`, `visual-qa`, `validator`

## Summary

Hardened `create-ui-design-package` from a visual-first checklist into a staged, validator-backed design package workflow. Rich UI packages now have explicit asset manifest, package-local runtime asset, dependency hygiene, and rendered QA evidence requirements before a package can pass validation.

## Delivered Scope

- Added `asset-manifest.json` package creation and schema guidance.
- Updated skill hard gates and templates so approved source images are treated as visual truth, not runtime sprite sheets.
- Extended package validation for manifest paths, dimensions, alpha requirements, design QA reports, and ignored generated frontend directories.
- Added a design asset helper for manifest checks and preview contact sheets.
- Preserved simple UI compatibility with `asset_strategy: none`.
- Revalidated the morning journal design package against the hardened workflow.

## Out of Scope

- Product Design plugin internals were not changed.
- Hooks do not automatically generate design packages or images.
- Production application code was not modified.

## Verification Snapshot

- `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> pass.
- `python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check . docs\designs\morning-journal-note-ui --json` -> pass.
- `python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_assets.py check . docs\designs\morning-journal-note-ui --json` -> pass.

## Source Documents

- Spec: [Create UI Design Package Workflow Hardening Design](../../specs/2026-06-27-create-ui-design-package-workflow-hardening-design.md)
- Plan: [Create UI Design Package Workflow Hardening Implementation Plan](../../plans/2026-06-27-create-ui-design-package-workflow-hardening.md)
- Related design package: [Morning Journal Note UI](../../../designs/morning-journal-note-ui/START_HERE.md)

## Related Problems

- Inbox promoted: [Create UI Design Package Asset Workflow Gaps](../../inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md)

## Notes

This archive intentionally links the design package instead of copying its visual source, screenshots, and contracts.
```

- [ ] **Step 7: Update archive index**

Add under `## 2026-06` in `docs/superpowers/archives/INDEX.md`:

```markdown
- [2026-06-27-create-ui-design-package-workflow-hardening-archives.md](./2026-06/2026-06-27-create-ui-design-package-workflow-hardening-archives.md): 归档 create-ui-design-package 工作流加固，新增资产 manifest、atomic asset 校验、依赖目录忽略、rendered QA 证据和 morning journal 兼容验证。
```

Place it before `2026-06-26` entries.

- [ ] **Step 8: Validate archive and indexes**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\archive-superpowers-feature\scripts\validate_archive_asset.py docs\superpowers\archives\2026-06\2026-06-27-create-ui-design-package-workflow-hardening-archives.md
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_indexes.py .
```

Expected:

```text
OK: archive asset is valid
OK: indexes are valid
```

- [ ] **Step 9: Run final completion gate**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_completion_gate.py . --completed-topic create-ui-design-package-workflow-hardening --json
```

Expected: `status` is `pass`.

- [ ] **Step 10: Commit final docs and compatibility**

```powershell
git add docs/designs/morning-journal-note-ui docs/superpowers/inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md docs/superpowers/archives/2026-06/2026-06-27-create-ui-design-package-workflow-hardening-archives.md docs/superpowers/archives/INDEX.md
git commit -m "docs(asset-compounding): archive design package workflow hardening"
```

---

## Final Verification

- [ ] Run full unit test suite:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: `OK`.

- [ ] Run design package validator against morning journal:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check . docs\designs\morning-journal-note-ui --json
```

Expected: `"status": "pass"`.

- [ ] Run asset helper against morning journal:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_assets.py check . docs\designs\morning-journal-note-ui --json
```

Expected: `"status": "pass"`.

- [ ] Run archive/index checks:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\archive-superpowers-feature\scripts\validate_archive_asset.py docs\superpowers\archives\2026-06\2026-06-27-create-ui-design-package-workflow-hardening-archives.md
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_indexes.py .
```

Expected: both pass.

- [ ] Run git whitespace check:

```powershell
git diff --check
```

Expected: no output.

---

## Self-Review

### Spec Coverage

- Staged workflow gates: Tasks 2 and 3 update skill body, templates, and validator.
- Asset manifest schema and validation: Tasks 2 and 3.
- Atomic asset helper: Task 4.
- Dependency hygiene ignore: Task 3.
- Rendered QA evidence: Task 3.
- Morning journal compatibility: Task 5.
- Archive/problem/inbox closeout: Task 5.

### Placeholder Scan

No unresolved placeholder markers or unspecified test commands are present. Every implementation task names exact files, functions, tests, commands, and expected outcomes.

### Type And Interface Consistency

The plan consistently uses:

- `validate_asset_manifest(package: Path) -> list[dict[str, str]]`
- `validate_design_qa(package: Path, screenshots: list[Path]) -> list[dict[str, str]]`
- `png_metadata(path: Path) -> tuple[int, int, bool] | None`
- `design_assets.py check <root> <package> --json`
- `design_assets.py preview <root> <package> --output <relative-path> --write --json`
