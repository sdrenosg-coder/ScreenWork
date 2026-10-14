import { readFileSync, writeFileSync } from "node:fs";

// Orval appends this wildcard to the workspace barrel on every generation.
// Its model input names collide with the inferred Zod input names; the
// maintained barrel exposes models through ApiModels instead.
const barrel = new URL("../api-zod/src/index.ts", import.meta.url);
const source = readFileSync(barrel, "utf8");
const cleaned = source.replace(/^export\s+\*\s+from\s+["']\.\/generated\/types["'];?\s*$/gm, "");
if (cleaned !== source) writeFileSync(barrel, cleaned);
