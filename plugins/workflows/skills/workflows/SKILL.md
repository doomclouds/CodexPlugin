---
name: workflows
description: Inspect Codex workflow templates and draft multi-agent orchestration scripts for the Workflows plugin. Use when the user asks to view, design, or adapt a workflow.
---

Use `workflow_get_capabilities` to establish which features this plugin currently implements. This scaffold supports inspection and drafting; it does not execute workflow scripts.

Use `workflow_list_templates` to find examples and `workflow_get_template` to read a selected script. The example follows Claude-style `meta`, `agent`, `parallel`, `pipeline`, and `phase` syntax as a discussion draft, not a committed runtime contract.

When drafting a workflow, describe its input, stages, agent outputs, completion condition, and failure handling. Keep intermediate results within the intended workflow runtime and return a useful final result to the conversation.

For execution requests, report that the adapter is not yet connected and explain the missing capability. Do not execute the script as an unrestricted Node program or substitute an unrelated agent run while claiming this plugin executed it. Normal user-authorized work can still proceed separately with existing tools.
