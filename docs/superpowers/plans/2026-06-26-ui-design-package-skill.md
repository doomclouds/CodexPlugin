# UI Design Package Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `create-ui-design-package` skill that creates visual-first, subagent-ready UI design packages under `docs/designs/<slug>/`.

**Architecture:** Add a new writer/orchestrator skill inside `superpowers-asset-compounding`, backed by deterministic templates and a `design_package.py` script. The skill coordinates ImageGen/Product Design workflows at runtime, while the script owns package scaffolding, validation, summarization, and repository guidance integration.

**Tech Stack:** Codex skill Markdown, Python 3 standard library, `unittest`, JSON, Markdown, existing asset-compounding AGENTS guidance scripts, plugin manifest metadata.

## Global Constraints

- Store project UI design packages under `docs/designs/<design-slug>/`, not under `docs/superpowers/`.
- Do not treat the first generated image as final.
- Do not create implementation-ready documents before the user approves a source image.
- Do not proceed to image-to-code without `docs/designs/<slug>/assets/source/selected-ui-design.png`.
- Do not claim visual fidelity without rendered screenshots.
- Do not replace Product Design skills; coordinate with visual ideation, image-to-code, and design QA workflows.
- Default image-to-code output is `docs/designs/<slug>/prototype/`; production code changes require explicit user request.
- Subagent handoff requires `subagent-task-pack.md`, screenshots, and `visual-fidelity-checklist.md`.
- Keep scripts dependency-free and compatible with Windows PowerShell UTF-8 usage.
- Validate with `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` and `git diff --check`.

---

## File Structure

Create these files:

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
  - Owns the visual-first workflow, hard gates, resource routing, and Superpowers compatibility rules.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/agents/openai.yaml`
  - UI metadata for the skill chip.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/start-here-template.md`
  - Template for the shortest future-agent entry point.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/design-brief-template.md`
  - Template for the confirmed brief.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-source-template.md`
  - Template defining the approved image as the source of truth.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-decision-log-template.md`
  - Template for multi-round visual iteration history.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/prototype-implementation-template.md`
  - Template linking approved source image to runnable reference or production code.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/subagent-task-pack-template.md`
  - Template for direct implementation handoff to subagents.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-fidelity-checklist-template.md`
  - Template for screenshot-backed fidelity evidence.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/traceability-template.md`
  - Template mapping design evidence to contracts and implementation anchors.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/component-board-template.md`
  - Template for component inventory and examples.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/design-tokens-schema.md`
  - Human-readable schema for `design-tokens.json`.

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
  - CLI facade with `create`, `check`, and `summarize`.

Modify these files:

- `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
  - Adds tests for skill metadata, templates, package creation, validation, guidance, and docs/manifest updates.

- `plugins/superpowers-asset-compounding/skills/compound-development-asset/references/agents-asset-guidance-template.md`
  - Adds `docs/designs/` as a retrieval anchor and bumps managed block version.

- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/bootstrap_asset_compounding.py`
  - Creates `docs/designs` during bootstrap.

- `plugins/superpowers-asset-compounding/README.md`
  - Documents the new skill and Superpowers-compatible UI workflow.

- `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
  - Updates description, keywords, long description, and default prompts.

No new runtime dependencies are required.

---

### Task 1: Skill Metadata and Workflow Body

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/agents/openai.yaml`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Produces skill trigger:
  - name: `create-ui-design-package`
  - script reference: `scripts/design_package.py`
  - package root: `docs/designs/<slug>/`
- Later tasks consume this skill folder and metadata paths.

- [ ] **Step 1: Write failing metadata test**

Add this test near the existing skill metadata tests in `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`:

```python
    def test_ui_design_package_skill_exists_with_required_metadata(self) -> None:
        skill_root = SKILLS / "create-ui-design-package"
        skill = skill_root / "SKILL.md"
        agent = skill_root / "agents" / "openai.yaml"

        self.assertTrue(skill.is_file())
        self.assertTrue(agent.is_file())

        skill_text = skill.read_text(encoding="utf-8")
        agent_text = agent.read_text(encoding="utf-8")

        self.assertIn("name: create-ui-design-package", skill_text)
        self.assertIn("description:", skill_text)
        self.assertIn("docs/designs/<slug>/", skill_text)
        self.assertIn("Visual Iteration Loop", skill_text)
        self.assertIn("No approved source image, no image-to-code", skill_text)
        self.assertIn("No rendered screenshots, no fidelity claim", skill_text)
        self.assertIn("subagent-task-pack.md", skill_text)
        self.assertIn("visual-fidelity-checklist.md", skill_text)
        self.assertIn("design_package.py", skill_text)
        self.assertIn("Superpowers Workflow Compatibility", skill_text)
        self.assertIn("Product Design", skill_text)
        self.assertIn("ImageGen", skill_text)

        self.assertIn('display_name: "Create UI Design Package"', agent_text)
        self.assertIn('short_description: "Create visual-first UI design packages."', agent_text)
        self.assertIn(
            'default_prompt: "Use $create-ui-design-package to create a visual-first docs/designs UI package for subagent implementation."',
            agent_text,
        )
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_skill_exists_with_required_metadata
```

Expected: fail because the skill does not exist.

- [ ] **Step 3: Create the skill folder and `SKILL.md`**

Create `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md` with:

```markdown
---
name: create-ui-design-package
description: Create visual-first UI design packages under docs/designs by iterating ImageGen concepts with the user, approving a source image, converting it through image-to-code, capturing rendered QA screenshots, extracting design tokens and component contracts, and producing a subagent-ready implementation task pack. Use when a project needs UI design docs, visual source-of-truth assets, component guidance, design-system planning, or implementation-ready UI instructions before frontend, TUI, desktop, or app UI work.
---

# Create UI Design Package

## Role

Use this skill to create a durable UI design package under `docs/designs/<slug>/`.

This skill is not a generic document writer. It coordinates a visual-first workflow:

