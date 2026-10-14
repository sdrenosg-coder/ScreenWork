/**
 * Zipy AI — Notion integration adapter (phase 21, batch 3).
 *
 * Publishes a Zipy AI guide into a Notion page, either as a new page in a
 * database or as a child page of an existing page. Both surfaces exist
 * because Notion's data model distinguishes them: a database row has typed
 * properties and Notion *requires* that a page in a database supply every
 * non-nullable property; a child page has none of those requirements.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. When the integration token is absent,
 *    every send throws `IntegrationError` with `code: "not-configured"`
 *    listing the environment variable the operator must supply.
 *
 *  - No HTTP implementation is embedded. The caller supplies a
 *    `Transport` (typically `globalThis.fetch`). This keeps the adapter
 *    testable and routes Notion traffic through the workspace's proxy
 *    when one is configured.
 *
 *  - No page id is invented. A caller supplies the parent (database id or
 *    page id); the adapter never guesses. When the parent is a database,
 *    the caller supplies the property map explicitly — the adapter does
 *    not infer a title property name, because the title property name is
 *    user-configurable per database and guessing produces a 400 that is
 *    hard for a reviewer to debug.
 *
 *  - Blocks are typed and versioned. The `NotionBlock` union covers the
 *    subset Zipy AI actually emits (paragraph, heading, bulleted/numbered
 *    list, quote, code, image, divider). A caller that needs a richer
 *    block uses `appendRawBlocks` and passes a payload the platform
 *    cannot itself validate — a deliberately loud escape hatch rather
 *    than a silent one.
 *
 *  - No OAuth. Notion's public integration requires an integration token
 *    the customer creates in their Notion workspace (Settings >
 *    Connections > Develop or manage integrations). The adapter does not
 *    implement OAuth because that requires a public callback URL, a
 *    real Notion app registration, and a redirect — an external setup
 *    the customer performs, not something this adapter silently does.
 *
 *  - Errors are surfaced verbatim. Notion returns a structured error
 *    (`{object: "error", status, code, message}`); the adapter re-raises
 *    the code and message so a reviewer sees what Notion actually said.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type NotionErrorCode =
  | "invalid-input"
  | "not-configured"
  | "transport-failure"
  | "notion-rejected"
  | "rate-limited";

export class NotionIntegrationError extends Error {
  readonly code: NotionErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    code: NotionErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "NotionIntegrationError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type NotionTransport = (input: {
  readonly url: string;
  readonly method: "POST" | "PATCH" | "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}>;

/**
 * A rich-text span. Notion's `rich_text` array is always an array even
 * for a single run; this type mirrors that so a caller sets bold/italic
 * once and the adapter does not need a parallel plain/rich distinction.
 */
export interface NotionRichText {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
  readonly linkUrl?: string | null;
}

export type NotionBlock =
  | { readonly type: "paragraph"; readonly richText: readonly NotionRichText[] }
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3;
      readonly richText: readonly NotionRichText[];
    }
  | {
      readonly type: "bulleted_list_item";
      readonly richText: readonly NotionRichText[];
    }
  | {
      readonly type: "numbered_list_item";
      readonly richText: readonly NotionRichText[];
    }
  | { readonly type: "quote"; readonly richText: readonly NotionRichText[] }
  | {
      readonly type: "code";
      readonly richText: readonly NotionRichText[];
      readonly language: string;
    }
  | {
      readonly type: "image";
      /** A URL the caller has made publicly fetchable; Notion fetches it. */
      readonly url: string;
      readonly caption?: string | null;
      readonly alt?: string | null;
    }
  | { readonly type: "divider" };

/**
 * The parent of a new page. Notion distinguishes these two cases; the
 * adapter refuses a database parent that does not supply a properties
 * map with a `title`-typed property, because Notion's API rejects such a
 * create without a clear error.
 */
export type NotionParent =
  | { readonly kind: "database"; readonly databaseId: string }
  | { readonly kind: "page"; readonly pageId: string };

