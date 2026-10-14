export function normalizeProtectedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("protectedPaths must contain 1 to 16 relative directories");
  const paths = value.map(entry => {
    if (typeof entry !== "string" || !entry || entry.length > 1024 || entry.trim() !== entry || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\*?\[\]{}]/.test(entry)) {
      throw new Error("Invalid protectedPaths entry; use a literal relative directory without control characters, boundary whitespace, backslashes or wildcards");
    }
    const segments = entry.split("/");
    if (![".agents", ".codex"].includes(segments[0]!) || segments.some(segment => !segment || segment === "." || segment === ".." || segment.trim() !== segment)) {
      throw new Error("protectedPaths must stay inside .agents or .codex without empty, dot or parent segments");
    }
    return entry;
  });
  return [...new Set(paths)].sort();
}
