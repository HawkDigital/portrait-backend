import express from "express";
import cors from "cors";
import sharp from "sharp";
import Replicate from "replicate";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "15mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// Validate required env vars
if (!process.env.REPLICATE_API_TOKEN) {
  console.error("ERROR: REPLICATE_API_TOKEN required");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SECRET_KEY required");
  process.exit(1);
}

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// ============================================
// PROMPT CACHE
// ============================================
let promptCache = {
  styles: {},
  exaggeration: {},
  backgrounds: {},
  config: {},
  lastLoaded: null
};

async function loadPrompts() {
  console.log("Loading prompts from Supabase...");

  try {
    const { data: styles } = await supabase
      .from("styles")
      .select("*")
      .eq("active", true)
      .order("sort_order");

    promptCache.styles = {};
    styles?.forEach(s => {
      promptCache.styles[s.id] = {
        name: s.name,
        prompt: s.prompt,
        model: s.model || "photomaker-style",
        model_params: s.model_params || {}
      };
    });

    const { data: exaggeration } = await supabase
      .from("exaggeration_levels")
      .select("*")
      .order("sort_order");

    promptCache.exaggeration = {};
    exaggeration?.forEach(e => {
      promptCache.exaggeration[e.id] = { name: e.name, prompt: e.prompt };
    });

    const { data: backgrounds } = await supabase
      .from("backgrounds")
      .select("*")
      .order("sort_order");

    promptCache.backgrounds = {};
    backgrounds?.forEach(b => {
      promptCache.backgrounds[b.id] = { name: b.name, prompt: b.prompt };
    });

    const { data: config } = await supabase
      .from("prompt_config")
      .select("*");

    promptCache.config = {};
    config?.forEach(c => {
      promptCache.config[c.key] = c.value;
    });

    promptCache.lastLoaded = Date.now();
    console.log(`Prompts loaded: ${Object.keys(promptCache.styles).length} styles`);
    return true;
  } catch (err) {
    console.error("Failed to load prompts:", err);
    return false;
  }
}

setInterval(loadPrompts, 5 * 60 * 1000);

// ============================================
// PROMPT BUILDER
// ============================================

function buildPrompt(styleId, exaggeration = "medium", background = "BG01") {
  const style = promptCache.styles[styleId] || promptCache.styles["S01"] || { prompt: "portrait" };
  const exag = promptCache.exaggeration[exaggeration] || promptCache.exaggeration["medium"] || { prompt: "" };
  const bg = promptCache.backgrounds[background] || promptCache.backgrounds["BG01"] || { prompt: "" };

  const identityLock = promptCache.config["identity_lock"] || "";
  const technical = promptCache.config["technical"] || "";
  const negativePrompt = promptCache.config["negative_prompt"] || "distorted face, bad anatomy, blurry";

  // Build prompt for PhotoMaker - uses 'img' trigger word
  const fullPrompt = `
A portrait of a person img, ${style.prompt}
${exag.prompt}
${bg.prompt}
${technical}
`.trim().replace(/\n+/g, ', ').replace(/,\s*,/g, ',');

  return {
    prompt: fullPrompt,
    negative_prompt: negativePrompt,
    style: style
  };
}

function parseStyleId(styleId) {
  if (!styleId || styleId.length <= 3) {
    return {
      style: styleId || "S01",
      exaggeration: "medium",
      background: "BG01"
    };
  }

  const style = styleId.substring(0, 3);
  const level = styleId.substring(3, 4);
  const exaggerationMap = { "A": "mild", "B": "medium", "C": "bold" };

  return {
    style: style,
    exaggeration: exaggerationMap[level] || "medium",
    background: "BG01"
  };
}

// ============================================
// IMAGE PROCESSING
// ============================================