```text
brief -> visual iteration loop -> approved source image -> image-to-code
-> rendered QA -> design contracts -> subagent task pack
```

The package must let a future Superpowers implementation subagent match the approved UI without relying on chat history or guessing colors, spacing, typography, component density, layout regions, or states.

## Hard Gates

- No approved source image, no image-to-code.
- No approved source image, no final design package.
- No rendered screenshots, no fidelity claim.
- No `subagent-task-pack.md`, no subagent handoff.
- No `design-tokens.json`, no implementation-ready package.
- No `visual-fidelity-checklist.md`, no completed design package.
- No persisted images under `docs/designs/<slug>/assets/`, no package validation.

## Workflow

### 1. Confirm the brief

Confirm:

- product or feature name
- target UI surface
- intended user and primary job
- visual references or desired style
- platform constraints
- interaction level
- prototype mode: `reference` or `production`

If these are already clear, play back the brief instead of asking again.

### 2. Create or open the package shell

Use:

```powershell
python <skill>\scripts\design_package.py create . <slug> --mode new
```

For an extension of an existing design package:

```powershell
python <skill>\scripts\design_package.py create . <slug> --mode extend --source docs/designs/<source>
```

### 3. Run visual exploration

Use ImageGen or Product Design visual ideation to generate initial options.

Persist every durable generated image under:

```text
docs/designs/<slug>/assets/generated-options/
```

If ImageGen cannot write directly to that directory, ingest the generated image into the package before validation.

### 4. Run the Visual Iteration Loop

Repeat until the user explicitly approves one final image:

1. generate or revise image options
2. ask the user for feedback
3. record feedback in `visual-decision-log.md`
4. preserve generated images in `assets/generated-options/`
5. continue until approval

Do not treat the first generated image as final.

### 5. Persist the approved source image

When the user approves a visual version, store it as:

```text
docs/designs/<slug>/assets/source/selected-ui-design.png
```

This image is the visual source of truth for image-to-code, contracts, tokens, and subagent implementation.

### 6. Convert image to code

Use Product Design image-to-code or an equivalent local frontend workflow.

Default target:

```text
docs/designs/<slug>/prototype/
```

Only modify production application code when the user explicitly asks for production mode.

### 7. Capture rendered QA evidence

Run the prototype or product UI and capture screenshots:

- desktop screenshot for web/desktop UI
- mobile screenshot for responsive UI
- narrow/no-color screenshot for TUI or terminal UI

Store screenshots under:

```text
docs/designs/<slug>/assets/screenshots/
```

### 8. Complete contracts and subagent pack

Use the templates in `references/` to complete:

- `START_HERE.md`
- `design-brief.md`
- `visual-source.md`
- `visual-decision-log.md`
- `prototype-implementation.md`
- `subagent-task-pack.md`
- `visual-fidelity-checklist.md`
- `design-tokens.json`
- `traceability.md`
- `component-board.md`
- `contracts/`
- `guides/`

Docs must summarize confirmed visual and rendered evidence. Do not invent unapproved design rules.

### 9. Validate the package

Run:

```powershell
python <skill>\scripts\design_package.py check . docs/designs/<slug> --json
```

Fix every error before handoff.

## Missing Detail Protocol

If a required visual detail is missing, stop and report:

```text
BLOCKED: design detail missing
missing_detail: <specific missing or contradictory design detail>
affected_files: <files or components blocked by the gap>
needed_decision: <specific decision needed from the main agent or user>
```

Do not invent palette, spacing, typography, layout regions, component density, or interaction states.

## Superpowers Workflow Compatibility

The design package comes before and beside the normal Superpowers workflow:

```text
create-ui-design-package
  -> Superpowers brainstorming/spec design
  -> Superpowers implementation plan
  -> implementation subagents
  -> verification and visual fidelity QA
  -> archive/problem/inbox closeout
```

Superpowers specs and plans should link the design package instead of duplicating it. UI implementation subagents must start from `START_HERE.md` and `subagent-task-pack.md`, then return screenshots and a completed `visual-fidelity-checklist.md` before DONE.

Archives for completed UI work should link the related `docs/designs/<slug>/` package as a source document.

## References

Load these only when needed:

- `references/start-here-template.md`
- `references/design-brief-template.md`
- `references/visual-source-template.md`
- `references/visual-decision-log-template.md`
- `references/prototype-implementation-template.md`
- `references/subagent-task-pack-template.md`
- `references/visual-fidelity-checklist-template.md`
- `references/traceability-template.md`
- `references/component-board-template.md`
- `references/design-tokens-schema.md`
```

- [ ] **Step 4: Create `agents/openai.yaml`**

Create `plugins/superpowers-asset-compounding/skills/create-ui-design-package/agents/openai.yaml`:

```yaml
interface:
  display_name: "Create UI Design Package"
  short_description: "Create visual-first UI design packages."
  default_prompt: "Use $create-ui-design-package to create a visual-first docs/designs UI package for subagent implementation."
```

- [ ] **Step 5: Run focused GREEN verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_skill_exists_with_required_metadata
```

Expected: pass.

- [ ] **Step 6: Commit Task 1**

Run:

```powershell
git add plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md plugins/superpowers-asset-compounding/skills/create-ui-design-package/agents/openai.yaml plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): add ui design package skill"
```

---

### Task 2: Design Package Templates

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/start-here-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/design-brief-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-source-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-decision-log-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/prototype-implementation-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/subagent-task-pack-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-fidelity-checklist-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/traceability-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/component-board-template.md`
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/design-tokens-schema.md`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Produces templates that `design_package.py create` copies into `docs/designs/<slug>/`.
- Template token format:
  - `{{DESIGN_SLUG}}`
  - `{{DESIGN_TITLE}}`
  - `{{DATE}}`
  - `{{MODE}}`
  - `{{SOURCE_PACKAGE}}`

