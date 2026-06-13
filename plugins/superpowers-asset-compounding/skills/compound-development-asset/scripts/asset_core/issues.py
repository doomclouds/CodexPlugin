from __future__ import annotations


def issue(severity: str, code: str, message: str, *, path: str | None = None, area: str | None = None) -> dict[str, str]:
    item = {"severity": severity, "code": code, "message": message}
    if path:
        item["path"] = path
    if area:
        item["area"] = area
    return item
