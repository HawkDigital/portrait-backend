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

// Initialize storage buckets
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
  console.log("Supabase initialized");
}

// ============================================
// PROMPT SYSTEM
// ============================================

// Core Identity Lock Block - preserves likeness
const IDENTITY_LOCK = `
Use the reference image as the primary identity source.
Preserve:
- Exact facial structure
- Eye shape and spacing
- Nose base structure
- Lip shape
- Hairline and hairstyle
- Skin tone
- Ethnicity
- Facial hair details
- Expression essence
Exaggerate features but do NOT change identity.
The person must remain immediately recognisable.
`;

// Exaggeration Levels
const EXAGGERATION_LEVELS = {
  mild: `
Mild exaggeration level.
Enlarge head slightly (120-130%).
Subtle exaggeration of most distinctive feature.
Keep proportions mostly natural.
`,
  medium: `
Medium exaggeration level.
Head 140-150%.
Emphasise defining traits.
Widen smile.
Slightly enlarge eyes.
Increase nose length or width if distinctive.
`,
  bold: `
Bold exaggeration level.
Head 160%.
Push facial contrast.
Strong mouth exaggeration.
Elongated nose or jawline if appropriate.
More animated expression.
Still recognisable, not grotesque.
`
};

// Style Definitions
const STYLES = {
  S01: {
    name: "Classic Street Caricature",
    prompt: `
Professional street caricature illustration.
Thick confident black linework.
Smooth airbrushed shading.
Vibrant carnival colour palette.
Playful exaggerated expression.
Digital painting, semi-realistic shading.
Clean white highlight accents.
`
  },
  S02: {
    name: "Premium Gallery Caricature",
    prompt: `
High-end painterly caricature portrait.
Visible brush texture.
Soft blended shading.
Muted but rich colour palette.
Studio lighting.
Caricature exaggeration with refined realism.
Subtle texture overlay.
Elegant artistic finish.
`
  },
  S03: {
    name: "Bold Comic Line Caricature",
    prompt: `
High-contrast comic-style caricature.
Thick bold outlines.
Sharp shadows.
Slight halftone texture.
Bright saturated colours.
Dynamic expression.
Graphic poster-like finish.
`
  },
  S04: {
    name: "Soft Digital Cartoon",
    prompt: `
Soft digital cartoon caricature.
Rounded lines.
Gentle shading.
Pastel colour palette.
Warm cheerful expression.
Smooth gradients.
Family-friendly style.
`
  },
  S05: {
    name: "Ultra Airbrush Hyper Caricature",
    prompt: `
Highly exaggerated airbrush caricature.
Glossy skin highlights.
High saturation.
Extreme smile enhancement.
Dramatic lighting.
Large expressive eyes.
Ultra-clean finish.
`
  }
};

// Background Definitions
const BACKGROUNDS = {
  BG01: "Soft sky blue gradient background, subtle vignette.",
  BG02: "Warm peach to light orange gradient background.",
  BG03: "Pure white background, studio look.",
  BG04: "Soft blurred fairground background, shallow depth of field.",
  BG05: "Neutral beige studio gradient."
};

// Technical Requirements
const TECHNICAL_BLOCK = `
High resolution.
Ultra clean linework.
Smooth colour blending.
Print-ready quality.
Professional finish.
Maintain likeness accuracy.
`;

// Consistency Enhancers (Negative Prompt)
const NEGATIVE_PROMPT = `
distorted beyond recognition, generic cartoon, anime style, pixar style,
3D render, photorealistic, blurry, low quality, bad anatomy,
deformed face, extra limbs, watermark, signature, text
`;

