from __future__ import annotations

from asset_core.issues import issue


ASSET_GATE_EVENT_TYPES = (
    "implementation-boundary",
    "requirement-archive",
    "bugfix-root-cause",
    "user-validation-feedback",
    "ci-release-feedback",
    "post-release-warning",
    "cleanup-only",
)

ASSET_GATE_ROUTES = ("none", "inbox", "update-existing", "archive", "new-problem", "both")

REQUIRED_ASSET_GATE_FIELDS = (
    "event_type",
    "route",
    "reason",
    "evidence",
    "related_assets",
    "asset_candidates",
    "deferred_signals",
    "next_step",
)


def parse_asset_gate_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    in_gate = False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line == "asset_gate:":
            in_gate = True
            continue
        if not in_gate and line.startswith("asset_gate:"):
            in_gate = True
            continue
        if not in_gate or ":" not in line:
            continue

        key, value = line.split(":", 1)
        key = key.strip()
        if key in REQUIRED_ASSET_GATE_FIELDS:
            fields[key] = value.strip()

    return fields


def validate_asset_gate_text(text: str) -> dict[str, object]:
    if "asset_gate:" not in text:
        return {
            "valid": False,
            "code": "missing_asset_gate_output",
            "fields": {},
            "missing": list(REQUIRED_ASSET_GATE_FIELDS),
            "invalid": [],
        }

    fields = parse_asset_gate_fields(text)
    missing = [field for field in REQUIRED_ASSET_GATE_FIELDS if not fields.get(field)]
    invalid: list[str] = []

    event_type = fields.get("event_type")
    route = fields.get("route")
    if event_type and event_type not in ASSET_GATE_EVENT_TYPES:
        invalid.append(f"event_type={event_type}")
    if route and route not in ASSET_GATE_ROUTES:
        invalid.append(f"route={route}")

    return {
        "valid": not missing and not invalid,
        "code": "asset_gate_present" if not missing and not invalid else "invalid_asset_gate_output",
        "fields": fields,
        "missing": missing,
        "invalid": invalid,
    }


def _format_invalid_asset_gate_message(result: dict[str, object]) -> str:
    missing = result["missing"]
    invalid = result["invalid"]
    parts: list[str] = []
    if missing:
        parts.append(f"missing required fields: {', '.join(missing)}")
    if invalid:
        invalid_text = ", ".join(str(item).replace("=", " value ") for item in invalid)
        parts.append(f"invalid values: {invalid_text}")
    return "asset_gate output is invalid; " + "; ".join(parts) + "."


def check_asset_gate_text(text: str, issues: list[dict[str, str]]) -> None:
    result = validate_asset_gate_text(text)
    if result["code"] == "missing_asset_gate_output":
        issues.append(
            issue(
                "error",
                "missing_asset_gate_output",
                "Meaningful close-out requested an auditable asset_gate block, but none was found.",
            )
        )
        return
    if not result["valid"]:
        issues.append(
            issue(
                "error",
                "invalid_asset_gate_output",
                _format_invalid_asset_gate_message(result),
            )
        )
