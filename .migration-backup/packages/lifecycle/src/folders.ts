/**
 * Zipy AI — folder tree for guides and workflows (phase 24, batch 1).
 *
 * The dashboard groups guides into folders, and folders can be nested. This
 * module is the folder model: it validates names and paths, prevents cycles
 * when moving a folder under one of its own descendants, and provides the
 * tree shape the dashboard renders.
 *
 * Design boundaries:
 *
 *  - The module is *pure*. It does not read or write the database; a
 *    persistence layer above it (the guides/lifecycle phase 24 route surface,
 *    or a repository in a later phase) loads the flat rows and calls
 *    `buildFolderTree` / `validateMove` / `planMove` to decide what to write.
 *    This keeps the tree logic testable without a database.
 *
 *  - Multi-tenant by construction. Every folder carries `workspaceId`; a
 *    tree is built for exactly one workspace and the builder refuses to
 *    merge folders from another. The persistence layer's RBAC scoping is
 *    the source of truth, but the model matches so a mistake in the caller
 *    surfaces as a typed error rather than a cross-workspace leak.
 *
 *  - Paths are derived, not stored. A folder's human path is computed from
 *    its ancestor chain so renaming a parent automatically updates the paths
 *    its children display. No path column is invented here; if a later phase
 *    denormalises it, that is the persistence layer's decision.
 *
 *  - Names are constrained. Two folders with the same parent and the same
 *    name are rejected as `duplicate-name` so the dashboard is unambiguous.
 *    Names are trimmed and length-bounded; slashes are disallowed because
 *    the path separator is `/`.
 *
 *  - Cycles are refused explicitly. Moving a folder under one of its own
 *    descendants would orphan a subtree; `validateMove` refuses with a
 *    typed `cycle` error naming the offending chain.
 *
 *  - Deterministic ordering. `buildFolderTree` sorts siblings by
 *    (position, name, id) so a re-render does not reshuffle the list.
 *
 * The module exports:
 *   - `normaliseFolderName`, `validateFolderName` — the name rules.
 *   - `buildFolderTree` — flat rows -> tree for the dashboard.
 *   - `flattenFolderTree` — the inverse, stable DFS order.
 *   - `folderPath` — the human path for a folder id.
 *   - `validateMove`, `planMove` — a caller decides what to update.
 *   - `rehydrateFolder` — typed load of a persisted row.
 *   - Typed errors and constants.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type FolderErrorCode =
  | "invalid-input"
  | "empty-name"
  | "name-too-long"
  | "name-contains-slash"
  | "duplicate-name"
  | "unknown-parent"
  | "unknown-folder"
  | "workspace-mismatch"
  | "cycle";

export class FolderError extends Error {
  readonly code: FolderErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FolderErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "FolderError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                 */
/* -------------------------------------------------------------------------- */

/** The persisted shape of one folder. No path, no child array — those are derived. */
export interface FolderRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly name: string;
  /**
   * Sort key within the parent; lower sorts first. Ties fall back to
   * comparing names, then ids, so the order is deterministic even when the
   * dashboard has not yet computed a position.
   */
  readonly position: number;
  /** Optional description shown in the dashboard's detail pane. */
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A folder with its derived children, ready for the dashboard. */
export interface FolderNode extends FolderRow {
  readonly children: readonly FolderNode[];
  /** Slash-joined ancestor names; empty string for a top-level folder. */
  readonly path: string;
  /**
   * The number of descendant folders (excluding self). Precomputed because
   * the dashboard renders "12 guides" style counts without recursing.
   */
  readonly descendantCount: number;
  /** The depth from the root: 0 for a top-level folder, 1 for its child, etc. */
  readonly depth: number;
}

