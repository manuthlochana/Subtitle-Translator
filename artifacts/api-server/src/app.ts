import path from "node:path";
import fs from "node:fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Optionally serve the built frontend (SPA) from the same process.
// Enabled when STATIC_DIR points to a directory containing index.html
// (e.g. artifacts/subtitle-translator/dist/public).
const staticDir = process.env["STATIC_DIR"]
  ? path.resolve(process.env["STATIC_DIR"])
  : undefined;

if (staticDir && fs.existsSync(path.join(staticDir, "index.html"))) {
  const indexHtml = path.join(staticDir, "index.html");
  app.use(express.static(staticDir, { index: "index.html", maxAge: "1h" }));
  // SPA fallback: any non-API GET/HEAD request returns index.html
  app.use((req, res, next) => {
    if (
      (req.method !== "GET" && req.method !== "HEAD") ||
      req.path.startsWith("/api")
    ) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
  logger.info({ staticDir }, "Serving static frontend");
} else if (staticDir) {
  logger.warn({ staticDir }, "STATIC_DIR set but index.html not found");
}

export default app;
