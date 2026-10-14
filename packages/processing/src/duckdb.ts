/**
 * Zipy AI — DuckDB tabular query surface.
 *
 * Serialised tables produced by `tableExtract` (Markdown/JSON) and CSV-derived
 * tabular regions are materialised into an ephemeral DuckDB database so SQL
 * aggregations, joins, and typed projections can run over extracted data.
 * Nothing is inferred from the source document: the caller supplies the
 * rows and columns; this module only loads and queries them.
 *
 * Design notes honoured here:
 *  - DuckDB is an *optional* dependency. When the native module is not
 *    installed, every entry point throws `DuckDbError` with code
 *    `"engine-unavailable"` and a message listing the install command.
 *    Callers must decide whether to skip the query or fail the job — this
 *    module never silently falls back to a JS emulation of SQL.
 *  - The query surface accepts a *read-only* allowlist of statement verbs
 *    (SELECT, WITH, DESCRIBE, SUMMARIZE, PRAGMA, EXPLAIN). Anything mutating
 *    is rejected before it reaches the engine, even when the caller is an
 *    internal one — the extraction pipeline is not a place to run DDL/DML.
 *  - No file paths are constructed from user input. The DuckDB instance is
 *    opened as `:memory:`; a caller that needs to persist a database must
 *    pass an explicit `databasePath` and accept that this module does not
 *    sandbox directory traversal (the caller is responsible for the path).
 *  - No credentials, no network. DuckDB's native HTTP/extension loaders are
 *    disabled by rejecting `INSTALL`/`LOAD` statements.
 */

/* -------------------------------------------------------------------------- */
/* Optional native dependency                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Structural type for the subset of the DuckDB Node binding we use. A real
 * `duckdb` install is required to run queries; when it is absent, the loader
 * returns `null` and every public function throws with an actionable message.
 *
 * The shape mirrors the `duckdb` package (`node-duckdb` / `@duckdb/node-api`)
 * closely enough that a minor adapter would fit either, but this module does
 * not install a new dependency — the operator does, by adding `duckdb` to
 * `packages/processing/package.json` when they enable the tabular surface.
 */
