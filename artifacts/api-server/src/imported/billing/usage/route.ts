/**
 * Customer billing was not connected. Do not expose invented plans, prices,
 * balances or portal links. Authentication and billing RBAC still apply.
 * Working usage/activity reporting lives in the native analytics endpoints.
 */
import { HttpResponse } from "@/lib/http-response";
import { loadSession } from "@workspace/zipy/web/auth/session";
import { assertPermission, PERMISSIONS, toAuthzFailure } from "@workspace/zipy/web/rbac/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await loadSession({ cookieHeader: req.headers.get("cookie"), touch: false });
  if (!session) return HttpResponse.json({ error: { code: "unauthenticated", message: "Sign in to view workspace billing." } }, { status: 401 });
  try { assertPermission(session, PERMISSIONS.workspace_billing_read); }
  catch (error) {
    const failure = toAuthzFailure(error);
    if (!failure) throw error;
    return HttpResponse.json(failure.body, { status: failure.status });
  }
  return HttpResponse.json({
    connected: false,
    error: { code: "billing_not_connected", message: "Customer subscriptions and payments are disabled because no billing provider is connected. Actual workspace usage is available in Analytics. Replit AI usage is separate." },
  }, { status: 503 });
}

function unsupported(): Response {
  return HttpResponse.json({ error: { code: "method_not_allowed", message: "Customer billing is not connected; no plan or payment changes are accepted." } }, { status: 405, headers: { Allow: "GET" } });
}
export const POST = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