export interface FolderTree {
  readonly version: "folder-tree/1";
  readonly workspaceId: string;
  /** Top-level folders, in `buildFolderTree` order. */
  readonly roots: readonly FolderNode[];
  /** All nodes keyed by id, in a flat map, for lookups without traversal. */
  readonly byId: ReadonlyMap<string, FolderNode>;
  /** Total folder count in the tree. */
  readonly size: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

export const FOLDER_MAX_NAME_LENGTH = 80;

/**
 * Reserved names the dashboard uses as virtual folders; a real folder with
 * one of these names would collide with the UI.
 */
export const FOLDER_RESERVED_NAMES: readonly string[] = Object.freeze([
  "uncategorised",
  "uncategorized",
  "all guides",
  "archive",
]);

/* -------------------------------------------------------------------------- */
/* Name handling                                                               */
/* -------------------------------------------------------------------------- */

export function normaliseFolderName(raw: string): string {
  if (typeof raw !== "string") {
    throw new FolderError("Folder name must be a string.", "invalid-input");
  }
  return raw.trim().replace(/\s+/g, " ");
}

export function validateFolderName(raw: string): string {
  const name = normaliseFolderName(raw);
  if (name.length === 0) {
    throw new FolderError("Folder name is empty after trimming.", "empty-name");
  }
  if (name.length > FOLDER_MAX_NAME_LENGTH) {
    throw new FolderError(
      `Folder name is ${name.length} characters; the maximum is ${FOLDER_MAX_NAME_LENGTH}.`,
      "name-too-long",
      { length: name.length, max: FOLDER_MAX_NAME_LENGTH },
    );
  }
  if (name.includes("/")) {
    throw new FolderError(
      "Folder names may not contain '/'. The path separator is reserved.",
      "name-contains-slash",
    );
  }
  return name;
}

/* -------------------------------------------------------------------------- */
/* Tree building                                                               */
/* -------------------------------------------------------------------------- */

export function buildFolderTree(
  workspaceId: string,
  rows: readonly FolderRow[],
): FolderTree {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new FolderError("buildFolderTree requires a workspaceId.", "invalid-input");
  }
  if (!Array.isArray(rows)) {
    throw new FolderError("buildFolderTree requires an array of rows.", "invalid-input");
  }

  // Reject any row that belongs to a different workspace; a caller who
  // accidentally passed another workspace's rows must not get a merged tree.
  for (const row of rows) {
    if (row.workspaceId !== workspaceId) {
      throw new FolderError(
        `Folder "${row.id}" belongs to workspace "${row.workspaceId}", not "${workspaceId}".`,
        "workspace-mismatch",
        { folderId: row.id, expected: workspaceId, got: row.workspaceId },
      );
    }
  }

  const byId = new Map<string, FolderRow>();
  for (const row of rows) {
    if (byId.has(row.id)) {
      throw new FolderError(
        `Duplicate folder id "${row.id}".`,
        "invalid-input",
        { folderId: row.id },
      );
    }
    byId.set(row.id, row);
  }

  // Validate parent pointers and the (parent, name) uniqueness constraint.
  const childNames = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.parentId !== null && !byId.has(row.parentId)) {
      throw new FolderError(
        `Folder "${row.id}" names parent "${row.parentId}", which is not present in the input.`,
        "unknown-parent",
        { folderId: row.id, parentId: row.parentId },
      );
    }
    const siblingKey = row.parentId ?? "";
    let names = childNames.get(siblingKey);
    if (names === undefined) {
      names = new Set<string>();
      childNames.set(siblingKey, names);
    }
    const nameKey = row.name.toLowerCase();
    if (names.has(nameKey)) {
      throw new FolderError(
        `Two folders under parent "${row.parentId ?? "<root>"}" share the name "${row.name}".`,
        "duplicate-name",
        { parentId: row.parentId, name: row.name },
      );
    }
    names.add(nameKey);
  }

  // Group children by parent.
  const childrenByParent = new Map<string | null, FolderRow[]>();
  for (const row of rows) {
    const key = row.parentId;
    let bucket = childrenByParent.get(key);
    if (bucket === undefined) {
      bucket = [];
      childrenByParent.set(key, bucket);
    }
    bucket.push(row);
  }
  for (const bucket of childrenByParent.values()) {
    bucket.sort(compareRows);
  }

  // Detect cycles. A cycle among rows produces a tree with no roots for the
  // cycle's members; walking from each root reaches only a subset, so we
  // count reachable nodes and compare.
  const reachable = new Set<string>();
  const nodeById = new Map<string, FolderNode>();

  const buildSubtree = (
    row: FolderRow,
    depth: number,
    ancestorPath: string,
    ancestors: Set<string>,
  ): FolderNode => {
    if (ancestors.has(row.id)) {
      throw new FolderError(
        `Cycle detected: folder "${row.id}" is its own ancestor via "${ancestorPath}".`,
        "cycle",
        { folderId: row.id, chain: ancestorPath },
      );
    }
    ancestors.add(row.id);
    reachable.add(row.id);
    const path = ancestorPath.length > 0 ? `${ancestorPath}/${row.name}` : row.name;
    const childRows = childrenByParent.get(row.id) ?? [];
    const childNodes: FolderNode[] = [];
    for (const child of childRows) {
      childNodes.push(buildSubtree(child, depth + 1, path, ancestors));
    }
    const descendantCount = countDescendants(childNodes);
    const node: FolderNode = Object.freeze({
      ...row,
      children: Object.freeze(childNodes),
      path,
      descendantCount,
      depth,
    });
    ancestors.delete(row.id);
    nodeById.set(row.id, node);
    return node;
  };

  const roots: FolderNode[] = [];
  const rootRows = childrenByParent.get(null) ?? [];
  for (const rootRow of rootRows) {
    roots.push(buildSubtree(rootRow, 0, "", new Set<string>()));
  }

  if (reachable.size !== rows.length) {
    // Some rows are unreachable from any root: they are in a cycle or hang
    // off a cycle. Name one for the operator.
    const orphans = rows.filter((r) => !reachable.has(r.id)).map((r) => r.id);
    throw new FolderError(
      `Folders are not reachable from a root: ${orphans.join(", ")}. This indicates a parent/child cycle.`,
      "cycle",
      { orphanIds: orphans },
    );
  }

  return Object.freeze({
    version: "folder-tree/1",
    workspaceId,
    roots: Object.freeze(roots),
    byId: nodeById,
    size: rows.length,
  });
}