- [ ] **Step 1: Write failing template coverage test**

Add:

```python
    def test_ui_design_package_templates_define_required_handoff_contracts(self) -> None:
        reference_root = SKILLS / "create-ui-design-package" / "references"
        required = {
            "start-here-template.md": ["selected-ui-design.png", "subagent-task-pack.md", "visual-fidelity-checklist.md"],
            "design-brief-template.md": ["Prototype mode", "Visual references", "Interaction level"],
            "visual-source-template.md": ["Approved source image", "Allowed Deviations", "Forbidden Deviations"],
            "visual-decision-log-template.md": ["Round 1", "Generated", "User feedback", "Decision"],
            "prototype-implementation-template.md": ["Implementation mode", "Run command", "Rendered screenshots"],
            "subagent-task-pack-template.md": ["Do not invent colors", "BLOCKED: design detail missing", "DONE requires"],
            "visual-fidelity-checklist-template.md": ["Desktop screenshot", "Known deviations", "pass/fail"],
            "traceability-template.md": ["Source Of Truth Order", "Design Graph", "AI Reading Recipes"],
            "component-board-template.md": ["Rendered Scenes", "Rendered Components", "Design Decisions"],
            "design-tokens-schema.md": ['"colors"', '"typography"', '"spacing"', '"motion"'],
        }

        for filename, expected_terms in required.items():
            path = reference_root / filename
            self.assertTrue(path.is_file(), filename)
            text = path.read_text(encoding="utf-8")
            self.assertIn("{{DESIGN_SLUG}}", text, filename)
            for term in expected_terms:
                self.assertIn(term, text, filename)
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts
```

Expected: fail because references do not exist.

- [ ] **Step 3: Create `start-here-template.md`**

Create:

```markdown
# {{DESIGN_TITLE}} Start Here

- Design slug: `{{DESIGN_SLUG}}`
- Package mode: `{{MODE}}`
- Source package: `{{SOURCE_PACKAGE}}`
- Date: `{{DATE}}`

## Goal

Implement the UI from this design package with visual fidelity to the approved source image.

## Required Source Image

- `assets/source/selected-ui-design.png`

## Required Reading Order

1. `visual-source.md`
2. `design-tokens.json`
3. `component-board.md`
4. `contracts/`
5. `subagent-task-pack.md`
6. `visual-fidelity-checklist.md`

## Hard Rules

- Do not invent colors, spacing, typography, layout regions, component density, or interaction states.
- If a required design detail is missing, stop and report the gap.
- Do not mark DONE without screenshots.
- Do not mark DONE without completing `visual-fidelity-checklist.md`.

## Validation

Run:

```powershell
python <skill>\scripts\design_package.py check . docs/designs/{{DESIGN_SLUG}} --json
```
```

- [ ] **Step 4: Create brief/source/decision/prototype templates**

Create `design-brief-template.md`:

```markdown
# {{DESIGN_TITLE}} Design Brief

- Design slug: `{{DESIGN_SLUG}}`
- Package mode: `{{MODE}}`
- Source package: `{{SOURCE_PACKAGE}}`
- Date: `{{DATE}}`

## Product Or Feature

Describe the product, feature, page, component, flow, or design-system slice.

## Target Surface

Name the UI surface and platform constraints.

## Target User

Describe who uses this UI and what they need to accomplish.

## Visual references

List screenshots, URLs, Figma frames, existing design packages, brand assets, or style references.

## Interaction level

State whether this package targets static visual reference, reference prototype, or production implementation.

## Prototype mode

`reference`
```

Create `visual-source-template.md`:

```markdown
# {{DESIGN_TITLE}} Visual Source

- Approved source image: `assets/source/selected-ui-design.png`
- Approval status: `Not approved`
- Date: `{{DATE}}`

## Must Match

- Overall layout
- Color palette
- Typography hierarchy
- Component shape and density
- Spacing rhythm
- Required interaction states

## Allowed Deviations

- Responsive wrapping when the viewport is narrower than the source image.
- Platform-native font fallback when the primary font is unavailable.

## Forbidden Deviations

- Replacing the approved palette with framework defaults.
- Adding visual sections not shown in the source image.
- Changing border radius, density, hierarchy, or spacing without a logged decision.
```

Create `visual-decision-log-template.md`:

```markdown
# {{DESIGN_TITLE}} Visual Decision Log

- Design slug: `{{DESIGN_SLUG}}`
- Date: `{{DATE}}`

## Round 1

Generated:

- `assets/generated-options/round-01-option-a.png`

User feedback:

- Record the user's feedback for this round.

Decision:

- Record retained and rejected visual decisions.
```

Create `prototype-implementation-template.md`:

```markdown
# {{DESIGN_TITLE}} Prototype Implementation

- Implementation mode: `reference`
- Code path: `prototype/`
- Date: `{{DATE}}`

## Run command

```powershell
Set-Location docs/designs/{{DESIGN_SLUG}}/prototype
npm install
npm run dev
```

## Rendered screenshots

- Desktop screenshot: `assets/screenshots/implementation-desktop.png`
- Mobile or narrow screenshot: `assets/screenshots/implementation-mobile.png`

## Known deviations

- None recorded.
```

- [ ] **Step 5: Create subagent and fidelity templates**

Create `subagent-task-pack-template.md`:

```markdown
# {{DESIGN_TITLE}} Subagent Task Pack

You must implement the UI from this design package.

## Required inputs

- Source image: `assets/source/selected-ui-design.png`
- Tokens: `design-tokens.json`
- Component board: `component-board.md`
- Contracts: `contracts/`

## Required reading order

1. `START_HERE.md`
2. `visual-source.md`
3. `design-tokens.json`
4. `component-board.md`
5. `contracts/`
6. `visual-fidelity-checklist.md`

## Hard rules

- Match the approved source image before adding extra behavior.
- Use `design-tokens.json` for colors, type, spacing, and shape.
- Do not invent colors, spacing, typography, layout regions, component density, or interaction states.
- Do not use framework default colors or spacing when they conflict with the package.
- If a required visual detail is missing, return:

```text
BLOCKED: design detail missing
missing_detail: <specific missing or contradictory design detail>
affected_files: <files or components blocked by the gap>
needed_decision: <specific decision needed from the main agent or user>
```

## DONE requires

- Implementation file paths
- Desktop screenshot path
- Mobile, narrow, or no-color screenshot path
- Completed `visual-fidelity-checklist.md`
- Known deviations
- Tests or preview command
```

