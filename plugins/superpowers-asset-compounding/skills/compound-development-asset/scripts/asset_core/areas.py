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
