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
    "artifact-generation",
)

ASSET_GATE_EVENT_ALIASES = {
    "artifact_generation": "artifact-generation",
}

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


def _normalize_empty_value(value: str) -> str:
    cleaned = value.strip()
    return "none" if cleaned in {"[]", "{}", "null", "None"} else cleaned


def _set_field(fields: dict[str, str], key: str, value: str) -> None:
    fields[key] = _normalize_empty_value(value)


def _append_list_value(fields: dict[str, str], key: str, value: str) -> None:
    cleaned = value.strip()
    if not cleaned:
        return
    existing = fields.get(key, "")
    fields[key] = cleaned if not existing else f"{existing}; {cleaned}"


def parse_asset_gate_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    in_gate = False
    current_key: str | None = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("```"):
            continue
        if line == "asset_gate:":
            in_gate = True
            current_key = None
            continue
        if not in_gate and line.startswith("asset_gate:"):
            in_gate = True
            current_key = None
            continue
        if not in_gate or ":" not in line:
            if in_gate and current_key and line.startswith("- "):
                _append_list_value(fields, current_key, line[2:])
            continue

        key, value = line.split(":", 1)
        key = key.strip()
        if key in REQUIRED_ASSET_GATE_FIELDS:
            current_key = key
            _set_field(fields, key, value.strip())
            continue

        if current_key and line.startswith("- "):
            _append_list_value(fields, current_key, line[2:])

    return fields


def normalize_asset_gate_fields(fields: dict[str, str]) -> dict[str, str]:
    normalized = dict(fields)
    event_type = normalized.get("event_type")
    if event_type:
        normalized["event_type"] = ASSET_GATE_EVENT_ALIASES.get(event_type, event_type)
    for key, value in list(normalized.items()):
        normalized[key] = _normalize_empty_value(value)
    return normalized


def validate_asset_gate_text(text: str) -> dict[str, object]:
    if "asset_gate:" not in text:
        return {
            "valid": False,
            "code": "missing_asset_gate_output",
            "fields": {},
            "missing": list(REQUIRED_ASSET_GATE_FIELDS),
            "invalid": [],
        }

    fields = normalize_asset_gate_fields(parse_asset_gate_fields(text))
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


def canonical_asset_gate_text(
    *,
    event_type: str,
    route: str,
    reason: str,
    evidence: str,
    related_assets: str = "none",
    asset_candidates: str = "none",
    deferred_signals: str = "none",
    next_step: str = "none",
) -> str:
    fields = normalize_asset_gate_fields(
        {
            "event_type": event_type.strip(),
            "route": route.strip(),
            "reason": reason.strip(),
            "evidence": evidence.strip(),
            "related_assets": related_assets.strip(),
            "asset_candidates": asset_candidates.strip(),
            "deferred_signals": deferred_signals.strip(),
            "next_step": next_step.strip(),
        }
    )
    return (
        "asset_gate:\n"
        f"  event_type: {fields['event_type']}\n"
        f"  route: {fields['route']}\n"
        f"reason: {fields['reason']}\n"
        f"evidence: {fields['evidence']}\n"
        f"related_assets: {fields['related_assets']}\n"
        f"asset_candidates: {fields['asset_candidates']}\n"
        f"deferred_signals: {fields['deferred_signals']}\n"
        f"next_step: {fields['next_step']}"
    )


def asset_gate_template() -> str:
    return canonical_asset_gate_text(
        event_type="implementation-boundary",
        route="none",
        reason="<one concrete sentence>",
        evidence="<tests, command, user feedback, or manual validation>",
        related_assets="none",
        asset_candidates="none",
        deferred_signals="none",
        next_step="none",
    )


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