Create `visual-fidelity-checklist-template.md`:

```markdown
# {{DESIGN_TITLE}} Visual Fidelity Checklist

- Source image opened and inspected: pass/fail
- Layout matches source image: pass/fail
- Color tokens match implementation: pass/fail
- Typography scale matches spec: pass/fail
- Spacing rhythm matches source: pass/fail
- Component shapes match source: pass/fail
- Required states are covered: pass/fail
- Desktop screenshot captured: `assets/screenshots/implementation-desktop.png`
- Mobile, narrow, or no-color screenshot captured: `assets/screenshots/implementation-mobile.png`
- Known deviations documented: pass/fail
- Deviations approved or explicitly blocked: pass/fail

## Known deviations

- None recorded.
```

- [ ] **Step 6: Create traceability/component/token templates**

Create `traceability-template.md`:

```markdown
# {{DESIGN_TITLE}} Traceability

## Source Of Truth Order

1. `assets/source/selected-ui-design.png` owns visual intent.
2. `contracts/` owns visual semantics, states, and platform constraints.
3. `design-tokens.json` owns reusable visual values.
4. `prototype/` and `assets/screenshots/` provide rendered evidence.
5. Superpowers specs and plans own implementation slice scope.

## Design Graph

```text
docs/designs/{{DESIGN_SLUG}}/
  START_HERE.md
    -> visual-source.md
    -> design-tokens.json
    -> component-board.md
    -> contracts/
    -> subagent-task-pack.md
```

## Requirement Matrix

| Requirement | Source image area | Contract | Screenshot evidence |
| --- | --- | --- | --- |
| Primary UI fidelity | `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | `assets/screenshots/implementation-desktop.png` |

## AI Reading Recipes

For implementation:

1. Read `START_HERE.md`.
2. Open `assets/source/selected-ui-design.png`.
3. Read `design-tokens.json`.
4. Read `component-board.md`.
5. Read relevant files under `contracts/`.

## Coverage Audit

Every required image must be referenced by at least one Markdown file.
```

Create `component-board-template.md`:

```markdown
# {{DESIGN_TITLE}} Component Board

## Purpose

Capture selected visual and interaction direction in text-native form so implementation subagents do not infer component details from pixels alone.

## Rendered Scenes

| Scene | Asset | Contract | Purpose |
| --- | --- | --- | --- |
| Approved source | `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | Source of truth |

## Rendered Components

| Component | Asset | Contract |
| --- | --- | --- |
| Primary component | `assets/components/` | `contracts/component-contracts.md` |

## Design Decisions

- Record component density, hierarchy, spacing rhythm, and state treatment.
```

Create `design-tokens-schema.md`:

```markdown
# {{DESIGN_TITLE}} Design Tokens Schema

`design-tokens.json` must contain these top-level keys:

```json
{
  "colors": {},
  "typography": {},
  "spacing": {},
  "shape": {},
  "elevation": {},
  "breakpoints": {},
  "motion": {}
}
```

Use an empty object when a category does not apply. Do not omit the key.
```

- [ ] **Step 7: Run focused GREEN verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts
```

Expected: pass.

- [ ] **Step 8: Commit Task 2**

Run:

```powershell
git add plugins/superpowers-asset-compounding/skills/create-ui-design-package/references plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): add ui design package templates"
```

---

### Task 3: `design_package.py create/check/summarize`

**Files:**
- Create: `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Produces CLI commands:
  - `design_package.py create <root> <slug> --mode new|extend [--source path] [--write] [--json]`
  - `design_package.py check <root> <package> --json`
  - `design_package.py summarize <root> <package> --json`
- Produces created package files under `docs/designs/<slug>/`.
- Produces JSON result dictionaries with `status`, `errors`, and `warnings`.

- [ ] **Step 1: Add script path constant**

In `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`, add:

```python
DESIGN_PACKAGE = SKILLS / "create-ui-design-package" / "scripts" / "design_package.py"
```

- [ ] **Step 2: Write failing create/check tests**

Add:

```python
    def test_design_package_create_scaffolds_docs_design_package(self) -> None:
        repo = self.temp_root / "design_repo"
        repo.mkdir()

        result = self.run_json(
            DESIGN_PACKAGE,
            "create",
            repo,
            "sample-dashboard",
            "--mode",
            "new",
            "--write",
            "--json",
        )

        package = repo / "docs" / "designs" / "sample-dashboard"
        self.assertEqual(result["status"], "created")
        self.assertEqual(result["package"], str(package))
        self.assertTrue((package / "START_HERE.md").is_file())
        self.assertTrue((package / "design-brief.md").is_file())
        self.assertTrue((package / "visual-source.md").is_file())
        self.assertTrue((package / "visual-decision-log.md").is_file())
        self.assertTrue((package / "prototype-implementation.md").is_file())
        self.assertTrue((package / "subagent-task-pack.md").is_file())
        self.assertTrue((package / "visual-fidelity-checklist.md").is_file())
        self.assertTrue((package / "design-tokens.json").is_file())
        self.assertTrue((package / "traceability.md").is_file())
        self.assertTrue((package / "component-board.md").is_file())
        self.assertTrue((package / "contracts" / "visual-system.md").is_file())
        self.assertTrue((package / "guides" / "implementation-readiness.md").is_file())
        self.assertTrue((package / "assets" / "generated-options").is_dir())
        self.assertTrue((package / "assets" / "source").is_dir())
        self.assertTrue((package / "assets" / "screenshots").is_dir())
        self.assertTrue((package / "assets" / "components").is_dir())
        self.assertTrue((package / "prototype").is_dir())

        tokens = json.loads((package / "design-tokens.json").read_text(encoding="utf-8"))
        self.assertEqual(
            sorted(tokens),
            ["breakpoints", "colors", "elevation", "motion", "shape", "spacing", "typography"],
        )
```

