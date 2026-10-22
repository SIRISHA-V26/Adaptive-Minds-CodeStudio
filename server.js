
import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JUDGE0_URL =
  process.env.JUDGE0_URL || "https://ce.judge0.com";

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/api/code/run",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false
  })
);

const languageIds = {
  python: 71,
  javascript: 63,
  java: 62,
  c: 50,
  cpp: 54
};

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

app.post("/api/code/run", async (req, res) => {
  try {
    const { source_code, language, stdin = "" } = req.body;

    if (
      typeof source_code !== "string" ||
      !source_code.trim() ||
      source_code.length > 50000
    ) {
      return res.status(400).json({
        error: "Code must be provided and be under 50 KB."
      });
    }

    if (
      typeof stdin !== "string" ||
      stdin.length > 10000
    ) {
      return res.status(400).json({
        error: "Input must be text under 10 KB."
      });
    }

    const languageId = languageIds[language];

    if (!languageId) {
      return res.status(400).json({
        error: "Unsupported programming language."
      });
    }

    const submitResponse = await fetch(
      `${JUDGE0_URL}/submissions?base64_encoded=false&wait=false`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_code,
          language_id: languageId,
          stdin,
          cpu_time_limit: 2,
          memory_limit: 128000
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!submitResponse.ok) {
      const details = await submitResponse.text();
      console.error("Judge0 submission error:", details);

      return res.status(502).json({
        error: "The code execution service rejected the request."
      });
    }

    const { token } = await submitResponse.json();

    if (!token) {
      return res.status(502).json({
        error: "The execution service did not return a token."
      });
    }

    // Poll until the submission finishes, up to about 30 seconds.
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(1000);

      const resultResponse = await fetch(
        `${JUDGE0_URL}/submissions/${token}?base64_encoded=false`,
        { signal: AbortSignal.timeout(8000) }
      );

      if (!resultResponse.ok) {
        return res.status(502).json({
          error: "Could not retrieve the execution result."
        });
      }

      const result = await resultResponse.json();
      const statusId = result.status?.id;

      // Status 1 = In Queue; 2 = Processing.
      if (statusId > 2) {
        return res.json({
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          compile_output: result.compile_output || "",
          message: result.message || "",
          status: result.status?.description || "Finished",
          time: result.time,
          memory: result.memory
        });
      }
    }

    return res.status(504).json({
      error: "Execution timed out while waiting for the service."
    });
  } catch (error) {
    console.error("Code execution error:", error);

    return res.status(502).json({
      error: "Unable to reach the code execution service."
    });
  }
});

app.listen(PORT, () => {
  console.log(`CodeStudio running at http://localhost:${PORT}`);
});
