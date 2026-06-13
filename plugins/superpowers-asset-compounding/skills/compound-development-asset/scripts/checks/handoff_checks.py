from __future__ import annotations

from asset_core.issues import issue


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


def check_asset_gate_text(text: str, issues: list[dict[str, str]]) -> None:
    if "asset_gate:" not in text:
        issues.append(
            issue(
                "error",
                "missing_asset_gate_output",
                "Meaningful close-out requested an auditable asset_gate block, but none was found.",
            )
        )
        return
    for required in REQUIRED_ASSET_GATE_FIELDS:
        if required not in text:
            issues.append(
                issue(
                    "warning",
                    "incomplete_asset_gate_output",
                    f"asset_gate output is missing '{required}'.",
                )
            )