Add:

```python
    def test_design_package_check_reports_missing_source_image_and_screenshots(self) -> None:
        repo = self.temp_root / "invalid_design_repo"
        repo.mkdir()
        self.run_json(
            DESIGN_PACKAGE,
            "create",
            repo,
            "sample-dashboard",
            "--mode",
            "new",
            "--write",
            "--json",
        )

        result = self.run_json_fail(
            DESIGN_PACKAGE,
            "check",
            repo,
            repo / "docs" / "designs" / "sample-dashboard",
            "--json",
        )

        codes = {issue["code"] for issue in result["errors"]}
        self.assertIn("missing_approved_source_image", codes)
        self.assertIn("missing_rendered_screenshot", codes)
        self.assertIn("visual_source_not_approved", codes)
```

Add:

```python
    def test_design_package_check_passes_for_complete_reference_package(self) -> None:
        repo = self.temp_root / "valid_design_repo"
        repo.mkdir()
        package = repo / "docs" / "designs" / "sample-dashboard"
        self.run_json(
            DESIGN_PACKAGE,
            "create",
            repo,
            "sample-dashboard",
            "--mode",
            "new",
            "--write",
            "--json",
        )

        (package / "assets/source/selected-ui-design.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (package / "assets/screenshots/implementation-desktop.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (package / "assets/screenshots/implementation-mobile.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (package / "assets/generated-options/round-01-option-a.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        visual_source = (package / "visual-source.md").read_text(encoding="utf-8")
        (package / "visual-source.md").write_text(
            visual_source.replace("Approval status: `Not approved`", "Approval status: `Approved`"),
            encoding="utf-8",
            newline="\n",
        )

        result = self.run_json(DESIGN_PACKAGE, "check", repo, package, "--json")
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])

        summary = self.run_json(DESIGN_PACKAGE, "summarize", repo, package, "--json")
        self.assertEqual(summary["status"], "implementation-ready")
        self.assertTrue(summary["approved_source_image"])
        self.assertEqual(summary["screenshot_count"], 2)
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_create_scaffolds_docs_design_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_reports_missing_source_image_and_screenshots plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_passes_for_complete_reference_package
```

Expected: fail because `design_package.py` does not exist.

- [ ] **Step 4: Implement script skeleton and constants**

Create `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`:

```python
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
    "traceability.md",
    "component-board.md",
)
PACKAGE_DIRS = (
    "contracts",
    "guides",
    "assets/generated-options",
    "assets/source",
    "assets/screenshots",
    "assets/components",
    "prototype",
)
CONTRACT_FILES = (
    "contracts/visual-system.md",
    "contracts/layout-and-regions.md",
    "contracts/component-contracts.md",
    "contracts/states-and-variants.md",
    "contracts/interaction-flows.md",
    "contracts/accessibility-and-responsive.md",
)
GUIDE_FILES = (
    "guides/implementation-readiness.md",
    "guides/subagent-implementation-guide.md",
    "guides/design-readiness-review.md",
)
PLACEHOLDER_MARKERS = ("TODO", "TBD")


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def title_from_slug(slug: str) -> str:
    return " ".join(part.capitalize() for part in slug.split("-") if part)


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
```

- [ ] **Step 5: Implement `create_package()`**

Append:

```python
def write_text(path: Path, text: str, write: bool) -> None:
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")


def package_path(root: Path, slug: str) -> Path:
    return root / "docs" / "designs" / slug


def create_package(root: Path, slug: str, mode: str, source: str, write: bool) -> dict[str, object]:
    package = package_path(root, slug)
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
    if write:
        (package / "design-tokens.json").write_text(
            json.dumps(tokens, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    created.append(str(package / "design-tokens.json"))

    for relative in CONTRACT_FILES:
        content = f"# {title_from_slug(Path(relative).stem)}\n\nPackage: `{{{{DESIGN_SLUG}}}}`\n\n## Acceptance Checklist\n\n- Define contract details before implementation.\n"
        content = content.replace("{{DESIGN_SLUG}}", slug)
        target = package / relative
        write_text(target, content, write)
        created.append(str(target))

    for relative in GUIDE_FILES:
        content = f"# {title_from_slug(Path(relative).stem)}\n\nPackage: `{slug}`\n\n## Guidance\n\nUse this file to record implementation readiness, subagent notes, or design review evidence.\n"
        target = package / relative
        write_text(target, content, write)
        created.append(str(target))

    return {"status": "created" if write else "dry_run", "package": str(package), "created": created}
```

- [ ] **Step 6: Implement validation helpers**

Append:

```python
def issue(code: str, message: str, path: Path | None = None) -> dict[str, str]:
    result = {"code": code, "message": message}
    if path is not None:
        result["path"] = str(path)
    return result


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


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


def markdown_files(package: Path) -> list[Path]:
    return sorted(package.rglob("*.md"))


def local_markdown_links(text: str) -> list[str]:
    return re.findall(r"\[[^\]]+\]\(([^)]+)\)", text)


def validate_links(package: Path) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    for md in markdown_files(package):
        text = md.read_text(encoding="utf-8")
        for target in local_markdown_links(text):
            if "://" in target or target.startswith("#"):
                continue
            clean = target.split("#", 1)[0]
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
```

- [ ] **Step 7: Implement `check_package()` and `summarize_package()`**

Append:

```python
def screenshot_paths(package: Path) -> list[Path]:
    root = package / "assets" / "screenshots"
    if not root.exists():
        return []
    return sorted(path for path in root.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})


def generated_option_paths(package: Path) -> list[Path]:
    root = package / "assets" / "generated-options"
    if not root.exists():
        return []
    return sorted(path for path in root.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})


def check_package(root: Path, package: Path) -> dict[str, object]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if not package.exists():
        errors.append(issue("missing_design_package", "Design package directory does not exist.", package))
        return {"status": "needs_attention", "package": str(package), "errors": errors, "warnings": warnings}

    for relative in PACKAGE_FILES:
        path = package / relative
        if not path.is_file():
            errors.append(issue("missing_required_file", f"Missing required file: {relative}", path))
    for relative in (*PACKAGE_DIRS,):
        path = package / relative
        if not path.is_dir():
            errors.append(issue("missing_required_directory", f"Missing required directory: {relative}", path))

    source_image = package / "assets" / "source" / "selected-ui-design.png"
    if not source_image.is_file():
        errors.append(issue("missing_approved_source_image", "Approved source image is required.", source_image))
    if not has_approved_source(package):
        errors.append(issue("visual_source_not_approved", "visual-source.md must mark approval status as Approved.", package / "visual-source.md"))

    screenshots = screenshot_paths(package)
    categories = screenshot_categories(screenshots)
    if not categories["desktop"]:
        errors.append(issue("missing_desktop_screenshot_evidence", "Rendered screenshot evidence must include a desktop screenshot.", package / "assets" / "screenshots"))
    if not categories["secondary"]:
        errors.append(issue("missing_secondary_screenshot_evidence", "Rendered screenshot evidence must include at least one mobile, narrow, or no-color screenshot.", package / "assets" / "screenshots"))
    elif not any(desktop_path != secondary_path for desktop_path in categories["desktop"] for secondary_path in categories["secondary"]):
        errors.append(issue("screenshot_evidence_requires_distinct_files", "Rendered screenshot evidence must use separate desktop and mobile, narrow, or no-color files.", package / "assets" / "screenshots"))

    if not generated_option_paths(package):
        errors.append(issue("missing_generated_options", "At least one persisted generated visual option is required in assets/generated-options.", package / "assets" / "generated-options"))

    errors.extend(validate_tokens(package))
    errors.extend(validate_links(package))
    errors.extend(validate_placeholders(package))

    task_pack = read_text(package / "subagent-task-pack.md")
    if "DONE requires" not in task_pack or "BLOCKED: design detail missing" not in task_pack:
        errors.append(issue("incomplete_subagent_task_pack", "subagent-task-pack.md must define BLOCKED and DONE protocols.", package / "subagent-task-pack.md"))

    fidelity = read_text(package / "visual-fidelity-checklist.md")
    if "Desktop screenshot" not in fidelity or "Known deviations" not in fidelity:
        errors.append(issue("incomplete_fidelity_checklist", "visual-fidelity-checklist.md must include screenshot and known-deviation fields.", package / "visual-fidelity-checklist.md"))

    return {
        "status": "pass" if not errors else "needs_attention",
        "package": str(package),
        "errors": errors,
        "warnings": warnings,
    }


def summarize_package(root: Path, package: Path) -> dict[str, object]:
    check = check_package(root, package)
    source_image = package / "assets" / "source" / "selected-ui-design.png"
    screenshots = screenshot_paths(package)
    return {
        "status": "implementation-ready" if check["status"] == "pass" else "needs_attention",
        "package": str(package),
        "approved_source_image": source_image.is_file() and has_approved_source(package),
        "screenshot_count": len(screenshots),
        "generated_option_count": len(generated_option_paths(package)),
        "errors": check["errors"],
        "warnings": check["warnings"],
    }
```

- [ ] **Step 8: Implement CLI parser**

Append:

```python
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
    else:
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
        return 0 if args.write or result["status"] == "dry_run" else 1
    if args.command == "check":
        result = check_package(root, Path(args.package).resolve())
        emit(result, args.json)
        return 0 if result["status"] == "pass" else 1
    if args.command == "summarize":
        result = summarize_package(root, Path(args.package).resolve())
        emit(result, args.json)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 9: Run focused GREEN verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_create_scaffolds_docs_design_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_reports_missing_source_image_and_screenshots plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_passes_for_complete_reference_package
```

Expected: pass.

- [ ] **Step 10: Commit Task 3**

Run:

```powershell
git add plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): scaffold ui design packages"
```

---

### Task 4: AGENTS Guidance and Bootstrap Compatibility

**Files:**
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/references/agents-asset-guidance-template.md`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/bootstrap_asset_compounding.py`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Produces managed guidance version `0.3.3`.
- Produces bootstrap-created directory `docs/designs`.
- Existing `ensure_agent_asset_guidance.py` consumes the updated template automatically.

- [ ] **Step 1: Write failing guidance/bootstrap tests**

Add:

```python
    def test_asset_guidance_includes_docs_designs_retrieval(self) -> None:
        guidance = (
            SKILLS / "compound-development-asset" / "references" / "agents-asset-guidance-template.md"
        ).read_text(encoding="utf-8")

        self.assertIn("asset-compounding-guidance:version=0.3.3", guidance)
        self.assertIn("Design packages: `docs/designs/`", guidance)
        self.assertIn("START_HERE.md", guidance)
        self.assertIn("selected-ui-design.png", guidance)
        self.assertIn("subagent-task-pack.md", guidance)
        self.assertIn("If a design detail is missing", guidance)
        self.assertIn("docs/designs", guidance)

    def test_bootstrap_creates_docs_designs_directory(self) -> None:
        repo = self.temp_root / "bootstrap_design_repo"
        repo.mkdir()

        result = self.run_json(BOOTSTRAP, repo, "--write", "--json")

        self.assertIn("docs/designs", result["created_dirs"])
        self.assertTrue((repo / "docs" / "designs").is_dir())
        agents_text = (repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("Design packages: `docs/designs/`", agents_text)
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_guidance_includes_docs_designs_retrieval plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_bootstrap_creates_docs_designs_directory
```