// Build the full prompt from components
function buildPrompt(styleId, exaggeration = "medium", background = "BG01") {
  const style = STYLES[styleId] || STYLES.S01;
  const exaggerationBlock = EXAGGERATION_LEVELS[exaggeration] || EXAGGERATION_LEVELS.medium;
  const backgroundBlock = BACKGROUNDS[background] || BACKGROUNDS.BG01;

  const fullPrompt = `
Transform the reference image into a professional caricature illustration.

IDENTITY REQUIREMENTS:
${IDENTITY_LOCK}

EXAGGERATION:
${exaggerationBlock}

STYLE:
${style.prompt}

BACKGROUND:
${backgroundBlock}

TECHNICAL:
${TECHNICAL_BLOCK}
`.trim();

  return {
    prompt: fullPrompt,
    negative_prompt: NEGATIVE_PROMPT
  };
}

// Map frontend style IDs to backend config
// S01A = Style S01, Mild | S01B = Style S01, Medium | S01C = Style S01, Bold
function parseStyleId(styleId) {
  // Handle legacy format (S01, S02, etc.)
  if (!styleId || styleId.length <= 3) {
    return {
      style: styleId || "S01",
      exaggeration: "medium",
      background: "BG01"
    };
  }

  // Handle new format (S01A, S01B, S01C)
  const style = styleId.substring(0, 3); // S01, S02, etc.
  const level = styleId.substring(3, 4); // A, B, or C

  const exaggerationMap = {
    "A": "mild",
    "B": "medium",
    "C": "bold"
  };

  return {
    style: style,
    exaggeration: exaggerationMap[level] || "medium",
    background: "BG01" // Default, can be passed separately
  };
}

// Watermark helper
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

// Generate the AI image
async function generateStylizedImage(imageBuffer, styleId, background = "BG01") {
  const config = parseStyleId(styleId);
  const { prompt, negative_prompt } = buildPrompt(config.style, config.exaggeration, background);

  const inputPng = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .png()
    .toBuffer();

  const dataUrl = `data:image/png;base64,${inputPng.toString("base64")}`;

  console.log(`Generating: Style=${config.style}, Exaggeration=${config.exaggeration}, Background=${background}`);
  console.log(`Prompt preview: ${prompt.substring(0, 200)}...`);

  const output = await replicate.run(
    "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
    {
      input: {
        image: dataUrl,
        prompt: prompt,
        negative_prompt: negative_prompt,
        prompt_strength: 0.65,
        num_inference_steps: 30,
        guidance_scale: 7.5
      }
    }
  );

  const imageUrl = Array.isArray(output) ? output[0] : output;
  if (!imageUrl) throw new Error("No image returned from AI model");

  console.log("Generated image URL:", imageUrl);

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to fetch generated image: ${response.status}`);

  const generatedBuf = Buffer.from(await response.arrayBuffer());
  return watermarkPreview(generatedBuf);
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * GET /styles
 * Returns available styles, exaggeration levels, and backgrounds
 */
app.get("/styles", (req, res) => {
  res.json({
    styles: Object.entries(STYLES).map(([id, data]) => ({
      id,
      name: data.name
    })),
    exaggeration_levels: ["mild", "medium", "bold"],
    backgrounds: Object.entries(BACKGROUNDS).map(([id, description]) => ({
      id,
      description
    }))
  });
});

/**
 * POST /projects
 */
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

    if (dbError) {
      console.error("DB insert error:", dbError);
    }

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

/**
 * PUT /projects/:id/upload
 */
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

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      throw new Error("Failed to store image");
    }

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

/**
 * POST /projects/:id/upload-complete
 */
app.post("/projects/:id/upload-complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { style_id, exaggeration, background } = req.body || {};

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

    // Use request params or fall back to stored project params
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

    if (previewUploadError) {
      console.error("Preview upload error:", previewUploadError);
      throw new Error("Failed to store preview");
    }

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

/**
 * GET /projects/:id
 */
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

const PORT = process.env.PORT || 3000;

initSupabase().then(() => {
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize Supabase:", err);
  app.listen(PORT, () => console.log(`Server listening on ${PORT} (Supabase init failed)`));
});
