/**
 * Native Fetch responses for the preserved route handlers.
 * Express translates these at the HTTP boundary; no Next.js runtime is needed.
 */
export class HttpResponse extends Response {
  static json(data: unknown, init?: ResponseInit): HttpResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new HttpResponse(JSON.stringify(data), { ...init, headers });
  }
}
