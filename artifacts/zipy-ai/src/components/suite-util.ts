export const arr = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
export const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const str = (v: unknown, d = ""): string => typeof v === "string" ? v : typeof v === "number" ? String(v) : d;
export const errMsg = (e: unknown): string => {
  const o = obj(e); const d = obj(o.data);
  return str(d.message) || str(d.error) || (e instanceof Error ? e.message : "Request failed. Please try again.");
};
export const fmt = (s: unknown): string => { const d = new Date(str(s)); return Number.isNaN(d.getTime()) ? str(s, "unknown") : d.toLocaleString(); };
