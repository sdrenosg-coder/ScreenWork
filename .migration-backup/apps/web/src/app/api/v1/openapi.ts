/**
 * Zipy AI — REST API v1 OpenAPI descriptor.
 *
 * This module owns a single, static OpenAPI 3.1 document for the *public*
 * versioned REST surface (`/api/v1/*`). It is not a documentation generator
 * that scrapes route files at runtime; it is an authored contract kept next to
 * the v1 routes so a change to a route is expected to be accompanied by a
 * change here (the routes cross-check their own resource shapes against the
 * schemas exported from this file, so drift is at least type-visible).
 *
 * Scope:
 *   - Describes the resources the v1 surface exposes in this phase:
 *     workspaces, sources, workflows, guides, guide craft (generate/export),
 *     jobs, exports, webhooks subscriptions, and API keys.
 *   - Documents the shared error envelope and the shared auth model
 *     (session cookie OR bearer API key).
 *   - Describes the webhook event catalogue that the dispatch module in the
 *     next batch will emit, since the OpenAPI document is what an integrator
 *     builds against.
 *
 * Deliberate non-goals:
 *   - It does not claim endpoints the phase has not implemented. Paths listed
 *     here are exactly those the v1 routes serve (plus the OpenAPI doc path
 *     itself, which is served by the docs route in a later batch).
 *   - It does not invent credential setup. Security schemes describe where a
 *     credential is supplied; they do not embed or imply one.
 *
 * The document is a plain object so it can be returned by a Next.js route as
 * JSON without a serialization step.
 */

export interface OpenApiSecurityScheme {
  readonly type: string;
  readonly scheme?: string;
  readonly in?: string;
  readonly name?: string;
  readonly description?: string;
  readonly flows?: Record<string, unknown>;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "query" | "path" | "header" | "cookie";
  readonly required?: boolean;
  readonly description?: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface OpenApiMediaTypeObject {
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly example?: unknown;
}

export interface OpenApiResponseObject {
  readonly description: string;
  readonly content?: Readonly<Record<string, OpenApiMediaTypeObject>>;
  readonly headers?: Readonly<
    Record<string, { readonly schema: Readonly<Record<string, unknown>>; readonly description?: string }>
  >;
}

export interface OpenApiOperationObject {
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content: Readonly<Record<string, OpenApiMediaTypeObject>>;
  };
  readonly responses: Readonly<Record<string, OpenApiResponseObject>>;
}

export interface OpenApiPathItemObject {
  readonly get?: OpenApiOperationObject;
  readonly post?: OpenApiOperationObject;
  readonly put?: OpenApiOperationObject;
  readonly patch?: OpenApiOperationObject;
  readonly delete?: OpenApiOperationObject;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
    readonly license?: { readonly name: string };
  };
  readonly servers: readonly { readonly url: string; readonly description?: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly components: {
    readonly securitySchemes: Readonly<Record<string, OpenApiSecurityScheme>>;
    readonly schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly paths: Readonly<Record<string, OpenApiPathItemObject>>;
}

/* -------------------------------------------------------------------------- */
/* Shared schema references                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The `$ref` prefixes used throughout the document. Keeping them as named
 * constants prevents a typo in one operation from producing a broken
 * reference that only fails in a validator.
 */
export const REF = {
  error: "#/components/schemas/Error",
  workspace: "#/components/schemas/Workspace",
  workspaceList: "#/components/schemas/WorkspaceList",
  source: "#/components/schemas/Source",
  sourceList: "#/components/schemas/SourceList",
  workflow: "#/components/schemas/Workflow",
  workflowList: "#/components/schemas/WorkflowList",
  guide: "#/components/schemas/Guide",
  guideList: "#/components/schemas/GuideList",
  job: "#/components/schemas/Job",
  jobList: "#/components/schemas/JobList",
  webhookSubscription: "#/components/schemas/WebhookSubscription",
  webhookEvent: "#/components/schemas/WebhookEvent",
  apiKey: "#/components/schemas/ApiKey",
  pagination: "#/components/schemas/PaginationMeta",
} as const;

const uuidSchema: Readonly<Record<string, unknown>> = {
  type: "string",
  format: "uuid",
};

const isoDateTimeSchema: Readonly<Record<string, unknown>> = {
  type: "string",
  format: "date-time",
};

const nullableString: Readonly<Record<string, unknown>> = {
  type: ["string", "null"],
};

/* -------------------------------------------------------------------------- */
/* Component schemas                                                           */
/* -------------------------------------------------------------------------- */

const errorSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["error", "message"],
  properties: {
    error: {
      type: "string",
      description:
        "Machine-readable error code. Stable identifiers include: validation_error, invalid_json, unauthenticated, forbidden, not_found, config_error, queue_unavailable, storage_unavailable, method_not_allowed, unsupported, conflict, rate_limited.",
    },
    message: {
      type: "string",
      description: "Human-readable explanation, safe to surface to an operator.",
    },
    field: {
      type: ["string", "null"],
      description: "Present for validation errors; the offending request field.",
    },
    details: {
      type: ["object", "null"],
      description: "Optional structured detail. A later phase may narrow this shape per error code.",
      additionalProperties: true,
    },
  },
} as const;

const paginationSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["limit", "hasMore"],
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    nextCursor: {
      type: ["string", "null"],
      description:
        "Opaque forward cursor. Pass verbatim to the next request; do not construct it client-side.",
    },
    hasMore: { type: "boolean" },
    total: {
      type: ["integer", "null"],
      description:
        "Only populated when the server can compute it cheaply; a paginated scan does not guarantee an exact total.",
    },
  },
} as const;

const workspaceSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "name", "slug", "role", "createdAt"],
  properties: {
    id: uuidSchema,
    name: { type: "string", minLength: 1, maxLength: 200 },
    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    role: {
      type: "string",
      enum: ["owner", "admin", "editor", "reviewer", "viewer"],
      description:
        "The role the authenticated principal holds in this workspace, resolved server-side from the membership table.",
    },
    plan: {
      type: ["string", "null"],
      enum: ["free", "pro", "business", "enterprise", null],
      description:
        "Present once the billing phase records a plan for the workspace; null when unassigned rather than defaulted.",
    },
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  },
} as const;

const workspaceListSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["workspaces", "pagination"],
  properties: {
    workspaces: { type: "array", items: { $ref: REF.workspace } },
    pagination: { $ref: REF.pagination },
  },
} as const;

const sourceSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "workspaceId", "kind", "status", "createdAt"],
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    kind: {
      type: "string",
      enum: ["url", "text", "image", "pdf", "docx", "pptx", "audio", "video", "combined"],
    },
    status: {
      type: "string",
      enum: ["pending", "processing", "ready", "failed"],
    },
    label: { type: ["string", "null"] },
    url: {
      type: ["string", "null"],
      format: "uri",
      description: "Populated for URL sources; null otherwise.",
    },
    artifactId: {
      type: ["string", "null"],
      format: "uuid",
      description:
        "The artifact record for the underlying bytes or extracted payload; null until the ingest job persists it.",
    },
    jobId: { type: ["string", "null"] },
    error: {
      type: ["string", "null"],
      description: "Set when status is failed. Contains the operator-facing failure reason.",
    },
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  },
} as const;

const sourceListSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["sources", "pagination"],
  properties: {
    sources: { type: "array", items: { $ref: REF.source } },
    pagination: { $ref: REF.pagination },
  },
} as const;

const workflowSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "workspaceId", "status", "createdAt"],
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    guideId: { type: ["string", "null"], format: "uuid" },
    status: {
      type: "string",
      enum: ["draft", "synthesizing", "synthesized", "running", "failed", "archived"],
    },
    goal: {
      type: ["string", "null"],
      description: "The natural-language goal extracted from the source text prompt.",
    },
    startUrl: { type: ["string", "null"], format: "uri" },
    planRevision: {
      type: ["integer", "null"],
      description:
        "Monotonic revision of the synthesized action plan. Increments on each synthesis; the guide content pipeline hashes it for idempotency.",
    },
    stepCount: { type: ["integer", "null"], minimum: 0 },
    lowConfidenceStepCount: {
      type: ["integer", "null"],
      minimum: 0,
      description:
        "Steps whose synthesis confidence fell below the review threshold. Flagged for review, not discarded.",
    },
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  },
} as const;

const workflowListSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["workflows", "pagination"],
  properties: {
    workflows: { type: "array", items: { $ref: REF.workflow } },
    pagination: { $ref: REF.pagination },
  },
} as const;

const guideSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "workspaceId", "workflowId", "title", "status", "createdAt"],
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    workflowId: uuidSchema,
    title: { type: "string", minLength: 1, maxLength: 300 },
    status: {
      type: "string",
      enum: ["draft", "review", "published", "archived"],
    },
    slug: {
      type: ["string", "null"],
      description: "Set once the guide is published under a shareable path.",
    },
    aiGenerated: {
      type: "boolean",
      description:
        "True when at least one content layer of the current draft was produced by a model. Mirrors the AI disclosure label on the output.",
    },
    sourceCount: { type: "integer", minimum: 0 },
    stepCount: { type: "integer", minimum: 0 },
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  },
} as const;

const guideListSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["guides", "pagination"],
  properties: {
    guides: { type: "array", items: { $ref: REF.guide } },
    pagination: { $ref: REF.pagination },
  },
} as const;

const jobSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "workspaceId", "kind", "status", "createdAt"],
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    kind: {
      type: "string",
      description:
        "Job kind, e.g. ingest:url, ingest:text, ingest:file, ingest:combine, synth:workflow, run:workflow, generate:guide, export:guide.",
    },
    status: {
      type: "string",
      enum: ["pending", "active", "succeeded", "failed", "cancelled"],
    },
    attempts: { type: "integer", minimum: 0 },
    correlationId: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    createdBy: { type: ["string", "null"], format: "uuid" },
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    finishedAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;

const jobListSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["jobs", "pagination"],
  properties: {
    jobs: { type: "array", items: { $ref: REF.job } },
    pagination: { $ref: REF.pagination },
  },
} as const;

const webhookSubscriptionSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "workspaceId", "url", "events", "active", "createdAt"],
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    url: { type: "string", format: "uri", description: "HTTPS endpoint that receives deliveries." },
    events: {
      type: "array",
      items: { type: "string" },
      description: "Event names this subscription is entitled to receive.",
    },
    active: { type: "boolean" },
    description: { type: ["string", "null"] },
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  },
} as const;

const webhookEventSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "type", "workspaceId", "createdAt", "data"],
  properties: {
    id: uuidSchema,
    type: {
      type: "string",
      enum: [
        "ingest.completed",
        "ingest.failed",
        "synthesis.completed",
        "synthesis.failed",
        "generation.completed",
        "generation.failed",
        "review.requested",
        "review.decided",
        "guide.published",
        "guide.unpublished",
        "export.completed",
        "workflow.failed",
      ],
    },
    workspaceId: uuidSchema,
    createdAt: isoDateTimeSchema,
    data: {
      type: "object",
      additionalProperties: true,
      description:
        "Event-specific payload. Each event type documents its own fields as they land; consumers should treat unknown fields as forward-compatible additions rather than errors.",
    },
  },
} as const;

const apiKeySchema: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["id", "workspaceId", "name", "createdAt"],
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: { type: "string", minLength: 1, maxLength: 120 },
    prefix: {
      type: "string",
      description:
        "The non-secret leading portion of the key, shown in the UI to identify it. The secret itself is only returned once, at creation.",
    },
    lastUsedAt: { type: ["string", "null"], format: "date-time" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    createdAt: isoDateTimeSchema,
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Reusable response objects                                                   */
/* -------------------------------------------------------------------------- */

const jsonError = (description: string): OpenApiResponseObject => ({
  description,
  content: { "application/json": { schema: { $ref: REF.error } } },
});

const errorResponses = {
  "400": jsonError("The request was malformed or failed validation."),
  "401": jsonError("Authentication is required and was not supplied or was rejected."),
  "403": jsonError(
    "The authenticated principal is not permitted to perform this action in the active workspace.",
  ),
  "404": jsonError("The requested resource does not exist in the caller's workspace."),
  "409": jsonError(
    "The request conflicts with the current state of the resource (for example, an upstream step has not run yet).",
  ),
  "503": jsonError(
    "A required server capability is not configured, or a backing dependency is unreachable. The message names the missing piece so an operator can act on it.",
  ),
} as const;

const bearerOrSession: readonly Readonly<Record<string, readonly string[]>>[] = [
  { SessionCookie: [] },
  { BearerApiKey: [] },
];

const listQueryParams: readonly OpenApiParameter[] = [
  {
    name: "limit",
    in: "query",
    required: false,
    description: "Maximum number of items to return. Defaults to 25.",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 25 },
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    description: "Opaque forward cursor returned by a previous page.",
    schema: { type: "string" },
  },
];

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

