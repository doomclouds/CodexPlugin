import { z } from "zod";

export const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);

export class DesignError extends Error {
  readonly code: "VALIDATION" | "NOT_FOUND" | "REVISION_CONFLICT" | "LOCKED" | "UNSUPPORTED_FORMAT";
  constructor(code: "VALIDATION" | "NOT_FOUND" | "REVISION_CONFLICT" | "LOCKED" | "UNSUPPORTED_FORMAT", message: string) {
    super(message);
    this.name = "DesignError";
    this.code = code;
  }
}

export function assertSafeJson(value: unknown): void {
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();
  let entries = 0;
  let textBytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 108 || ++entries > 250_000) throw new DesignError("VALIDATION", "Document nesting or entry budget exceeded");
    if (typeof item === "string") {
      textBytes += encoder.encode(item).length;
      if (textBytes > 32 * 1024 * 1024) throw new DesignError("VALIDATION", "Document size budget exceeded");
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new DesignError("VALIDATION", "Numbers must be finite");
    if (item === null || typeof item !== "object") {
      if (["function", "symbol", "bigint", "undefined"].includes(typeof item)) throw new DesignError("VALIDATION", "Values must be JSON serializable");
      return;
    }
    if (seen.has(item)) throw new DesignError("VALIDATION", "Circular or shared object references are not supported");
    seen.add(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new DesignError("VALIDATION", "Values must be plain JSON objects");
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw new DesignError("VALIDATION", "Unsafe property name");
      if (Array.isArray(item) && key === "length") continue;
      textBytes += encoder.encode(key).length;
      if (textBytes > 32 * 1024 * 1024) throw new DesignError("VALIDATION", "Document size budget exceeded");
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !property.enumerable || !("value" in property)) throw new DesignError("VALIDATION", "Accessors and hidden properties are not supported");
      visit(property.value, depth + 1);
    }
  };
  visit(value, 0);
}