Expected: fail because guidance is still `0.3.1` and bootstrap does not create `docs/designs`.

- [ ] **Step 3: Update guidance template**

In `agents-asset-guidance-template.md`:

- Change marker to:

```html
<!-- asset-compounding-guidance:version=0.3.3 -->
```

- Under `### Asset Directories`, add:

```markdown
- Design packages: `docs/designs/`
```

- Add a section after Asset Directories:

```markdown
### Design Package Navigation

Use `docs/designs/` for visual-first UI design packages. These packages are project UI assets, not Superpowers specs or archives.

For UI implementation work, read `docs/designs/<slug>/START_HERE.md` first. Then read `visual-source.md`, `design-tokens.json`, `component-board.md`, relevant `contracts/`, and `subagent-task-pack.md`.

The approved source image at `assets/source/selected-ui-design.png` owns visual intent. The contracts own visual semantics, states, accessibility, responsive behavior, and platform constraints. The Superpowers spec and plan own the current implementation slice scope.

If a design detail is missing, contradictory, or impossible to implement on the target platform, stop and report the gap instead of inventing palette, spacing, typography, layout regions, component density, or interaction states.
```

- In Retrieval Order, add design packages before specs for UI work:

```markdown
1. For UI work, search `docs/designs/` and read the matching `START_HERE.md`.
2. Search `docs/superpowers/specs/` and `docs/superpowers/plans/` for the intended behavior and implementation plan.
```

- Update the preferred `rg` command to include `docs/designs`.

- [ ] **Step 4: Update bootstrap directories**

In `bootstrap_asset_compounding.py`, add `"docs/designs"` to `ASSET_DIRS`:

```python
ASSET_DIRS = [
    "docs/superpowers",
    "docs/superpowers/specs",
    "docs/superpowers/plans",
    "docs/superpowers/archives",
    "docs/superpowers/problems",
    "docs/superpowers/inbox",
    "docs/designs",
    "docs/milestones",
    "docs/technical-debt",
]
```

- [ ] **Step 5: Run focused GREEN verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_guidance_includes_docs_designs_retrieval plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_bootstrap_creates_docs_designs_directory
```

Expected: pass.

- [ ] **Step 6: Run existing guidance tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_v030_skills_exist_with_required_metadata plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_compounding_plugin_metadata_mentions_v032_audit_archive
```

Expected: fail only if existing tests assert the old guidance version. If they do, update assertions from `asset-compounding-guidance:version=0.3.1` to `asset-compounding-guidance:version=0.3.3` and preserve existing milestone/debt assertions.

- [ ] **Step 7: Commit Task 4**

Run:

```powershell
git add plugins/superpowers-asset-compounding/skills/compound-development-asset/references/agents-asset-guidance-template.md plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/bootstrap_asset_compounding.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): add design package retrieval guidance"
```

---

### Task 5: README and Plugin Manifest Integration

**Files:**
- Modify: `plugins/superpowers-asset-compounding/README.md`
- Modify: `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Plugin manifest continues to expose `skills: "./skills/"`.
- Long description and prompts mention UI design packages.

- [ ] **Step 1: Write failing README/manifest test**

Add:

```python
    def test_plugin_metadata_mentions_ui_design_package_skill(self) -> None:
        manifest = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("design-packages", manifest["keywords"])
        self.assertIn("UI design packages", manifest["interface"]["longDescription"])
        self.assertIn("Create a visual-first UI design package.", manifest["interface"]["defaultPrompt"])

        self.assertIn("create-ui-design-package", readme)
        self.assertIn("docs/designs/<slug>/", readme)
        self.assertIn("visual iteration", readme.lower())
        self.assertIn("selected-ui-design.png", readme)
        self.assertIn("subagent-task-pack.md", readme)
        self.assertIn("visual-fidelity-checklist.md", readme)
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_plugin_metadata_mentions_ui_design_package_skill
```

Expected: fail because README and manifest do not mention the new skill.

- [ ] **Step 3: Update plugin manifest**

In `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`:

- Add keyword:

```json
"design-packages"
```

- Extend `interface.longDescription` with:

```text
It also provides a visual-first UI design package skill that materializes approved images, reference prototypes, screenshots, tokens, contracts, and subagent task packs under docs/designs/ so Superpowers UI implementation work has a stable visual source of truth.
```

- Add default prompt:

```json
"Create a visual-first UI design package."
```

Do not change the plugin version in this task unless the release plan explicitly chooses a new version.

- [ ] **Step 4: Update README skill list**

In `plugins/superpowers-asset-compounding/README.md`, change the skill count and add:

```markdown
- `create-ui-design-package`: visual-first UI design package creator for `docs/designs/<slug>/`.
```

Add a short section:

```markdown
### UI Design Packages

Use `create-ui-design-package` when UI work needs a user-approved visual baseline before Superpowers spec and implementation planning.

The workflow is:

```text
brief -> visual iteration -> approved source image -> image-to-code
-> rendered QA -> design contracts -> subagent task pack
```

Generated project assets live under:

```text
docs/designs/<slug>/
```

Key files include `assets/source/selected-ui-design.png`, `design-tokens.json`, `component-board.md`, `contracts/`, `subagent-task-pack.md`, and `visual-fidelity-checklist.md`.

Superpowers specs and plans should link the design package instead of duplicating it. UI implementation subagents should read `START_HERE.md` and `subagent-task-pack.md` before editing UI code.
```

- [ ] **Step 5: Run focused GREEN verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_plugin_metadata_mentions_ui_design_package_skill
```

Expected: pass.