export interface NotionPageDraft {
  readonly parent: NotionParent;
  /** The page's title. For a database parent this sets the title property. */
  readonly title: string;
  /**
   * For a database parent, the additional property values. The adapter
   * merges in the title under the key the caller names in
   * `titlePropertyName`. Every value is passed to Notion verbatim.
   */
  readonly properties?: Readonly<Record<string, unknown>>;
  /**
   * The name of the title property in the destination database. Required
   * when the parent is a database. Notion's default is "Name", but a
   * database can rename it, so the adapter never assumes.
   */
  readonly titlePropertyName?: string;
  /** The blocks to append after creation, in order. */
  readonly blocks?: readonly NotionBlock[];
}

export interface NotionPageDelivery {
  readonly ok: true;
  readonly pageId: string;
  readonly pageUrl: string | null;
  readonly createdTime: string | null;
  /** The exact JSON body the adapter sent for the create call. */
  readonly payloadJson: string;
  readonly httpStatus: number;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface NotionAuthFromEnv {
  readonly integrationToken: string | null;
  readonly defaultParentDatabaseId: string | null;
  readonly defaultParentPageId: string | null;
}

export function readNotionEnv(
  source: Readonly<Record<string, string | undefined>>,
): NotionAuthFromEnv {
  return {
    integrationToken: nonEmpty(source["NOTION_INTEGRATION_TOKEN"]),
    defaultParentDatabaseId: nonEmpty(source["NOTION_DEFAULT_DATABASE_ID"]),
    defaultParentPageId: nonEmpty(source["NOTION_DEFAULT_PAGE_ID"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class NotionAdapter {
  private readonly token: string;
  private readonly transport: NotionTransport;
  private readonly apiBaseUrl: string;
  private readonly notionVersion: string;
  private readonly timeoutMs: number;

  /** @internal — construct via `createNotionAdapter`. */
  constructor(input: {
    readonly token: string;
    readonly transport: NotionTransport;
    readonly timeoutMs?: number;
    /** Override the Notion-Version header for a pinned API version. */
    readonly notionVersion?: string;
    /** Override the API base URL (a Notion-compatible proxy). */
    readonly apiBaseUrl?: string;
  }) {
    this.token = input.token;
    this.transport = input.transport;
    // Pin the Notion version. Notion's API is actively versioned and a
    // change in the pinned header can change the shape of the response;
    // the operator upgrades deliberately by setting the env var.
    this.notionVersion = nonEmpty(input.notionVersion ?? null) ?? "2022-06-28";
    this.apiBaseUrl = (input.apiBaseUrl ?? "https://api.notion.com/v1").replace(/\/+$/, "");
    this.timeoutMs =
      typeof input.timeoutMs === "number" &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : 20_000;
  }

  /** The API base URL and Notion-Version header the adapter uses. */
  get apiConfiguration(): { readonly baseUrl: string; readonly version: string } {
    return { baseUrl: this.apiBaseUrl, version: this.notionVersion };
  }

  /**
   * Create a Notion page and, when `blocks` is supplied, append them.
   * Notion's create endpoint accepts a `children` array up to a documented
   * limit (100 blocks per request in the current API); a longer block
   * list is appended in batches after the create. The adapter handles the
   * batching so a caller does not need to.
   */
  async createPage(draft: NotionPageDraft): Promise<NotionPageDelivery> {
    if (draft === null || typeof draft !== "object") {
      throw new NotionIntegrationError("`draft` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.title)) {
      throw new NotionIntegrationError("`draft.title` is required.", "invalid-input");
    }
    if (draft.parent === null || typeof draft.parent !== "object") {
      throw new NotionIntegrationError(
        "`draft.parent` is required; supply a database or page parent.",
        "invalid-input",
      );
    }

    const blocks = draft.blocks ?? [];
    // Notion accepts the first 100 blocks inline; the remainder is
    // appended after the page has an id. The split is a hard contract
    // (the API rejects >100 children in one call), so it lives here.
    const initialBlocks = blocks.slice(0, 100);
    const trailingBlocks = blocks.slice(100);

    const parent = buildParent(draft.parent);
    const payload: Record<string, unknown> = {
      parent,
    };

    if (draft.parent.kind === "database") {
      const titleProp = nonEmpty(draft.titlePropertyName ?? null);
      if (titleProp === null) {
        throw new NotionIntegrationError(
          "A database parent requires `titlePropertyName` (the name of the title-typed property in the destination database; Notion's default is \"Name\" but a database can rename it).",
          "invalid-input",
          { databaseId: draft.parent.databaseId },
        );
      }
      const baseProps =
        draft.properties !== undefined
          ? { ...(draft.properties as Record<string, unknown>) }
          : {};
      if (Object.prototype.hasOwnProperty.call(baseProps, titleProp)) {
        throw new NotionIntegrationError(
          `\`properties\` already defines the title property "${titleProp}"; the adapter sets it from \`title\` — remove it from \`properties\`.`,
          "invalid-input",
          { titlePropertyName: titleProp },
        );
      }
      baseProps[titleProp] = {
        title: [{ type: "text", text: { content: draft.title } }],
      };
      payload["properties"] = baseProps;
    } else {
      // A page parent uses `properties.title` keyed under `title` — this
      // is Notion's contract for a child page, which has no database
      // schema. The property key is literally "title".
      const baseProps =
        draft.properties !== undefined
          ? { ...(draft.properties as Record<string, unknown>) }
          : {};
      if (!Object.prototype.hasOwnProperty.call(baseProps, "title")) {
        baseProps["title"] = {
          title: [{ type: "text", text: { content: draft.title } }],
        };
      }
      payload["properties"] = baseProps;
    }

    if (initialBlocks.length > 0) {
      payload["children"] = initialBlocks.map(notionBlockToJson);
    }

    const body = JSON.stringify(payload);
    const response = await this.request({
      url: `${this.apiBaseUrl}/pages`,
      method: "POST",
      body,
    });

    if (response.status === 429) {
      throw new NotionIntegrationError(
        "Notion rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new NotionIntegrationError(
        `Notion rejected the integration token (HTTP ${response.status}). Verify the token and that the target page or database has been shared with the integration in Notion.`,
        "not-configured",
        { httpStatus: response.status, body: truncate(response.body, 500) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const parsedError = parseNotionError(response.body);
      throw new NotionIntegrationError(
        `Notion returned HTTP ${response.status} creating the page: ${parsedError ?? truncate(response.body, 300)}`,
        "notion-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
          notionError: parsedError,
        },
      );
    }

    let parsed: unknown = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = null;
    }
    const obj =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const pageId = obj !== null && typeof obj["id"] === "string" ? obj["id"] : null;
    if (pageId === null || pageId.length === 0) {
      throw new NotionIntegrationError(
        "Notion accepted the create request but did not return a page id; the page may or may not exist. Inspect the response body.",
        "notion-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }

    if (trailingBlocks.length > 0) {
      await this.appendBlocks(pageId, trailingBlocks);
    }

    return {
      ok: true,
      pageId,
      pageUrl: obj !== null && typeof obj["url"] === "string" ? obj["url"] : null,
      createdTime:
        obj !== null && typeof obj["created_time"] === "string"
          ? obj["created_time"]
          : null,
      payloadJson: body,
      httpStatus: response.status,
    };
  }

  /**
   * Append blocks to an existing page. Batches at 100 blocks per call to
   * match Notion's documented limit. Always appends after the current
   * last child, never at a computed position: a caller that needs an
   * insertion point must delete-and-recreate, and that is a deliberate
   * manual operation rather than an adapter feature.
   */
  async appendBlocks(
    pageId: string,
    blocks: readonly NotionBlock[],
  ): Promise<{ readonly ok: true; readonly appendedCount: number }> {
    if (!nonEmpty(pageId)) {
      throw new NotionIntegrationError("`pageId` is required.", "invalid-input");
    }
    if (blocks.length === 0) {
      return { ok: true, appendedCount: 0 };
    }
    let appended = 0;
    for (let i = 0; i < blocks.length; i += 100) {
      const chunk = blocks.slice(i, i + 100);
      const body = JSON.stringify({
        children: chunk.map(notionBlockToJson),
      });
      const response = await this.request({
        url: `${this.apiBaseUrl}/blocks/${encodeURIComponent(pageId)}/children`,
        method: "PATCH",
        body,
      });
      if (response.status === 429) {
        throw new NotionIntegrationError(
          "Notion rate-limited the append request.",
          "rate-limited",
          { httpStatus: 429, appendedSoFar: appended },
          parseRetryAfterMs(response.headers),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        const parsedError = parseNotionError(response.body);
        throw new NotionIntegrationError(
          `Notion returned HTTP ${response.status} appending blocks: ${parsedError ?? truncate(response.body, 300)}`,
          "notion-rejected",
          {
            httpStatus: response.status,
            body: truncate(response.body, 1_000),
            notionError: parsedError,
            appendedSoFar: appended,
          },
        );
      }
      appended += chunk.length;
    }
    return { ok: true, appendedCount: appended };
  }

  /**
   * An escape hatch: post a block payload verbatim. Exposed for a caller
   * that needs a block type this adapter does not model (synced block,
   * callout, table). The adapter validates only the outer envelope so a
   * caller cannot accidentally post a page body against the blocks
   * endpoint.
   */
  async appendRawBlocks(
    pageId: string,
    rawChildren: readonly Readonly<Record<string, unknown>>[],
  ): Promise<{ readonly ok: true; readonly appendedCount: number }> {
    if (!nonEmpty(pageId)) {
      throw new NotionIntegrationError("`pageId` is required.", "invalid-input");
    }
    if (!Array.isArray(rawChildren) || rawChildren.length === 0) {
      throw new NotionIntegrationError(
        "`rawChildren` must be a non-empty array of Notion blocks.",
        "invalid-input",
      );
    }
    for (const child of rawChildren) {
      if (child === null || typeof child !== "object" || typeof child["type"] !== "string") {
        throw new NotionIntegrationError(
          "Every raw block must be an object with a `type` string.",
          "invalid-input",
          { received: child },
        );
      }
    }
    let appended = 0;
    for (let i = 0; i < rawChildren.length; i += 100) {
      const chunk = rawChildren.slice(i, i + 100);
      const body = JSON.stringify({ children: chunk });
      const response = await this.request({
        url: `${this.apiBaseUrl}/blocks/${encodeURIComponent(pageId)}/children`,
        method: "PATCH",
        body,
      });
      if (response.status < 200 || response.status >= 300) {
        const parsedError = parseNotionError(response.body);
        throw new NotionIntegrationError(
          `Notion returned HTTP ${response.status} appending raw blocks: ${parsedError ?? truncate(response.body, 300)}`,
          "notion-rejected",
          {
            httpStatus: response.status,
            body: truncate(response.body, 1_000),
            notionError: parsedError,
            appendedSoFar: appended,
          },
        );
      }
      appended += chunk.length;
    }
    return { ok: true, appendedCount: appended };
  }

  // -- Internals -------------------------------------------------------

  private async request(input: {
    readonly url: string;
    readonly method: "POST" | "PATCH" | "GET";
    readonly body?: string;
  }): Promise<{
    readonly status: number;
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
  }> {
    if (typeof this.transport !== "function") {
      throw new NotionIntegrationError(
        "The Notion adapter was constructed without a transport function.",
        "invalid-input",
      );
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": this.notionVersion,
      Accept: "application/json",
      "User-Agent": "Zipy-AI-Notion/1",
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    try {
      return await this.transport({
        url: input.url,
        method: input.method,
        headers,
        body: input.body,
        signal: abortAfter(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new NotionIntegrationError(
        `Notion transport error: ${message}`,
        "transport-failure",
        { url: input.url, method: input.method },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateNotionAdapterInput {
  readonly token: string;
  readonly transport: NotionTransport;
  readonly timeoutMs?: number;
  readonly notionVersion?: string;
  readonly apiBaseUrl?: string;
}

export function createNotionAdapter(input: CreateNotionAdapterInput): NotionAdapter {
  if (input === null || typeof input !== "object") {
    throw new NotionIntegrationError("`input` is required.", "invalid-input");
  }
  if (!nonEmpty(input.token)) {
    throw new NotionIntegrationError(
      "A Notion integration token is required. Create one in Notion (Settings > Connections > Develop or manage integrations) and set NOTION_INTEGRATION_TOKEN.",
      "not-configured",
      { requiredEnv: "NOTION_INTEGRATION_TOKEN" },
    );
  }
  if (typeof input.transport !== "function") {
    throw new NotionIntegrationError(
      "A `transport` function is required (pass globalThis.fetch in production).",
      "invalid-input",
    );
  }
  return new NotionAdapter(input);
}

/**
 * Convenience factory: read the token from the environment. When the
 * token is absent, throws `not-configured` listing the variable the
 * operator must supply; the default parent is optional (a caller may
 * override it on each `createPage`).
 */
export function createNotionAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly transport: NotionTransport;
  readonly timeoutMs?: number;
  readonly notionVersion?: string;
}): NotionAdapter {
  const env = readNotionEnv(input.env);
  if (env.integrationToken === null) {
    throw new NotionIntegrationError(
      "Notion is not configured. Set NOTION_INTEGRATION_TOKEN.",
      "not-configured",
      { requiredEnv: "NOTION_INTEGRATION_TOKEN" },
    );
  }
  return createNotionAdapter({
    token: env.integrationToken,
    transport: input.transport,
    timeoutMs: input.timeoutMs,
    notionVersion: input.notionVersion,
  });
}

/* -------------------------------------------------------------------------- */
/* Guided-document -> Notion block adapter                                     */
/* -------------------------------------------------------------------------- */

/**
 * A small bridge: take a guide body (already produced by the content
 * layer) and turn it into `NotionBlock[]`. The content layer produces
 * structured output (headings, steps, callouts); this function maps only
 * the subset that Notion renders natively and drops the rest rather than
 * inventing a shape Notion cannot represent.
 *
 * The caller is expected to have already serialised the guide to a shape
 * this function can consume (`GuideForNotion`); this bridge is
 * deliberately small because a richer conversion belongs in the export
 * layer alongside the DOCX renderer.
 */
export interface GuideForNotionHeading {
  readonly type: "heading";
  readonly level: 1 | 2 | 3;
  readonly text: string;
}

export interface GuideForNotionParagraph {
  readonly type: "paragraph";
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface GuideForNotionBullet {
  readonly type: "bullet";
  readonly text: string;
}

export interface GuideForNotionNumbered {
  readonly type: "numbered";
  readonly text: string;
}

export interface GuideForNotionQuote {
  readonly type: "quote";
  readonly text: string;
}

export interface GuideForNotionCode {
  readonly type: "code";
  readonly text: string;
  readonly language: string;
}

export interface GuideForNotionImage {
  readonly type: "image";
  readonly url: string;
  readonly caption?: string | null;
  readonly alt?: string | null;
}

export interface GuideForNotionDivider {
  readonly type: "divider";
}

export type GuideForNotionElement =
  | GuideForNotionHeading
  | GuideForNotionParagraph
  | GuideForNotionBullet
  | GuideForNotionNumbered
  | GuideForNotionQuote
  | GuideForNotionCode
  | GuideForNotionImage
  | GuideForNotionDivider;

export function guideElementsToNotionBlocks(
  elements: readonly GuideForNotionElement[],
): readonly NotionBlock[] {
  const out: NotionBlock[] = [];
  for (const el of elements) {
    switch (el.type) {
      case "heading":
        out.push({
          type: "heading",
          level: el.level,
          richText: [{ text: el.text }],
        });
        break;
      case "paragraph":
        out.push({
          type: "paragraph",
          richText: [{ text: el.text, bold: el.bold, italic: el.italic }],
        });
        break;
      case "bullet":
        out.push({
          type: "bulleted_list_item",
          richText: [{ text: el.text }],
        });
        break;
      case "numbered":
        out.push({
          type: "numbered_list_item",
          richText: [{ text: el.text }],
        });
        break;
      case "quote":
        out.push({ type: "quote", richText: [{ text: el.text }] });
        break;
      case "code":
        out.push({
          type: "code",
          richText: [{ text: el.text }],
          language: el.language,
        });
        break;
      case "image":
        out.push({
          type: "image",
          url: el.url,
          caption: el.caption ?? null,
          alt: el.alt ?? null,
        });
        break;
      case "divider":
        out.push({ type: "divider" });
        break;
      default: {
        const exhaustive: never = el;
        void exhaustive;
        break;
      }
    }
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* JSON serialisation of blocks                                                */
/* -------------------------------------------------------------------------- */

function buildParent(parent: NotionParent): Readonly<Record<string, unknown>> {
  if (parent.kind === "database") {
    if (!nonEmpty(parent.databaseId)) {
      throw new NotionIntegrationError(
        "`parent.databaseId` is required for a database parent.",
        "invalid-input",
      );
    }
    return { type: "database_id", database_id: parent.databaseId };
  }
  if (!nonEmpty(parent.pageId)) {
    throw new NotionIntegrationError(
      "`parent.pageId` is required for a page parent.",
      "invalid-input",
    );
  }
  return { type: "page_id", page_id: parent.pageId };
}

function notionBlockToJson(block: NotionBlock): Readonly<Record<string, unknown>> {
  switch (block.type) {
    case "paragraph":
      return {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: block.richText.map(richTextToJson) },
      };
    case "heading":
      return block.level === 1
        ? {
            object: "block",
            type: "heading_1",
            heading_1: { rich_text: block.richText.map(richTextToJson) },
          }
        : block.level === 2
          ? {
              object: "block",
              type: "heading_2",
              heading_2: { rich_text: block.richText.map(richTextToJson) },
            }
          : {
              object: "block",
              type: "heading_3",
              heading_3: { rich_text: block.richText.map(richTextToJson) },
            };
    case "bulleted_list_item":
      return {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: block.richText.map(richTextToJson) },
      };
    case "numbered_list_item":
      return {
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: block.richText.map(richTextToJson) },
      };
    case "quote":
      return {
        object: "block",
        type: "quote",
        quote: { rich_text: block.richText.map(richTextToJson) },
      };
    case "code":
      return {
        object: "block",
        type: "code",
        code: {
          rich_text: block.richText.map(richTextToJson),
          language: block.language,
        },
      };
    case "image": {
      // Notion's image block accepts either an external file or a
      // `file_upload` id. This adapter uses the external shape because
      // an upload would require a separate file-upload flow that
      // returns an id the caller does not have here.
      const image: Record<string, unknown> = {
        type: "external",
        external: { url: block.url },
      };
      if (nonEmpty(block.caption ?? null) !== null) {
        image["caption"] = [{ type: "text", text: { content: block.caption } }];
      }
      return { object: "block", type: "image", image };
    }
    case "divider":
      return { object: "block", type: "divider", divider: {} };
    default: {
      const exhaustive: never = block;
      void exhaustive;
      throw new NotionIntegrationError(
        "Unknown Notion block type.",
        "invalid-input",
      );
    }
  }
}

function richTextToJson(t: NotionRichText): Readonly<Record<string, unknown>> {
  const annotations: Record<string, unknown> = {};
  if (t.bold === true) annotations["bold"] = true;
  if (t.italic === true) annotations["italic"] = true;
  if (t.code === true) annotations["code"] = true;
  const json: Record<string, unknown> = {
    type: "text",
    text: {
      content: t.text,
      ...(t.linkUrl !== undefined && t.linkUrl !== null
        ? { link: { url: t.linkUrl } }
        : {}),
    },
  };
  if (Object.keys(annotations).length > 0) {
    json["annotations"] = annotations;
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function parseNotionError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") return null;
    const code = typeof parsed["code"] === "string" ? parsed["code"] : null;
    const message = typeof parsed["message"] === "string" ? parsed["message"] : null;
    if (code === null && message === null) return null;
    return [code, message].filter((x) => x !== null).join(": ");
  } catch {
    return null;
  }
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function parseRetryAfterMs(
  headers: Readonly<Record<string, string>> | undefined,
): number | null {
  if (headers === undefined) return null;
  const raw = headers["Retry-After"] ?? headers["retry-after"];
  if (typeof raw !== "string") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1000) : null;
}

function truncate(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  notionBlockToJson,
  richTextToJson,
  buildParent,
  parseNotionError,
  abortAfter,
  guideElementsToNotionBlocks,
});
