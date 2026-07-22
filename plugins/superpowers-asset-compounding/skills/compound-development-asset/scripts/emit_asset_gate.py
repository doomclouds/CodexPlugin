#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys

from checks.handoff_checks import (
    asset_gate_handoff_text,
    canonical_asset_gate_text,
    validate_asset_gate_text,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Emit a validated asset_gate block.")
    parser.add_argument("--event-type", required=True)
    parser.add_argument("--route", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--evidence", action="append", required=True)
    parser.add_argument("--related-assets", default="none")
    parser.add_argument("--asset-candidates", default="none")
    parser.add_argument("--deferred-signals", default="none")
    parser.add_argument("--next-step", default="none")
    return parser.parse_args()


def join_values(values: list[str] | None) -> str:
    cleaned = [value.strip() for value in values or [] if value.strip()]
    return "; ".join(cleaned) if cleaned else "none"


def main() -> int:
    args = parse_args()
    try:
        block = canonical_asset_gate_text(
            event_type=args.event_type,
            route=args.route,
            reason=args.reason,
            evidence=join_values(args.evidence),
            related_assets=args.related_assets,
            asset_candidates=args.asset_candidates,
            deferred_signals=args.deferred_signals,
            next_step=args.next_step,
        )
    except ValueError as exc:
        print(f"invalid asset_gate arguments: {exc}", file=sys.stderr)
        return 2
    validation = validate_asset_gate_text(block)
    if not validation["valid"]:
        missing = ", ".join(str(item) for item in validation.get("missing") or [])
        invalid = ", ".join(str(item) for item in validation.get("invalid") or [])
        details = "; ".join(item for item in (f"missing: {missing}" if missing else "", f"invalid: {invalid}" if invalid else "") if item)
        print(f"invalid asset_gate arguments: {details}", file=sys.stderr)
        return 2
    try:
        handoff = asset_gate_handoff_text(
            block,
            route=args.route,
            related_assets=args.related_assets,
        )
    except ValueError as exc:
        print(f"invalid asset_gate arguments: {exc}", file=sys.stderr)
        return 2
    print(handoff)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
