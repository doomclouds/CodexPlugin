---
name: drawio-template-shapes
description: Create or revise .drawio diagrams by preferring draw.io built-in template libraries, stencil libraries, and named shape packs instead of assembling everything from raw basic rectangles. Use when Codex needs to draw UI mockups, wireframes, flowcharts, UML, architecture diagrams, cloud diagrams, network diagrams, or when the user asks which draw.io template libraries are available on this PC.
---

# Draw.io Template Shapes

## Overview

Prefer built-in draw.io libraries first. Match the diagram's visual language to an installed template, stencil library, or named shape pack before falling back to generic shapes.

On this PC, draw.io is installed at `C:\Program Files\draw.io\draw.io.exe` and the packaged libraries live inside `C:\Program Files\draw.io\resources\app.asar`.

Read [references/current-pc-drawio-libraries.md](references/current-pc-drawio-libraries.md) when you need the current machine's available library families, template categories, or refresh commands.

## Workflow

1. Classify the request.
   - UI mockup or wireframe: prefer `bootstrap`, `mockup`, `ios7`, `layout`, `wireframes`.
   - Flow/process/state: prefer `flowchart`, `basic`, `bpmn`, `uml`, `software`, `flowcharts`.
   - Architecture/cloud/platform: prefer `aws4`, `azure`, `gcp`, `kubernetes`, `office`, `mxC4`, `network`.
   - Network/rack/vendor topology: prefer `cisco`, `cisco19`, `cisco_safe`, `rack`, `networks`, `veeam`, `office`.
   - Engineering/specialized: prefer `electrical`, `pid`, `floorplan`, `engineering`.

2. Pick the highest-signal library family.
   - Start from the user's requested style if they named one.
   - If they did not name one, choose the family whose native shapes most reduce manual drawing.
   - Reuse an existing `.drawio` skeleton when one is already close to the target.

3. Bias toward named shapes, not hand-built lookalikes.
   - Use `shape=mxgraph.bootstrap.*`, `shape=mxgraph.aws4.*`, `shape=mxgraph.gcp2.*`, `shape=mxgraph.cisco19.*`, or the matching installed family when available.
   - If a library supports the target concept directly, do not rebuild it from plain rectangles unless the library render is clearly worse.

4. Keep layout and library separate in your head.
   - Layout answers "how does the information flow?"
   - Library answers "what visual language should represent each node?"
   - The same content may be expressed with different libraries while keeping the same logical structure.

5. Validate before claiming success.
   - Ensure XML remains valid.
   - Export with draw.io CLI when possible.
   - If labels include inline HTML inside XML attributes, escape XML-sensitive characters such as `&lt;`, `&gt;`, and `&amp;`.

## Selection Heuristics

### UI and product surfaces

- `bootstrap`: admin dashboards, cards, nav bars, badges, buttons.
- `mockup`: wireframes, menus, form controls, rough product UI.
- `ios7`: mobile or Apple-flavored screens.
- `layout` / `wireframes`: page skeletons and screen compositions.

### Architecture and cloud

- `aws4`, `azure`, `gcp`, `ibm`, `alibaba_cloud`, `kubernetes`: vendor-native cloud diagrams.
- `office`: generic enterprise infra with clouds, services, servers, devices, users.
- `mxC4`: software architecture views when C4-style containers/components fit the ask.

### Analysis and process

- `flowchart`, `basic`, `bpmn`, `uml`, `software`: process, sequence, state, ER, component, and software-centric diagrams.
- `charts`, `tables`, `venn`, `maps`: analytical or presentation-oriented diagrams.

### Infra and hardware

- `cisco`, `cisco19`, `cisco_safe`, `rack`, `networks`, `networks2`, `veeam`: network and rack-heavy topologies.

### Specialized technical domains

- `electrical`, `pid`, `floorplan`, `engineering`: domain-specific technical drawings.

## Current PC Summary

This machine currently exposes these major library groups inside draw.io:

- Template categories: `basic`, `business`, `charts`, `cloud`, `engineering`, `flowcharts`, `layout`, `maps`, `network`, `other`, `software`, `tables`, `uml`, `venn`, `wireframes`
- Stencil families: `bootstrap`, `mockup`, `flowchart`, `bpmn`, `aws`, `aws2`, `aws3`, `aws3d`, `aws4`, `azure`, `gcp`, `gcp2`, `kubernetes`, `office`, `cisco`, `cisco19`, `cisco_safe`, `rack`, `networks`, `networks2`, `electrical`, `pid`, `floorplan`, `alibaba_cloud`, `salesforce`, `openstack`, `veeam`
- Named shape packs: `mxBootstrap`, `mxAWS4`, `mxAWS3D`, `mxGCP2`, `mxKubernetes`, `mxFlowchart`, `mxUML25`, `mxArchiMate`, `mxAtlassian`, `mxNetworks`, `mxCisco19`, `mxCiscoSafe`, `mxCabinets`, `mxElectrical`, `mxFloorplan`, `mxC4`

For the fuller machine-specific list and evidence path, read [references/current-pc-drawio-libraries.md](references/current-pc-drawio-libraries.md).

## Refreshing the Inventory

Run `scripts/list-drawio-libraries.ps1` when you need to refresh the current PC inventory from `app.asar`.

Use that script when:

- draw.io was upgraded
- you suspect the installed libraries changed
- you need an authoritative list instead of relying on memory