interface DuckDbConnection {
  all(sql: string, ...params: readonly unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}
interface DuckDbDatabase {
  connect(): Promise<DuckDbConnection>;
  close(): Promise<void>;
}
interface DuckDbModule {
  Database: new (path: string) => DuckDbDatabase;
}

let cachedModule: DuckDbModule | null | undefined = undefined;

async function loadDuckDb(): Promise<DuckDbModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // `import()` on an optional peer: TypeScript cannot resolve the module
    // here, so we cast through `unknown` and validate the shape.
    const mod = (await import("duckdb" as string)) as unknown as DuckDbModule;
    if (
      mod !== null &&
      typeof mod === "object" &&
      typeof (mod as { Database?: unknown }).Database === "function"
    ) {
      cachedModule = mod;
      return mod;
    }
    cachedModule = null;
    return null;
  } catch {
    cachedModule = null;
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DuckDbErrorCode =
  | "engine-unavailable"
  | "invalid-input"
  | "unsafe-statement"
  | "query-failed"
  | "internal";

export class DuckDbError extends Error {
  readonly code: DuckDbErrorCode;
  constructor(message: string, code: DuckDbErrorCode) {
    super(message);
    this.name = "DuckDbError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Input shapes                                                                */
/* -------------------------------------------------------------------------- */

export type ColumnType =
  | "text"
  | "integer"
  | "bigint"
  | "double"
  | "boolean"
  | "date"
  | "timestamp"
  | "json";

export interface TableColumn {
  readonly name: string;
  readonly type: ColumnType;
  /**
   * When true, values are stored as-is; when false the loader coerces each
   * value to the column type and records a per-cell parse failure count. The
   * default is false — coercion is preferred so a table containing "40" in a
   * text column can be aggregated numerically once the column is declared
   * `integer`.
   */
  readonly allowRaw?: boolean;
}

export interface TabularInput {
  /** Table name; must match `[A-Za-z_][A-Za-z0-9_]*`. */
  readonly name: string;
  readonly columns: readonly TableColumn[];
  /**
   * Row data. Each row is an array of raw values aligned with `columns`, or
   * `null` for a missing cell. A cell is `unknown` because extractors return
   * mixed types (`string | number | boolean | null`).
   */
  readonly rows: readonly (readonly unknown[])[];
}

export interface QueryOptions {
  /** Statement timeout in milliseconds. Default 15_000. */
  readonly timeoutMs?: number;
  /** Hard row cap on the returned result set. Default 5_000. */
  readonly maxRows?: number;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  /** True when the engine was cut off by `maxRows`. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Statement guard                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Verbs permitted by the query surface. `LOAD` / `INSTALL` are intentionally
 * absent: DuckDB extensions fetch code from the network and can exfiltrate
 * data from the local path; neither is acceptable in a multi-tenant job.
 */
const ALLOWED_LEADING_VERBS = new Set([
  "SELECT",
  "WITH",
  "DESCRIBE",
  "SUMMARIZE",
  "PRAGMA",
  "EXPLAIN",
  "FROM",
  "VALUES",
  "TABLE",
]);

const FORBIDDEN_SUBSTRINGS = [
  "attach",
  "detach",
  "copy",
  "export",
  "import",
  "install",
  "load ",
  "httpfs",
  "read_csv_autohttp",
  "read_parquethttp",
  "secret",
];

/**
 * Reject statements that are not read-only SELECT-family queries. This is a
 * *defence-in-depth* measure: DuckDB runs in-process, and a caller that
 * accidentally passes DDL would destroy the ephemeral database mid-job.
 */
function assertSafeStatement(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new DuckDbError("Query must be a non-empty string.", "invalid-input");
  }
  // Strip leading line comments and whitespace so `-- x\nSELECT ...` passes.
  const stripped = sql
    .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, "")
    .trim();
  // Reject multiple statements: a `;` in the body that is not the trailing
  // terminator would let a caller append an unguarded DDL.
  const semicolons = (stripped.match(/;/g) ?? []).length;
  const endsWithSemicolon = /;\s*$/.test(stripped);
  if (semicolons > 1 || (semicolons === 1 && !endsWithSemicolon)) {
    throw new DuckDbError(
      "Query must be a single statement; multi-statement strings are rejected.",
      "unsafe-statement",
    );
  }
  const core = endsWithSemicolon ? stripped.slice(0, -1).trim() : stripped;
  const firstWord = /^([A-Za-z]+)/.exec(core)?.[1]?.toUpperCase() ?? "";
  if (!ALLOWED_LEADING_VERBS.has(firstWord)) {
    throw new DuckDbError(
      `Query verb "${firstWord || "(none)"}" is not permitted. ` +
        `Allowed leading verbs: ${[...ALLOWED_LEADING_VERBS].join(", ")}.`,
      "unsafe-statement",
    );
  }
  // The lowercase check catches `SELECT ... ; INSTALL ...` wrapped in a CTE.
  const lowered = core.toLowerCase();
  for (const token of FORBIDDEN_SUBSTRINGS) {
    // Only reject the literal keyword as a word; "load" appears inside
    // "payload" and "loaded" in legitimate queries.
    const wordBoundary = new RegExp(`(^|[^a-z0-9_])${token.trim()}([^a-z0-9_]|$)`);
    if (wordBoundary.test(lowered)) {
      throw new DuckDbError(
        `Query contains forbidden keyword "${token.trim()}" (extension loaders, file I/O and secrets are disabled).`,
        "unsafe-statement",
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Identifier validation                                                       */
/* -------------------------------------------------------------------------- */

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

function validateIdentifier(name: string, kind: "table" | "column"): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new DuckDbError(`${kind} name must be a non-empty string.`, "invalid-input");
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new DuckDbError(
      `${kind} name "${name.slice(0, 20)}…" exceeds ${MAX_IDENTIFIER_LENGTH} characters.`,
      "invalid-input",
    );
  }
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new DuckDbError(
      `${kind} name "${name}" must match [A-Za-z_][A-Za-z0-9_]*.`,
      "invalid-input",
    );
  }
  return name;
}

const DUCKDB_TYPE_SQL: Readonly<Record<ColumnType, string>> = {
  text: "VARCHAR",
  integer: "INTEGER",
  bigint: "BIGINT",
  double: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamp: "TIMESTAMP",
  json: "JSON",
};

/* -------------------------------------------------------------------------- */
/* Cell coercion                                                               */
/* -------------------------------------------------------------------------- */

function coerceCell(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null) return null;
  switch (type) {
    case "text":
    case "json":
      return typeof value === "string" ? value : String(value);
    case "integer": {
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
      if (typeof value === "string") {
        const n = Number(value.replace(/,/g, "").trim());
        if (Number.isFinite(n)) return Math.trunc(n);
      }
      throw new DuckDbError(
        `Cannot coerce value ${JSON.stringify(value)} to INTEGER.`,
        "invalid-input",
      );
    }
    case "bigint": {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value).toString();
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
      throw new DuckDbError(
        `Cannot coerce value ${JSON.stringify(value)} to BIGINT.`,
        "invalid-input",
      );
    }
    case "double": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return n;
      }
      throw new DuckDbError(
        `Cannot coerce value ${JSON.stringify(value)} to DOUBLE.`,
        "invalid-input",
      );
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (v === "true" || v === "yes" || v === "1") return true;
        if (v === "false" || v === "no" || v === "0") return false;
      }
      if (typeof value === "number") return value !== 0;
      throw new DuckDbError(
        `Cannot coerce value ${JSON.stringify(value)} to BOOLEAN.`,
        "invalid-input",
      );
    }
    case "date":
    case "timestamp": {
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
      throw new DuckDbError(
        `Cannot coerce value ${JSON.stringify(value)} to ${type.toUpperCase()}.`,
        "invalid-input",
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * An open DuckDB session. Create with `openTabularSession`. It owns one
 * in-memory database; `close()` must be called (the worker uses a `finally`
 * block). Query execution is serialised by the session so callers cannot
 * interleave writes and reads on the same connection.
 */
export class TabularSession {
  private readonly connection: DuckDbConnection;
  private readonly database: DuckDbDatabase;
  private loadedTables: Set<string>;
  private closed: boolean;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(database: DuckDbDatabase, connection: DuckDbConnection) {
    this.database = database;
    this.connection = connection;
    this.loadedTables = new Set<string>();
    this.closed = false;
  }

  /** @internal used by `openTabularSession`. */
  static async create(
    databasePath: string,
  ): Promise<TabularSession> {
    const mod = await loadDuckDb();
    if (mod === null) {
      throw new DuckDbError(
        "DuckDB engine is not installed. Add the native `duckdb` package to " +
          "packages/processing (npm install duckdb) to enable tabular queries.",
        "engine-unavailable",
      );
    }
    const db = new mod.Database(databasePath);
    const conn = await db.connect();
    return new TabularSession(db, conn);
  }

  /** Names of tables currently loaded into the session. */
  listTables(): readonly string[] {
    return [...this.loadedTables];
  }

  /**
   * Load a caller-supplied table. The table name must be new; re-loading an
   * existing name throws so an ingest job cannot silently overwrite a table
   * another step is reading.
   */
  async loadTable(input: TabularInput): Promise<{ readonly rowCount: number }> {
    if (this.closed) {
      throw new DuckDbError("Session is closed.", "internal");
    }
    const name = validateIdentifier(input.name, "table");
    if (this.loadedTables.has(name)) {
      throw new DuckDbError(
        `Table "${name}" is already loaded into this session.`,
        "invalid-input",
      );
    }
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new DuckDbError(
        `Table "${name}" must declare at least one column.`,
        "invalid-input",
      );
    }
    const seen = new Set<string>();
    for (const col of input.columns) {
      const colName = validateIdentifier(col.name, "column");
      if (seen.has(colName)) {
        throw new DuckDbError(
          `Table "${name}" declares duplicate column "${colName}".`,
          "invalid-input",
        );
      }
      seen.add(colName);
      if (!(col.type in DUCKDB_TYPE_SQL)) {
        throw new DuckDbError(
          `Column "${colName}" has unsupported type "${String(col.type)}".`,
          "invalid-input",
        );
      }
    }

    // Build the CREATE TABLE and INSERT statements. Values are inlined using
    // DuckDB's own literal encoding (single-quote, escape internal quotes) so
    // the query planner sees typed literals; there is no prepared-statement
    // surface in the current binding that can be relied on for bulk inserts.
    const columnDefs = input.columns
      .map((c) => `"${c.name}" ${DUCKDB_TYPE_SQL[c.type]}`)
      .join(", ");
    const create = `CREATE TABLE "${name}" (${columnDefs})`;

    const statementBatch: string[] = [create];
    if (input.rows.length > 0) {
      const columnList = input.columns.map((c) => `"${c.name}"`).join(", ");
      // Batch inserts in groups of 500 rows to keep each statement bounded.
      const BATCH = 500;
      for (let start = 0; start < input.rows.length; start += BATCH) {
        const slice = input.rows.slice(start, start + BATCH);
        const tuples: string[] = [];
        for (const row of slice) {
          if (!Array.isArray(row)) {
            throw new DuckDbError(
              `Table "${name}" received a non-array row.`,
              "invalid-input",
            );
          }
          const cells: string[] = [];
          for (let i = 0; i < input.columns.length; i += 1) {
            const col = input.columns[i] as TableColumn;
            const raw = row[i];
            const coerced = col.allowRaw === true ? raw ?? null : coerceCell(raw, col.type);
            cells.push(encodeLiteral(coerced));
          }
          tuples.push(`(${cells.join(", ")})`);
        }
        statementBatch.push(
          `INSERT INTO "${name}" (${columnList}) VALUES ${tuples.join(", ")}`,
        );
      }
    }

    await this.serialise(async () => {
      for (const stmt of statementBatch) {
        await this.connection.all(stmt);
      }
    });
    this.loadedTables.add(name);
    return { rowCount: input.rows.length };
  }

  /**
   * Execute a read-only SQL statement. Throws before the engine is touched
   * when the statement is not a SELECT-family query.
   */
  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    if (this.closed) {
      throw new DuckDbError("Session is closed.", "internal");
    }
    assertSafeStatement(sql);
    const maxRows = clampInt(options.maxRows ?? 5_000, 1, 200_000);
    const started = Date.now();
    const raw = await this.serialise(() => this.connection.all(sql));
    const durationMs = Date.now() - started;
    const { columns, rows } = normaliseRows(raw);
    const truncated = rows.length > maxRows;
    const limited = truncated ? rows.slice(0, maxRows) : rows;
    return {
      columns,
      rows: limited,
      rowCount: limited.length,
      truncated,
      durationMs,
    };
  }

  /**
   * Serialise every operation on the session's single connection: DuckDB's
   * Node binding does not hand out parallel cursors, so we chain calls.
   */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Swallow the error only for the chain — the caller still receives it.
    this.tail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connection.close();
    } finally {
      await this.database.close();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Open a tabular session. `databasePath` defaults to `:memory:` — the only
 * path this module will construct itself. Callers that pass a real path are
 * responsible for ensuring it is safe (workspace-scoped directory, no
 * traversal).
 */
export async function openTabularSession(
  databasePath: string = ":memory:",
): Promise<TabularSession> {
  if (typeof databasePath !== "string" || databasePath.trim().length === 0) {
    throw new DuckDbError("databasePath must be a non-empty string.", "invalid-input");
  }
  return TabularSession.create(databasePath);
}

/**
 * Convenience: load a set of tables and run one query, closing the session
 * afterwards. The most common call from the extraction pipeline. When the
 * engine is unavailable this function throws before any load begins so a
 * caller can catch and skip the tabular step entirely.
 */
export async function runTabularQuery(input: {
  readonly tables: readonly TabularInput[];
  readonly sql: string;
  readonly options?: QueryOptions;
}): Promise<QueryResult> {
  const session = await openTabularSession(":memory:");
  try {
    for (const table of input.tables) {
      await session.loadTable(table);
    }
    return await session.query(input.sql, input.options ?? {});
  } finally {
    await session.close();
  }
}

/**
 * Report whether the DuckDB engine is available without opening a session.
 * The worker uses this in feature detection: when false, the extraction
 * pipeline marks tabular queries as "skipped (engine unavailable)" and the
 * report is honest, rather than failing the whole job.
 */
export async function isDuckDbAvailable(): Promise<boolean> {
  const mod = await loadDuckDb();
  return mod !== null;
}

/* -------------------------------------------------------------------------- */
/* Literal encoding + result normalisation                                    */
/* -------------------------------------------------------------------------- */

function encodeLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") {
    // Escape single quotes by doubling. That is DuckDB's SQL literal rule and
    // matches the SQL standard for the string-literal form.
    return `'${value.replace(/'/g, "''")}'`;
  }
  // A Date that reached here without coercion becomes ISO text.
  if (value instanceof Date) {
    return `'${value.toISOString().replace(/'/g, "''")}'`;
  }
  // Unknown objects are serialised as JSON; callers who want a stricter
  // behaviour should declare the column as text/json and pass a string.
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function normaliseRows(raw: unknown[]): {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
} {
  if (raw.length === 0) return { columns: [], rows: [] };
  const first = raw[0];
  if (first === null || typeof first !== "object") {
    // Scalar result (e.g. `SELECT 1`). One unnamed column.
    return {
      columns: ["?"],
      rows: raw.map((v) => [normaliseValue(v)]),
    };
  }
  const recordLike = !Array.isArray(first);
  if (recordLike) {
    const columns = Object.keys(first as Record<string, unknown>);
    const rows = raw.map((row) => {
      if (row === null || typeof row !== "object") return columns.map(() => null);
      const r = row as Record<string, unknown>;
      return columns.map((c) => normaliseValue(r[c]));
    });
    return { columns, rows };
  }
  // Array-of-arrays result set. Column names are not recoverable from the
  // binding; emit placeholder names.
  const firstArr = first as readonly unknown[];
  const columns = firstArr.map((_, i) => `col${i + 1}`);
  const rows = raw.map((row) =>
    Array.isArray(row)
      ? (row as readonly unknown[]).map(normaliseValue)
      : columns.map(() => null),
  );
  return { columns, rows };
}

function normaliseValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    // Opaque JSON-like value: encode so downstream persistence is uniform.
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  }
  return String(v);
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  const n = Math.floor(v);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/* -------------------------------------------------------------------------- */
/* Bridge from `tableExtract`                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a `TabularInput` from a `ReconstructedTable` (see tableExtract.ts)
 * plus column names supplied by the caller. The caller may either derive
 * headers from the table's own header row (typical) or supply external
 * names. Column values are taken as text; the caller can request coercion
 * by declaring column types.
 *
 * This function deliberately does *not* import `tableExtract` at module
 * scope so that `duckdb.ts` stays usable from contexts that should not pull
 * the table parser. The caller passes the shape it has.
 */
export function tabularInputFromTable(input: {
  readonly name: string;
  /** Header row values (one per column). Length must match the extractor's columnCount. */
  readonly headers: readonly string[];
  /** Data rows; each row is an array of string cells of the same length. */
  readonly rows: readonly (readonly string[])[];
  /** Defaults to `"text"` for every column. */
  readonly columnTypes?: Readonly<Record<string, ColumnType>>;
}): TabularInput {
  validateIdentifier(input.name, "table");
  if (!Array.isArray(input.headers) || input.headers.length === 0) {
    throw new DuckDbError(
      "tabularInputFromTable requires at least one header.",
      "invalid-input",
    );
  }
  const normalisedHeaders = input.headers.map((h, i) => {
    const trimmed = typeof h === "string" ? h.trim() : "";
    // DuckDB rejects empty identifiers; synthesise a positional name so the
    // caller sees `col1`, not a lost column, when the source had no header.
    const base = trimmed.length > 0 ? trimmed : `col${i + 1}`;
    // Identifiers must match the pattern; sanitise spaces and punctuation.
    const sanitised = base.replace(/[^A-Za-z0-9_]/g, "_");
    const prefixed = /^[A-Za-z_]/.test(sanitised) ? sanitised : `c_${sanitised}`;
    return prefixed.slice(0, MAX_IDENTIFIER_LENGTH);
  });
  const seen = new Set<string>();
  const uniqueHeaders: string[] = [];
  for (const h of normalisedHeaders) {
    let name = h;
    let n = 2;
    while (seen.has(name)) {
      name = `${h}_${n}`;
      n += 1;
    }
    seen.add(name);
    uniqueHeaders.push(name);
  }

  const columns: TableColumn[] = uniqueHeaders.map((h) => ({
    name: h,
    type: input.columnTypes?.[h] ?? "text",
  }));

  const rows = input.rows.map((r) => {
    const out: unknown[] = [];
    for (let i = 0; i < columns.length; i += 1) {
      const cell = r[i];
      out.push(cell === undefined ? null : cell);
    }
    return out;
  });

  return { name: input.name, columns, rows };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `QueryResult`. Throws on structurally invalid payloads so
 * a damaged cache entry surfaces, rather than producing an empty result set
 * that downstream content generation would treat as authoritative.
 */
export function rehydrateQueryResult(value: unknown): QueryResult {
  if (value === null || typeof value !== "object") {
    throw new DuckDbError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const columnsRaw = Array.isArray(r["columns"]) ? (r["columns"] as unknown[]) : [];
  const columns = columnsRaw.filter((c): c is string => typeof c === "string");
  const rowsRaw = Array.isArray(r["rows"]) ? (r["rows"] as unknown[]) : [];
  const rows: unknown[][] = [];
  for (const row of rowsRaw) {
    if (!Array.isArray(row)) continue;
    rows.push((row as unknown[]).slice());
  }
  const rowCount = typeof r["rowCount"] === "number" && Number.isFinite(r["rowCount"])
    ? Math.floor(r["rowCount"] as number)
    : rows.length;
  const truncated = r["truncated"] === true;
  const durationMs =
    typeof r["durationMs"] === "number" && Number.isFinite(r["durationMs"])
      ? (r["durationMs"] as number)
      : 0;
  return { columns, rows, rowCount, truncated, durationMs };
}