async function watermarkPreview(buf) {
  const resized = await sharp(buf)
    .resize({ width: 1200, withoutEnlargement: true })
    .toBuffer();

  const metadata = await sharp(resized).metadata();
  const width = metadata.width || 1200;
  const height = metadata.height || 1200;

  const svg = Buffer.from(`
    <svg width="${width}" height="${height}">
      <style>
        .t { fill: rgba(255,255,255,0.55); font-size: 48px; font-family: Arial, sans-serif; font-weight: 800; }
      </style>
      <text x="50%" y="92%" text-anchor="middle" class="t">PREVIEW</text>
    </svg>
  `);

  return sharp(resized)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ============================================
// TWO-STAGE GENERATION PIPELINE
// ============================================

// Retry helper for rate limits
async function runWithRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.message?.includes('429') && attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 5000; // 10s, 20s, 40s
        console.log(`Rate limited, waiting ${waitTime/1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, waitTime));
      } else {
        throw err;
      }
    }
  }
}

// Stage 1: Generate with PhotoMaker
async function generateWithPhotomaker(imageDataUrl, promptData, styleConfig) {
  const modelParams = styleConfig.model_params || {};

  console.log(`[Stage 1] PhotoMaker generation`);
  console.log(`  Style: ${modelParams.style_name || 'No style'}`);
  console.log(`  Prompt: ${promptData.prompt.substring(0, 100)}...`);

  const output = await runWithRetry(() => replicate.run(
    "tencentarc/photomaker-style:467d062309da518648ba89d226490e02b8ed09b5abc15026e54e31c5a8cd0769",
    {
      input: {
        input_image: imageDataUrl,
        prompt: promptData.prompt,
        negative_prompt: promptData.negative_prompt,
        style_name: modelParams.style_name || "(No style)",
        style_strength_ratio: modelParams.style_strength_ratio || 30,
        num_steps: 30,
        guidance_scale: 5,
        num_outputs: 1,
        disable_safety_checker: true
      }
    }
  ));

  const imageUrl = Array.isArray(output) ? output[0] : output;
  if (!imageUrl) throw new Error("No image returned from PhotoMaker");

  console.log(`[Stage 1] Complete: ${imageUrl}`);
  return imageUrl;
}

// Stage 2: Upscale with Real-ESRGAN
async function upscaleImage(imageUrl) {
  const upscaleEnabled = promptCache.config["upscale_enabled"] === "true";

  if (!upscaleEnabled) {
    console.log(`[Stage 2] Upscaling disabled, fetching original`);
    const response = await fetch(imageUrl);
    return Buffer.from(await response.arrayBuffer());
  }

  const scale = parseInt(promptCache.config["upscale_scale"] || "2");

  console.log(`[Stage 2] Upscaling ${scale}x with Real-ESRGAN`);

  const output = await runWithRetry(() => replicate.run(
    "nightmareai/real-esrgan:b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8",
    {
      input: {
        image: imageUrl,
        scale: scale,
        face_enhance: true
      }
    }
  ));

  const upscaledUrl = typeof output === 'string' ? output : output?.output || output;
  if (!upscaledUrl) throw new Error("No image returned from upscaler");

  console.log(`[Stage 2] Complete: ${upscaledUrl}`);

  const response = await fetch(upscaledUrl);
  return Buffer.from(await response.arrayBuffer());
}

// Main generation function
async function generateStylizedImage(imageBuffer, styleId, background = "BG01") {
  const config = parseStyleId(styleId);
  const promptData = buildPrompt(config.style, config.exaggeration, background);
  const styleConfig = promptCache.styles[config.style] || promptCache.styles["S01"] || {};

  // Prepare input image
  const inputPng = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .png()
    .toBuffer();

  const dataUrl = `data:image/png;base64,${inputPng.toString("base64")}`;

  console.log(`\n========== GENERATION START ==========`);
  console.log(`Style: ${config.style}, Exaggeration: ${config.exaggeration}, Background: ${background}`);

  // Stage 1: Generate
  const generatedUrl = await generateWithPhotomaker(dataUrl, promptData, styleConfig);

  // Stage 2: Upscale
  const upscaledBuffer = await upscaleImage(generatedUrl);

  // Add watermark
  const watermarked = await watermarkPreview(upscaledBuffer);

  console.log(`========== GENERATION COMPLETE ==========\n`);

  return watermarked;
}

// ============================================
// API ENDPOINTS
// ============================================

app.get("/styles", async (req, res) => {
  res.json({
    styles: Object.entries(promptCache.styles).map(([id, data]) => ({
      id,
      name: data.name
    })),
    exaggeration_levels: Object.entries(promptCache.exaggeration).map(([id, data]) => ({
      id,
      name: data.name
    })),
    backgrounds: Object.entries(promptCache.backgrounds).map(([id, data]) => ({
      id,
      name: data.name
    }))
  });
});

app.post("/reload-prompts", async (req, res) => {
  const success = await loadPrompts();
  res.json({ success, loaded_at: promptCache.lastLoaded });
});

app.post("/projects", async (req, res) => {
  try {
    const { style_id, exaggeration, background, aspect_ratio, filename, mime_type } = req.body || {};
    const project_id = uuidv4();

    const { error: dbError } = await supabase
      .from("projects")
      .insert({
        id: project_id,
        style_id: style_id || "S01",
        exaggeration: exaggeration || "medium",
        background: background || "BG01",
        aspect_ratio: aspect_ratio || "2:3",
        filename,
        mime_type,
        status: "created"
      });

    if (dbError) console.error("DB insert error:", dbError);

    const host = req.get("host");
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const upload_url = `${protocol}://${host}/projects/${project_id}/upload`;

    console.log(`Project created: ${project_id}`);
    res.json({ project_id, upload_url });
  } catch (err) {
    console.error("Create project failed:", err);
    res.status(500).json({ error: err.message || "Failed to create project" });
  }
});

