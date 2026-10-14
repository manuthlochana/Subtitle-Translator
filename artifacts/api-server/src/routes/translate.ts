import { Router, type IRouter } from "express";
import { MODEL_REGISTRY, getModel } from "../translator/models";
import { parseSrt, SrtParseError } from "../translator/srt";
import { TranslationJob } from "../translator/engine";
import { getJob, registerJob, deleteJob } from "../translator/store";

const router: IRouter = Router();

// GET /api/translate/models - returns list of supported models with quotas and strategies
router.get("/translate/models", (_req, res) => {
  res.json({
    models: MODEL_REGISTRY,
  });
});

// POST /api/translate/jobs - creates a new translation job
router.post("/translate/jobs", (req, res) => {
  try {
    const { srtContent, fileName, apiKey, modelId, mode, chunkSize } = req.body;

    if (!srtContent || typeof srtContent !== "string") {
      res.status(400).json({ error: "Missing or invalid srtContent" });
      return;
    }

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      res.status(400).json({ error: "Valid Gemini API Key is required" });
      return;
    }

    const selectedModel = modelId ? getModel(modelId) : undefined;
    const finalModelId = selectedModel ? selectedModel.id : "gemini-3.5-flash-lite";

    const blocks = parseSrt(srtContent);

    const job = new TranslationJob(
      fileName || "subtitles.srt",
      blocks,
      {
        apiKey: apiKey.trim(),
        modelId: finalModelId,
        mode: mode || "auto",
        chunkSize: typeof chunkSize === "number" ? chunkSize : 90,
      }
    );

    registerJob(job);
    job.start();

    res.status(201).json(job.snapshot());
  } catch (err) {
    if (err instanceof SrtParseError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create translation job" });
  }
});

// GET /api/translate/jobs/:id - fetch job status and progress snapshot
router.get("/translate/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job.snapshot());
});

// POST /api/translate/jobs/:id/action - pause, resume, cancel
router.post("/translate/jobs/:id/action", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const { action, update } = req.body;
  if (action === "pause") {
    job.pause();
  } else if (action === "resume") {
    job.resume(update);
  } else if (action === "cancel") {
    job.cancel();
  } else {
    res.status(400).json({ error: `Unknown action: ${action}` });
    return;
  }

  res.json(job.snapshot());
});

// GET /api/translate/jobs/:id/download - export the generated .srt file
router.get("/translate/jobs/:id/download", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const { content } = job.toSrt();
  const safeBaseName = job.fileName.replace(/\.[^/.]+$/, "") || "subtitles";
  const downloadName = `${safeBaseName}_Sinhala.srt`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  res.send(content);
});

export default router;