/**
 * The inverse of `buildFolderTree`: a stable depth-first order of every node.
 * Useful for a flat list UI or for re-persisting after a bulk operation.
 */
export function flattenFolderTree(tree: FolderTree): readonly FolderNode[] {
  if (tree === null || typeof tree !== "object" || tree.version !== "folder-tree/1") {
    throw new FolderError(
      'flattenFolderTree requires a FolderTree (version "folder-tree/1").',
      "invalid-input",
    );
  }
  const out: FolderNode[] = [];
  const visit = (n: FolderNode): void => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const r of tree.roots) visit(r);
  return Object.freeze(out);
}

/** The slash-joined path for a folder id, or throws `unknown-folder`. */
export function folderPath(tree: FolderTree, folderId: string): string {
  const node = tree.byId.get(folderId);
  if (node === undefined) {
    throw new FolderError(`No folder with id "${folderId}".`, "unknown-folder", { folderId });
  }
  return node.path;
}

/* -------------------------------------------------------------------------- */
/* Move validation                                                             */
/* -------------------------------------------------------------------------- */

export interface FolderMove {
  readonly folderId: string;
  readonly newParentId: string | null;
  /** Optional new name; omitting or passing the same name is a no-op for the name. */
  readonly newName?: string;
}

export interface ValidatedFolderMove {
  readonly folderId: string;
  readonly previousParentId: string | null;
  readonly newParentId: string | null;
  readonly previousName: string;
  readonly newName: string;
  /** The path the folder will have after the move; for the caller's audit log. */
  readonly newPath: string;
}

/**
 * Check a move against the flat row set. Throws a typed error when the move
 * would produce a cycle, collide with a sibling name, or reference an
 * unknown folder. Returns a `ValidatedFolderMove` the caller can persist.
 *
 * The function does not itself persist anything; a lifecycle persistence
 * layer converts the return value into an UPDATE (or a transaction that
 * moves a subtree).
 */