app.put("/projects/:id/upload", async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: "No file data received" });
    }

    const filePath = `${id}/original.jpg`;
    const { error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(filePath, req.body, {
        contentType: "image/jpeg",
        upsert: true
      });

    if (uploadError) throw new Error("Failed to store image");

    await supabase
      .from("projects")
      .update({ status: "uploaded" })
      .eq("id", id);

    console.log(`Image uploaded for project ${id}: ${req.body.length} bytes`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

app.post("/projects/:id/upload-complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { style_id, background } = req.body || {};

    const { data: project } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .single();

    const { data: imageData, error: downloadError } = await supabase.storage
      .from("uploads")
      .download(`${id}/original.jpg`);

    if (downloadError || !imageData) {
      throw new Error("No image found for this project");
    }

    const imageBuffer = Buffer.from(await imageData.arrayBuffer());
    const finalStyleId = style_id || project?.style_id || "S01";
    const finalBackground = background || project?.background || "BG01";

    console.log(`Generating preview for project ${id}`);

    const previewBuffer = await generateStylizedImage(imageBuffer, finalStyleId, finalBackground);

    const previewPath = `${id}/preview.jpg`;
    const { error: previewUploadError } = await supabase.storage
      .from("previews")
      .upload(previewPath, previewBuffer, {
        contentType: "image/jpeg",
        upsert: true
      });

    if (previewUploadError) throw new Error("Failed to store preview");

    const { data: urlData } = supabase.storage
      .from("previews")
      .getPublicUrl(previewPath);

    const preview_url = urlData.publicUrl;

    await supabase
      .from("projects")
      .update({
        status: "preview_ready",
        preview_url,
        style_id: finalStyleId,
        background: finalBackground
      })
      .eq("id", id);

    console.log(`Preview ready: ${preview_url}`);
    res.json({ preview_url });
  } catch (err) {
    console.error("Generation failed:", err);
    res.status(500).json({ error: err.message || "Failed to generate preview" });
  }
});

app.get("/projects/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: project, error } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !project) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(project);
  } catch (err) {
    console.error("Get project failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STARTUP
// ============================================

async function initSupabase() {
  const buckets = ["uploads", "previews"];
  for (const bucket of buckets) {
    const { error } = await supabase.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: 15 * 1024 * 1024
    });
    if (error && !error.message.includes("already exists")) {
      console.error(`Failed to create bucket ${bucket}:`, error.message);
    }
  }
  console.log("Supabase storage initialized");
}

const PORT = process.env.PORT || 3000;

Promise.all([initSupabase(), loadPrompts()])
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
  })
  .catch(err => {
    console.error("Startup error:", err);
    app.listen(PORT, () => console.log(`Server listening on ${PORT} (with errors)`));
  });