const paths: Readonly<Record<string, OpenApiPathItemObject>> = {
  "/api/v1/openapi.json": {
    get: {
      operationId: "getOpenApiDocument",
      summary: "Fetch this OpenAPI document",
      description:
        "Returns the OpenAPI 3.1 document describing the v1 REST surface. The response is served from the authored descriptor in the codebase, not generated at request time. Authentication is not required so tooling can fetch the contract before credentials are configured.",
      tags: ["Meta"],
      security: [],
      responses: {
        "200": {
          description: "The OpenAPI document.",
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
    },
  },

  "/api/v1/workspaces": {
    get: {
      operationId: "listWorkspaces",
      summary: "List workspaces the caller is a member of",
      tags: ["Workspaces"],
      security: bearerOrSession,
      parameters: listQueryParams,
      responses: {
        "200": {
          description: "A page of workspaces.",
          content: {
            "application/json": { schema: { $ref: REF.workspaceList } },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/sources": {
    get: {
      operationId: "listSources",
      summary: "List ingested sources in the active workspace",
      tags: ["Sources"],
      security: bearerOrSession,
      parameters: [
        ...listQueryParams,
        {
          name: "kind",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["url", "text", "image", "pdf", "docx", "pptx", "audio", "video", "combined"],
          },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["pending", "processing", "ready", "failed"] },
        },
      ],
      responses: {
        "200": {
          description: "A page of sources.",
          content: { "application/json": { schema: { $ref: REF.sourceList } } },
        },
        ...errorResponses,
      },
    },
    post: {
      operationId: "createSource",
      summary: "Ingest a source",
      description:
        "Dispatches by `kind`. URL and text ingestion are exposed by the sibling `/api/sources/url` and `/api/sources/text` routes; uploaded binary sources go through `/api/sources/file`; combined multi-source ingestion goes through `/api/sources/combine`. This v1 operation is the single documented entry point and returns the enqueued ingest job.",
      tags: ["Sources"],
      security: bearerOrSession,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["kind"],
              properties: {
                kind: {
                  type: "string",
                  enum: ["url", "text", "image", "pdf", "docx", "pptx", "audio", "video", "combined"],
                },
                url: { type: "string", format: "uri" },
                prompt: { type: "string", maxLength: 20000 },
                artifactIds: {
                  type: "array",
                  items: uuidSchema,
                  description: "For kind `combined`: the artifacts to ingest in parallel.",
                },
                label: { type: "string", maxLength: 160 },
                priority: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "For kind `combined`: source-kind ordering used when sources disagree. Omitted means the workspace default is used.",
                },
              },
            },
          },
        },
      },
      responses: {
        "202": {
          description: "The ingest job was enqueued.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["job"],
                properties: { job: { $ref: REF.job }, source: { $ref: REF.source } },
              },
            },
          },
        },
        "200": {
          description:
            "An identical ingest was already pending or active; the existing job is returned and `created` is false.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["job"],
                properties: { job: { $ref: REF.job } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/workflows": {
    get: {
      operationId: "listWorkflows",
      summary: "List workflows in the active workspace",
      tags: ["Workflows"],
      security: bearerOrSession,
      parameters: [
        ...listQueryParams,
        {
          name: "guideId",
          in: "query",
          required: false,
          schema: uuidSchema,
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["draft", "synthesizing", "synthesized", "running", "failed", "archived"],
          },
        },
      ],
      responses: {
        "200": {
          description: "A page of workflows.",
          content: { "application/json": { schema: { $ref: REF.workflowList } } },
        },
        ...errorResponses,
      },
    },
    post: {
      operationId: "createWorkflow",
      summary: "Create a workflow",
      description:
        "Creates an empty workflow bound to the active workspace. Synthesis is a separate operation (`POST /api/workflows/{id}/synthesize`) because it runs on the worker and can fail independently.",
      tags: ["Workflows"],
      security: bearerOrSession,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["goal"],
              properties: {
                goal: { type: "string", minLength: 1, maxLength: 2000 },
                startUrl: { type: "string", format: "uri" },
                guideId: uuidSchema,
                sourceIds: { type: "array", items: uuidSchema },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The workflow was created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["workflow"],
                properties: { workflow: { $ref: REF.workflow } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/workflows/{id}/synthesize": {
    post: {
      operationId: "synthesizeWorkflow",
      summary: "Enqueue synthesis for a workflow",
      description:
        "Enqueues a `synth:workflow` job. The route name and behaviour are documented here as an alias for the existing unversioned `/api/workflows/{id}/synthesize` route, which the v1 wrapper delegates to. Requires at least one configured LLM provider; the response names the missing setup when none is configured.",
      tags: ["Workflows"],
      security: bearerOrSession,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: uuidSchema,
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                promptVersionId: { type: "string" },
                provider: {
                  type: "string",
                  enum: ["openai", "anthropic", "gemini", "ollama", "vllm"],
                },
                model: { type: "string", maxLength: 128 },
                force: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "202": {
          description: "The synthesis job was enqueued.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["job", "synthesis"],
                properties: {
                  job: { $ref: REF.job },
                  synthesis: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/guides": {
    get: {
      operationId: "listGuides",
      summary: "List guides in the active workspace",
      tags: ["Guides"],
      security: bearerOrSession,
      parameters: [
        ...listQueryParams,
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["draft", "review", "published", "archived"] },
        },
        {
          name: "workflowId",
          in: "query",
          required: false,
          schema: uuidSchema,
        },
      ],
      responses: {
        "200": {
          description: "A page of guides.",
          content: { "application/json": { schema: { $ref: REF.guideList } } },
        },
        ...errorResponses,
      },
    },
    post: {
      operationId: "createGuide",
      summary: "Create a guide",
      description:
        "Creates a guide bound to a workflow. Content generation and export are separate operations because they are long-running and are separately reviewable.",
      tags: ["Guides"],
      security: bearerOrSession,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["workflowId", "title"],
              properties: {
                workflowId: uuidSchema,
                title: { type: "string", minLength: 1, maxLength: 300 },
                templateId: {
                  type: "string",
                  description: "Optional template from the template library.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The guide was created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["guide"],
                properties: { guide: { $ref: REF.guide } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/guides/{id}": {
    get: {
      operationId: "getGuide",
      summary: "Fetch a guide and its current draft",
      tags: ["Guides"],
      security: bearerOrSession,
      parameters: [{ name: "id", in: "path", required: true, schema: uuidSchema }],
      responses: {
        "200": {
          description: "The guide record plus the current draft and its run metadata.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["guide"],
                properties: {
                  guide: { $ref: REF.guide },
                  draft: {
                    type: ["object", "null"],
                    additionalProperties: true,
                    description:
                      "The current content draft, or null when no draft has been generated yet.",
                  },
                  draftMeta: {
                    type: ["object", "null"],
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/guides/{id}/generate": {
    post: {
      operationId: "generateGuideContent",
      summary: "Generate or regenerate a guide draft",
      description:
        "Alias for the existing `/api/guides/{id}/generate` route. Composition is idempotent on the inputs hash unless `force` is set. Requires a configured LLM provider unless `deterministic` is true.",
      tags: ["Guides"],
      security: bearerOrSession,
      parameters: [{ name: "id", in: "path", required: true, schema: uuidSchema }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                provider: { type: "string", enum: ["openai", "anthropic", "gemini", "ollama", "vllm"] },
                model: { type: "string", maxLength: 128 },
                deterministic: { type: "boolean" },
                force: { type: "boolean" },
                style: {
                  type: "object",
                  properties: {
                    tone: { type: "string", enum: ["formal", "casual", "technical"] },
                    audience: { type: "string", enum: ["end-user", "admin", "developer"] },
                    brandTerms: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 64 },
                  },
                },
                layers: {
                  type: "object",
                  properties: {
                    titleSummary: { type: "boolean" },
                    introPrereqs: { type: "boolean" },
                    stepText: { type: "boolean" },
                    tipsWarnings: { type: "boolean" },
                    faq: { type: "boolean" },
                    glossary: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "A new draft was generated.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["guideId", "runId", "draft"],
                properties: {
                  guideId: uuidSchema,
                  runId: uuidSchema,
                  draft: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        "200": {
          description:
            "The current draft already matches the requested inputs; it is returned unchanged.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["guideId", "draft"],
                properties: { guideId: uuidSchema, draft: { type: "object", additionalProperties: true } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/guides/{id}/export": {
    get: {
      operationId: "exportGuide",
      summary: "Export a guide",
      description:
        "Alias for the existing `/api/guides/{id}/export` route. Streams the rendered artefact. The Content-Disposition header names the downloaded file.",
      tags: ["Guides"],
      security: bearerOrSession,
      parameters: [
        { name: "id", in: "path", required: true, schema: uuidSchema },
        {
          name: "format",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["pdf", "html", "markdown", "docx", "imagepack"] },
        },
      ],
      responses: {
        "200": {
          description: "The rendered artefact.",
          headers: {
            "content-disposition": {
              schema: { type: "string" },
              description: "Names the downloaded file.",
            },
          },
          content: {
            "application/pdf": { schema: { type: "string", format: "binary" } },
            "text/html": { schema: { type: "string" } },
            "text/markdown": { schema: { type: "string" } },
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
              schema: { type: "string", format: "binary" },
            },
            "application/zip": { schema: { type: "string", format: "binary" } },
          },
        },
        "422": jsonError(
          "The requested format is not supported by the installed export renderers.",
        ),
        ...errorResponses,
      },
    },
  },

  "/api/v1/jobs": {
    get: {
      operationId: "listJobs",
      summary: "List jobs in the active workspace",
      tags: ["Jobs"],
      security: bearerOrSession,
      parameters: [
        ...listQueryParams,
        {
          name: "kind",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["pending", "active", "succeeded", "failed", "cancelled"] },
        },
      ],
      responses: {
        "200": {
          description: "A page of jobs.",
          content: { "application/json": { schema: { $ref: REF.jobList } } },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/jobs/{id}": {
    get: {
      operationId: "getJob",
      summary: "Fetch a job and its outcome",
      tags: ["Jobs"],
      security: bearerOrSession,
      parameters: [{ name: "id", in: "path", required: true, schema: uuidSchema }],
      responses: {
        "200": {
          description: "The job row with its terminal error when it failed.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["job"],
                properties: { job: { $ref: REF.job } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/webhooks": {
    get: {
      operationId: "listWebhookSubscriptions",
      summary: "List webhook subscriptions",
      description:
        "Lists subscriptions for the active workspace. Delivery requires `WEBHOOK_SIGNING_SECRET` on the server; a workspace without that secret configured cannot receive signed deliveries and the list response reports it.",
      tags: ["Webhooks"],
      security: bearerOrSession,
      parameters: listQueryParams,
      responses: {
        "200": {
          description: "A page of webhook subscriptions.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscriptions", "pagination"],
                properties: {
                  subscriptions: { type: "array", items: { $ref: REF.webhookSubscription } },
                  pagination: { $ref: REF.pagination },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
    post: {
      operationId: "createWebhookSubscription",
      summary: "Create a webhook subscription",
      tags: ["Webhooks"],
      security: bearerOrSession,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["url", "events"],
              properties: {
                url: { type: "string", format: "uri" },
                events: {
                  type: "array",
                  items: { type: "string" },
                  description: "Event names from the webhook event catalogue.",
                },
                description: { type: "string", maxLength: 300 },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The subscription was created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscription"],
                properties: { subscription: { $ref: REF.webhookSubscription } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/webhooks/events": {
    get: {
      operationId: "listWebhookEvents",
      summary: "List the webhook event catalogue",
      description:
        "Returns the event types a subscription may opt into. The catalogue is static and does not require credentials, so an integrator can configure a subscription before any secret is set on the server.",
      tags: ["Webhooks"],
      security: bearerOrSession,
      parameters: listQueryParams,
      responses: {
        "200": {
          description: "A page of event descriptors.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["events", "pagination"],
                properties: {
                  events: { type: "array", items: { $ref: REF.webhookEvent } },
                  pagination: { $ref: REF.pagination },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },

  "/api/v1/api-keys": {
    get: {
      operationId: "listApiKeys",
      summary: "List API keys for the active workspace",
      description:
        "Lists the non-secret identity of each key (name, prefix, usage). The key secret is only returned once, at creation.",
      tags: ["API keys"],
      security: bearerOrSession,
      parameters: listQueryParams,
      responses: {
        "200": {
          description: "A page of API keys.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["keys", "pagination"],
                properties: {
                  keys: { type: "array", items: { $ref: REF.apiKey } },
                  pagination: { $ref: REF.pagination },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
    post: {
      operationId: "createApiKey",
      summary: "Create an API key",
      tags: ["API keys"],
      security: bearerOrSession,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 120 },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional. Omitted means the key inherits the creator's role at request time rather than freezing a static scope list.",
                },
                expiresAt: isoDateTimeSchema,
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "The key was created. The `secret` field is present in this response only; it is not retrievable afterwards.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["apiKey", "secret"],
                properties: {
                  apiKey: { $ref: REF.apiKey },
                  secret: {
                    type: "string",
                    description:
                      "The bearer credential. Display it once and store it in the caller's secret store.",
                  },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Assembled document                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The v1 OpenAPI document. Consumers may type it as `OpenApiDocument` and
 * serve it directly. It is frozen so a caller cannot mutate the module-level
 * singleton and change what other importers see.
 */
export const openApiDocument: OpenApiDocument = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "Zipy AI REST API",
    version: "1.0.0",
    description:
      "The public, versioned HTTP surface for Zipy AI. Every endpoint described here is authenticated, workspace-scoped, and returns the shared error envelope on failure. A missing server capability produces a 503 whose message names the environment variable or dependency that must be supplied; nothing here is served from a placeholder.",
    license: { name: "Proprietary" },
  },
  servers: [
    { url: "/", description: "The same origin that serves this document." },
  ],
  tags: [
    { name: "Meta", description: "Discovery endpoints for tooling." },
    { name: "Workspaces", description: "Workspaces the caller belongs to." },
    { name: "Sources", description: "Ingested inputs and their ingest jobs." },
    { name: "Workflows", description: "Synthesized action plans and their execution." },
    { name: "Guides", description: "Generated tutorials, their content and exports." },
    { name: "Jobs", description: "Asynchronous work units across all stages." },
    { name: "Webhooks", description: "Outbound event delivery." },
    { name: "API keys", description: "Machine credentials for the public API." },
  ],
  components: {
    securitySchemes: {
      SessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "zipy_session",
        description:
          "Session cookie issued by the auth surface. Name is configurable via SESSION_COOKIE_NAME.",
      },
      BearerApiKey: {
        type: "http",
        scheme: "bearer",
        description:
          "API key issued by POST /api/v1/api-keys. Send as `Authorization: Bearer <secret>`. The key inherits the role of its creator in the workspace it belongs to.",
      },
    },
    schemas: {
      Error: errorSchema,
      PaginationMeta: paginationSchema,
      Workspace: workspaceSchema,
      WorkspaceList: workspaceListSchema,
      Source: sourceSchema,
      SourceList: sourceListSchema,
      Workflow: workflowSchema,
      WorkflowList: workflowListSchema,
      Guide: guideSchema,
      GuideList: guideListSchema,
      Job: jobSchema,
      JobList: jobListSchema,
      WebhookSubscription: webhookSubscriptionSchema,
      WebhookEvent: webhookEventSchema,
      ApiKey: apiKeySchema,
    },
  },
  security: bearerOrSession,
  paths,
});

/**
 * The webhook event catalogue, exported separately so the dispatch module and
 * the OpenAPI document read the same source. A subscription that opts into an
 * event not listed here is rejected by the webhooks route in the next batch.
 */
export const WEBHOOK_EVENTS = [
  "ingest.completed",
  "ingest.failed",
  "synthesis.completed",
  "synthesis.failed",
  "generation.completed",
  "generation.failed",
  "review.requested",
  "review.decided",
  "guide.published",
  "guide.unpublished",
  "export.completed",
  "workflow.failed",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/**
 * Serialise the document for a response. Returns a `Buffer` so a Next.js
 * route can hand it to `new Response(bytes, ...)` without an extra encoding
 * pass.
 */
export function serializeOpenApiJson(pretty = true): Buffer {
  const json = pretty
    ? JSON.stringify(openApiDocument, null, 2)
    : JSON.stringify(openApiDocument);
  return Buffer.from(json, "utf8");
}