export function validateMove(
  rows: readonly FolderRow[],
  move: FolderMove,
): ValidatedFolderMove {
  if (move === null || typeof move !== "object") {
    throw new FolderError("validateMove requires a move descriptor.", "invalid-input");
  }
  if (typeof move.folderId !== "string" || move.folderId.length === 0) {
    throw new FolderError("`folderId` is required.", "invalid-input");
  }
  const byId = new Map<string, FolderRow>();
  for (const r of rows) byId.set(r.id, r);
  const folder = byId.get(move.folderId);
  if (folder === undefined) {
    throw new FolderError(
      `Cannot move folder "${move.folderId}": it is not present.`,
      "unknown-folder",
      { folderId: move.folderId },
    );
  }
  if (move.newParentId !== null && move.newParentId !== undefined) {
    if (!byId.has(move.newParentId)) {
      throw new FolderError(
        `Cannot move folder "${move.folderId}" under "${move.newParentId}": the parent folder is not present.`,
        "unknown-parent",
        { parentId: move.newParentId },
      );
    }
    if (move.newParentId === move.folderId) {
      throw new FolderError(
        `Cannot move folder "${move.folderId}" into itself.`,
        "cycle",
        { folderId: move.folderId },
      );
    }
    // Walk up from the new parent; if we reach the folder being moved, the
    // move would place the folder under its own descendant.
    let cursor: string | null = move.newParentId;
    const chain: string[] = [];
    while (cursor !== null) {
      chain.push(cursor);
      if (cursor === move.folderId) {
        throw new FolderError(
          `Cannot move folder "${move.folderId}" under its own descendant (chain: ${chain.reverse().join(" -> ")}).`,
          "cycle",
          { folderId: move.folderId, chain },
        );
      }
      const current: FolderRow | undefined = byId.get(cursor);
      cursor = current === undefined ? null : current.parentId;
    }
  }

  const newNameRaw = move.newName !== undefined ? move.newName : folder.name;
  const newName = validateFolderName(newNameRaw);
  const newParentId = move.newParentId ?? null;

  // Sibling-name collision check against the destination parent.
  for (const r of rows) {
    if (r.id === folder.id) continue;
    if (r.parentId === newParentId && r.name.toLowerCase() === newName.toLowerCase()) {
      throw new FolderError(
        `A folder named "${newName}" already exists under "${newParentId ?? "<root>"}".`,
        "duplicate-name",
        { parentId: newParentId, name: newName, conflictingFolderId: r.id },
      );
    }
  }

  const newPath = computeNewPath(byId, newParentId, newName);
  return Object.freeze({
    folderId: folder.id,
    previousParentId: folder.parentId,
    newParentId,
    previousName: folder.name,
    newName,
    newPath,
  });
}

/**
 * Build the list of rows to persist after a batch of moves. Each move is
 * validated independently; because validation is against the caller's
 * original row set (not the intermediate one), a caller applying the
 * returned list must do so in a single transaction. Moves that do not
 * change a folder (same parent, same name) are omitted from the output.
 */
export function planMove(
  rows: readonly FolderRow[],
  moves: readonly FolderMove[],
): readonly ValidatedFolderMove[] {
  if (!Array.isArray(moves)) {
    throw new FolderError("planMove requires an array of moves.", "invalid-input");
  }
  const out: ValidatedFolderMove[] = [];
  const touched = new Set<string>();
  for (const move of moves) {
    if (touched.has(move.folderId)) {
      throw new FolderError(
        `Folder "${move.folderId}" appears in more than one move in the same batch.`,
        "invalid-input",
        { folderId: move.folderId },
      );
    }
    touched.add(move.folderId);
    const validated = validateMove(rows, move);
    const unchanged =
      validated.previousParentId === validated.newParentId &&
      validated.previousName === validated.newName;
    if (!unchanged) out.push(validated);
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateFolder(value: unknown): FolderRow {
  if (value === null || typeof value !== "object") {
    throw new FolderError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : "";
  const workspaceId = typeof r["workspaceId"] === "string" ? r["workspaceId"] : "";
  if (id.length === 0 || workspaceId.length === 0) {
    throw new FolderError(
      "Rehydrate failed: `id` and `workspaceId` are required.",
      "invalid-input",
    );
  }
  const parentRaw = r["parentId"];
  const parentId = parentRaw === null || parentRaw === undefined ? null : String(parentRaw);
  return Object.freeze({
    id,
    workspaceId,
    parentId,
    name: validateFolderName(typeof r["name"] === "string" ? r["name"] : ""),
    position:
      typeof r["position"] === "number" && Number.isFinite(r["position"])
        ? r["position"]
        : 0,
    description: typeof r["description"] === "string" ? r["description"] : null,
    createdAt: typeof r["createdAt"] === "string" ? r["createdAt"] : "",
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function compareRows(a: FolderRow, b: FolderRow): number {
  if (a.position !== b.position) return a.position - b.position;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function countDescendants(nodes: readonly FolderNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count += 1 + n.descendantCount;
  }
  return count;
}

function computeNewPath(
  byId: Map<string, FolderRow>,
  parentId: string | null,
  name: string,
): string {
  if (parentId === null) return name;
  const parts: string[] = [name];
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) {
      // Defensive: a cycle should have been caught by the caller, but
      // walking the parent chain must not loop forever.
      break;
    }
    seen.add(cursor);
    const row: FolderRow | undefined = byId.get(cursor);
    if (row === undefined) break;
    parts.unshift(row.name);
    cursor = row.parentId;
  }
  return parts.join("/");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  compareRows,
  countDescendants,
  computeNewPath,
});
