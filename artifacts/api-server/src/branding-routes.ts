import type { Express } from "express";
import { PERMISSIONS } from "@workspace/zipy/web/rbac/permissions";
import { buildWhiteLabelTheme, type WhiteLabelInput } from "@workspace/zipy/branding/whiteLabel";
import { ApiFailure, endpoint, workspace, objectBody, locked, read, write } from "./saas-routes";
import { appendActivity } from "./workspace-events";

export function registerBrandingRoutes(app: Express) {
  app.get("/api/branding/theme", endpoint(async (req, res) => {
    const { store } = await workspace(req, PERMISSIONS.workspace_read);
    const saved = await read(store, "settings/branding.json");
    res.json(saved ?? { input: null, theme: null, version: 0 });
  }));
  app.put("/api/branding/theme", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.workspace_settings_update);
    const body = objectBody(req);
    if (JSON.stringify(body).length > 131072) throw new ApiFailure(400, "validation_error", "The theme is too large.");
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new ApiFailure(400, "validation_error", "expectedVersion is required.");
    if (body.customCss) throw new ApiFailure(400, "validation_error", "Custom CSS is not enabled on the public reader. Leave it empty.");
    const input = {
      workspaceId, enabled: body.enabled === true, brandName: body.brandName,
      legalFooterText: body.legalFooterText, tokenOverrides: body.tokenOverrides,
      fontInput: body.fontInput, logos: body.logos, customCss: null,
    } as WhiteLabelInput;
    let theme;
    try { theme = buildWhiteLabelTheme(input); }
    catch (error) { throw new ApiFailure(400, "validation_error", error instanceof Error ? error.message : "The theme is invalid."); }
    for (const pick of Array.isArray(body.logos) ? body.logos : []) {
      const key = pick?.logo?.storageKey;
      if (typeof key !== "string" || (!key.startsWith(`${workspaceId}/`) && !key.startsWith("artifacts/")) || key.includes("..") || key.includes("\\") || key.includes("\0")) {
        throw new ApiFailure(400, "validation_error", "Logo keys must refer to this workspace's uploaded images.");
      }
      if (pick.surface === "guide-header" && pick.logo.mimeType === "image/svg+xml") {
        throw new ApiFailure(400, "validation_error", "Public header logos support PNG, JPEG, WebP or GIF. SVG is not enabled.");
      }
    }
    const saved = await locked(workspaceId, "branding", async () => {
      const current = await read(store, "settings/branding.json");
      const version = Number(current?.version ?? 0);
      if (version !== body.expectedVersion) throw new ApiFailure(409, "version_conflict", "Branding changed in another session. Reload before saving.");
      const record = { input, theme, version: version + 1, updatedAt: new Date().toISOString(), updatedBy: session.userId };
      await write(store, "settings/branding.json", record);
      return record;
    });
    await appendActivity(workspaceId, session.userId, "branding.saved", workspaceId, "Updated workspace branding").catch(error => req.log.warn({ err: error }, "Branding saved but activity recording failed"));
    res.json(saved);
  }));
}
