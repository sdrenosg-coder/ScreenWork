import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { registerZipyRoutes } from "./zipy-routes";
import { registerSaasRoutes } from "./saas-routes";
import { registerWorkspaceReports } from "./workspace-reports";
import { registerBrandingRoutes } from "./branding-routes";
import { registerReaderRoutes } from "./reader-routes";
import { registerDraftRoutes } from "./draft-routes";
import { registerMediaRoutes } from "./media-routes";
import { registerSuiteRoutes } from "./suite-routes";
import { registerVisualRoutes } from "./visual-routes";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use("/api", router);
// Imported handlers use native Request.json()/formData(). Preserve the raw body,
// including multipart uploads, until the Fetch-to-Express boundary.
// Native multipart parsing must run before the inherited Fetch bridge consumes
// the request stream into a raw Buffer.
registerMediaRoutes(app);
app.use("/api", express.raw({ type: () => true, limit: "100mb" }));
registerSaasRoutes(app);
registerWorkspaceReports(app);
registerBrandingRoutes(app);
registerReaderRoutes(app);
registerDraftRoutes(app);
registerSuiteRoutes(app);
registerVisualRoutes(app);
registerZipyRoutes(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export default app;