- [ ] **Step 6: Validate manifest JSON**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json
```

Expected: valid JSON printed to stdout.

- [ ] **Step 7: Commit Task 5**

Run:

```powershell
git add plugins/superpowers-asset-compounding/README.md plugins/superpowers-asset-compounding/.codex-plugin/plugin.json plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "docs(asset-compounding): document ui design packages"
```

---

### Task 6: Full Verification and Release Archive

**Files:**
- Create: `docs/superpowers/archives/2026-06/2026-06-26-ui-design-package-skill-archives.md`
- Modify: `docs/superpowers/archives/INDEX.md`
- Modify: any file required by failed final verification.

**Interfaces:**
- Consumes implementation and verification evidence from Tasks 1-5.
- Produces release archive and index entry.

- [ ] **Step 1: Run full unit suite**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: all tests pass.

- [ ] **Step 2: Run design package smoke test against a temp repo**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
$tmp = Join-Path $env:TEMP ('ui-design-package-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py create $tmp smoke-dashboard --mode new --write --json
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check $tmp (Join-Path $tmp 'docs\designs\smoke-dashboard') --json
```

Expected: `create` succeeds; `check` returns a JSON status requiring source image and screenshot evidence. This proves the validator blocks incomplete implementation-ready packages.

- [ ] **Step 3: Run bootstrap smoke test**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
$tmp = Join-Path $env:TEMP ('asset-bootstrap-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\bootstrap_asset_compounding.py $tmp --write --json
```

Expected: JSON `created_dirs` includes `docs/designs`, and generated `AGENTS.md` mentions design packages.

- [ ] **Step 4: Run manifest and whitespace checks**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json
git diff --check
```

Expected: valid JSON and no whitespace errors.

- [ ] **Step 5: Create archive document**

Create `docs/superpowers/archives/2026-06/2026-06-26-ui-design-package-skill-archives.md`:

```markdown
# UI Design Package Skill

- Date: `2026-06-26`
- Topic slug: `ui-design-package-skill`
- Status: `Archived`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `ui-design`, `imagegen`, `product-design`, `subagent`

## Summary

Added a visual-first UI design package skill that creates `docs/designs/<slug>/` packages from approved UI source images, reference implementations, screenshots, design tokens, contracts, and subagent task packs. The package integrates with Superpowers specs, plans, subagent execution, and archive/problem closeout so UI implementation work has a stable visual source of truth.

## Delivered Scope

- Added `create-ui-design-package` with ImageGen/Product Design orchestration guidance and hard gates.
- Added templates for design briefs, visual sources, visual decision logs, prototype evidence, subagent task packs, fidelity checklists, traceability, component boards, and token schema.
- Added `design_package.py create/check/summarize` for package scaffolding, validation, and status reporting.
- Added `docs/designs/` to bootstrap and AGENTS retrieval guidance.
- Updated plugin README and manifest metadata to expose UI design package workflows.

## Out of Scope

- No automatic ImageGen file-path control beyond package ingest requirements.
- No production UI code generation by default.
- No automatic visual pixel diff in the first release.
- No automatic hook-driven design package creation.

## Verification Snapshot

- `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> all tests passed.
- `python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json` -> valid JSON.
- `git diff --check` -> passed.
- `design_package.py create` smoke test -> created `docs/designs/smoke-dashboard`.
- `design_package.py check` smoke test -> blocked incomplete package without approved source image and screenshots.

## Source Documents

- Spec: [UI Design Package Skill Design](../../specs/2026-06-26-ui-design-package-skill-design.md)
- Plan: [UI Design Package Skill Implementation Plan](../../plans/2026-06-26-ui-design-package-skill.md)

## Related Problems

- None.

## Notes

- UI design packages live in `docs/designs/`; Superpowers specs, plans, archives, problems, and inbox notes remain in their existing asset directories.
```

- [ ] **Step 6: Update archive index**

Add the archive line under `## 2026-06` in `docs/superpowers/archives/INDEX.md`, preserving newest-first order and existing style:

```markdown
- [UI Design Package Skill](./2026-06/2026-06-26-ui-design-package-skill-archives.md): Adds a visual-first `docs/designs/<slug>/` package workflow with approved source images, reference prototypes, screenshots, tokens, contracts, and subagent task packs for Superpowers-compatible UI implementation.
```

- [ ] **Step 7: Validate archive and indexes**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\archive-superpowers-feature\scripts\validate_archive_asset.py docs\superpowers\archives\2026-06\2026-06-26-ui-design-package-skill-archives.md
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_indexes.py .
```

Expected: archive validator passes and index check passes.

- [ ] **Step 8: Run final full verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
git diff --check
```

Expected: tests pass and diff check reports no whitespace errors.

- [ ] **Step 9: Commit Task 6**

Run:

```powershell
git add docs/superpowers/archives/2026-06/2026-06-26-ui-design-package-skill-archives.md docs/superpowers/archives/INDEX.md
git commit -m "docs(asset-compounding): archive ui design package skill"
```

---

## Plan Self-Review

- Spec coverage: Tasks 1-3 create the skill, templates, design package shell, approved-image gate, tokens, subagent pack, and validator. Task 4 handles Superpowers compatibility through AGENTS retrieval and bootstrap. Task 5 exposes the workflow in plugin docs and manifest. Task 6 verifies and archives.
- Visual iteration coverage: `visual-decision-log-template.md`, generated options directory, approval source image checks, and hard gates are covered.
- Subagent context coverage: `START_HERE.md`, `subagent-task-pack.md`, `design-tokens.json`, contracts, and DONE evidence are covered.
- Superpowers compatibility: spec/plan/subagent/archive/problem boundaries are represented in `SKILL.md`, guidance template, README, and archive.
- Placeholder scan: template text contains instructional defaults but no unresolved implementation placeholders in the plan itself; validator code scans generated packages for placeholder markers.
- Interface consistency: `DESIGN_PACKAGE`, `design_package.py create/check/summarize`, and package paths are introduced before later tasks consume them.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-ui-design-package-skill.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.
