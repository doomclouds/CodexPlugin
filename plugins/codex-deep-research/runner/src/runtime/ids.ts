export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `dr_${stamp}`;
}

export function createSequentialId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}
