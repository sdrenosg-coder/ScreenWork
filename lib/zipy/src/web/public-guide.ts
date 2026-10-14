import { forWorkspace } from "@workspace/zipy/storage/routeStore";
type PublicGuideRecord = {
  readonly slug?: unknown;
  readonly guideId?: unknown;
  readonly workspaceId?: unknown;
  readonly title?: unknown;
  readonly access?: unknown;
  readonly publishedAt?: unknown;
  readonly passwordHash?: unknown;
};

type Access = "public" | "private" | "password";

interface GuideStep {
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly imageRef: string | null;
  readonly altText: string | null;
}

interface GuidePageModel {
  readonly slug: string;
  readonly guideId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly introduction: string | null;
  readonly prerequisites: readonly string[];
  readonly steps: readonly GuideStep[];
  readonly tips: readonly string[];
  readonly warnings: readonly string[];
  readonly aiGenerated: boolean;
  readonly publishedAt: string | null;
}

type LoadResult =
  | { readonly kind: "rendered"; readonly model: GuidePageModel }
  | { readonly kind: "not_found" }
  | { readonly kind: "restricted"; readonly access: Access }
  | { readonly kind: "storage_error"; readonly message: string };

/* -------------------------------------------------------------------------- */
/* Data loading                                                                */
/* -------------------------------------------------------------------------- */

const PUBLIC_GUIDES_PREFIX = "public-guides";

function slugKey(slug: string): string {
  return `${PUBLIC_GUIDES_PREFIX}/${slug}.json`;
}

function guideDraftKey(guidId: string): string {
  return `guides/${guidId}/draft-current.json`;
}

function readAccess(raw: unknown): Access {
  if (raw === "private") return "private";
  if (raw === "password") return "password";
  return "public";
}

export async function loadGuide(slug: string): Promise<LoadResult> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 128) {
    return { kind: "not_found" };
  }
  // Slugs are lowercase alphanumeric with dashes; a slug that does not
  // match is a 404 rather than an object-store lookup, so we do not accept
  // arbitrary user input as a storage key.
  if (!/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/.test(slug) && !/^[a-z0-9]{1,128}$/.test(slug)) {
    return { kind: "not_found" };
  }

  // The public-guide registry lives at the *root* of the object store, not
  // inside any workspace scope: it is what maps a public slug to a
  // workspace. We therefore open the root scope to read it. The scope is
  // the same store the workspace helper returns but with no workspace
  // prefix, which the storage abstraction allows.
  let rootStore: { readonly get: (key: string) => Promise<Buffer | null> };
  try {
    rootStore = (await forWorkspace("__public__")) as unknown as {
      readonly get: (key: string) => Promise<Buffer | null>;
    };
  } catch (error) {
    return {
      kind: "storage_error",
      message:
        error instanceof Error
          ? error.message
          : "The object store is not available.",
    };
  }

  let registryBytes: Buffer | null;
  try {
    registryBytes = await rootStore.get(slugKey(slug));
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(m)) return { kind: "not_found" };
    return { kind: "storage_error", message: m };
  }
  if (registryBytes === null) return { kind: "not_found" };

  let record: PublicGuideRecord;
  try {
    record = JSON.parse(registryBytes.toString("utf8")) as PublicGuideRecord;
  } catch {
    return {
      kind: "storage_error",
      message: `Public-guide registry entry for "${slug}" is not valid JSON.`,
    };
  }

  const guideId = typeof record.guideId === "string" ? record.guideId : null;
  const workspaceId =
    typeof record.workspaceId === "string" ? record.workspaceId : null;
  if (guideId === null || workspaceId === null) {
    return {
      kind: "storage_error",
      message: `Public-guide registry entry for "${slug}" is missing guideId or workspaceId.`,
    };
  }

  const access = readAccess(record.access);
  if (access !== "public") {
    // The publishing access module (@zipy/publishing/access, batch 3) will
    // handle password and per-tenant access. Until that lands we refuse to
    // render non-public content rather than leak it.
    return { kind: "restricted", access };
  }

  let store: { readonly get: (key: string) => Promise<Buffer | null> };
  try {
    store = (await forWorkspace(workspaceId)) as unknown as {
      readonly get: (key: string) => Promise<Buffer | null>;
    };
  } catch (error) {
    return {
      kind: "storage_error",
      message:
        error instanceof Error
          ? error.message
          : "The object store is not available.",
    };
  }

  let draftBytes: Buffer | null;
  try {
    draftBytes = await store.get(guideDraftKey(guideId));
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(m)) return { kind: "not_found" };
    return { kind: "storage_error", message: m };
  }
  if (draftBytes === null) return { kind: "not_found" };

  let draft: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(draftBytes.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        kind: "storage_error",
        message: "The published guide draft is not a JSON object.",
      };
    }
    draft = parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {
      kind: "storage_error",
      message: "The published guide draft is not valid JSON.",
    };
  }

  const title =
    typeof draft["title"] === "string" && draft["title"].length > 0
      ? (draft["title"] as string)
      : typeof record.title === "string" && record.title.length > 0
        ? (record.title as string)
        : "Untitled guide";

  const summary =
    typeof draft["summary"] === "string" && draft["summary"].length > 0
      ? (draft["summary"] as string)
      : null;
  const introduction =
    typeof draft["introduction"] === "string" &&
    draft["introduction"].length > 0
      ? (draft["introduction"] as string)
      : null;

  const prerequisites = parseStringList(draft["prerequisites"]);
  const tips = parseStringList(draft["tips"]);
  const warnings = parseStringList(draft["warnings"]);
  const steps = parseSteps(draft["steps"]);
  const aiGenerated = draft["aiGenerated"] === true;
  const publishedAt =
    typeof record.publishedAt === "string" && record.publishedAt.length > 0
      ? record.publishedAt
      : null;

  const model: GuidePageModel = {
    slug,
    guideId,
    title,
    summary,
    introduction,
    prerequisites,
    steps,
    tips,
    warnings,
    aiGenerated,
    publishedAt,
  };
  return { kind: "rendered", model };
}

function parseStringList(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return raw.trim().length === 0 ? [] : [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item.trim());
      continue;
    }
    if (item !== null && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const text =
        typeof o["text"] === "string"
          ? o["text"]
          : typeof o["description"] === "string"
            ? o["description"]
            : typeof o["title"] === "string"
              ? o["title"]
              : null;
      if (text !== null && text.trim().length > 0) out.push(text.trim());
    }
  }
  return out;
}

function parseSteps(raw: unknown): readonly GuideStep[] {
  if (!Array.isArray(raw)) return [];
  const out: GuideStep[] = [];
  let auto = 1;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title =
      typeof e["title"] === "string" && e["title"].length > 0
        ? e["title"]
        : `Step ${auto}`;
    const description =
      typeof e["description"] === "string" ? e["description"] : "";
    const imageRef =
      typeof e["screenshotRef"] === "string"
        ? e["screenshotRef"]
        : typeof e["imageRef"] === "string"
          ? e["imageRef"]
          : null;
    const altText = typeof e["altText"] === "string" ? e["altText"] : null;
    const idxRaw = e["index"];
    const index =
      typeof idxRaw === "number" && Number.isFinite(idxRaw)
        ? Math.trunc(idxRaw)
        : auto;
    out.push({ index, title, description, imageRef, altText });
    auto += 1;
  }
  return out;
}

