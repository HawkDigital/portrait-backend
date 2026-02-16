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

// Initialize storage buckets (run once on startup)
async function initSupabase() {
  // Create buckets if they don't exist
  const buckets = ["uploads", "previews"];
  for (const bucket of buckets) {
    const { error } = await supabase.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: 15 * 1024 * 1024 // 15MB
    });
    if (error && !error.message.includes("already exists")) {
      console.error(`Failed to create bucket ${bucket}:`, error.message);
    }
  }

  // Create projects table if it doesn't exist
  const { error: tableError } = await supabase.rpc('create_projects_table_if_not_exists').catch(() => ({}));
  // Table creation will be handled via Supabase dashboard if RPC doesn't exist

  console.log("Supabase initialized");
}

// Style prompts - supports both main styles (S01) and substyles (S01A, S01B, S01C)
const STYLE_PROMPTS = {
  // Caricature
  S01: { prompt: "caricature portrait, exaggerated features, fun cartoon style", negative: "realistic, photograph" },
  S01A: { prompt: "classic caricature portrait, traditional caricature art, exaggerated features, fun expressive style", negative: "realistic, photograph, serious" },
  S01B: { prompt: "extremely exaggerated caricature, very big head, tiny body, humorous cartoon style, bold lines", negative: "realistic, subtle, photograph" },
  S01C: { prompt: "subtle caricature portrait, slightly stylized features, gentle exaggeration, tasteful cartoon", negative: "extreme, grotesque, realistic photo" },

  // Cartoon
  S02: { prompt: "modern cartoon portrait, clean lines, vibrant colors", negative: "realistic, photograph" },
  S02A: { prompt: "pixar style 3D cartoon portrait, smooth rendering, big expressive eyes, friendly character design", negative: "2D, flat, realistic, anime" },
  S02B: { prompt: "anime portrait, japanese animation style, big eyes, colorful hair highlights, manga inspired", negative: "western cartoon, realistic, 3D" },
  S02C: { prompt: "flat design cartoon portrait, minimal shading, bold solid colors, vector art style, simple shapes", negative: "3D, detailed shading, realistic" },

  // Line Art
  S03: { prompt: "line art portrait, ink drawing, clean lines", negative: "colored, painted, photograph" },
  S03A: { prompt: "minimal line art portrait, single continuous line, elegant simplicity, white background, delicate strokes", negative: "detailed, shaded, colored, complex" },
  S03B: { prompt: "detailed line art portrait, intricate ink drawing, fine linework, crosshatching, pen illustration", negative: "minimal, simple, colored" },
  S03C: { prompt: "pencil sketch portrait, loose gestural drawing, artistic sketch marks, graphite texture", negative: "clean lines, digital, colored" },

  // Vintage
  S04: { prompt: "vintage portrait, retro photography style", negative: "modern, digital, colorful" },
  S04A: { prompt: "film noir portrait, high contrast black and white, dramatic shadows, 1940s detective movie style", negative: "colorful, bright, modern" },
  S04B: { prompt: "sepia tone vintage portrait, old photograph style, warm brown tones, antique feeling, faded edges", negative: "modern, colorful, sharp" },
  S04C: { prompt: "1970s retro portrait, warm film grain, golden hour lighting, vintage color photography, nostalgic", negative: "modern, digital, cold tones" },

  // Watercolour
  S05: { prompt: "watercolor portrait painting, soft washes, artistic", negative: "digital, sharp, photograph" },
  S05A: { prompt: "soft watercolor portrait, gentle washes, delicate blending, light pastel tones, dreamy ethereal", negative: "bold, saturated, digital" },
  S05B: { prompt: "bold watercolor portrait, vibrant splashes, expressive brush strokes, saturated colors, dynamic", negative: "subtle, pale, controlled" },
  S05C: { prompt: "pastel watercolor portrait, muted soft colors, gentle palette, peaceful serene mood, light washes", negative: "vibrant, bold, saturated" },

  // Comic
  S06: { prompt: "comic book portrait, bold lines, dynamic style", negative: "realistic, photograph, soft" },
  S06A: { prompt: "superhero comic portrait, bold ink lines, dramatic lighting, marvel dc style, heroic pose, halftone dots", negative: "manga, soft, realistic" },
  S06B: { prompt: "manga portrait, japanese comic style, speed lines, expressive eyes, black and white ink, screentone", negative: "western comic, colored, realistic" },
  S06C: { prompt: "graphic novel portrait, artistic comic style, moody noir shading, sophisticated illustration", negative: "cartoon, bright colors, childish" },

  // Oil Painting
  S07: { prompt: "oil painting portrait, classical art, rich textures", negative: "digital, photograph, flat" },
  S07A: { prompt: "renaissance oil portrait, classical master painting, dramatic chiaroscuro, museum quality, ornate gold frame style", negative: "modern, flat, digital" },
  S07B: { prompt: "impressionist oil portrait, visible brush strokes, dappled light, monet renoir style, soft colors", negative: "sharp, photorealistic, flat" },
  S07C: { prompt: "modern oil painting portrait, contemporary art style, bold brush strokes, expressive colors, gallery art", negative: "classical, traditional, photograph" },

  // Pop Art
  S08: { prompt: "pop art portrait, bold colors, graphic style", negative: "realistic, muted, photograph" },
  S08A: { prompt: "andy warhol style pop art portrait, bright flat colors, screen print effect, repetition, iconic", negative: "realistic, painterly, subtle" },
  S08B: { prompt: "roy lichtenstein pop art portrait, ben day dots, comic book style, bold outlines, primary colors, speech bubble", negative: "realistic, soft, painterly" },
  S08C: { prompt: "neon pop art portrait, vibrant glowing colors, fluorescent palette, electric blue pink green, synthwave", negative: "muted, realistic, traditional" }
};

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
async function generateStylizedImage(imageBuffer, styleId) {
  const style = STYLE_PROMPTS[styleId] || STYLE_PROMPTS["S01"];

  const inputPng = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .png()
    .toBuffer();

  const dataUrl = `data:image/png;base64,${inputPng.toString("base64")}`;

  console.log(`Processing style ${styleId}: "${style.prompt}"`);

  const output = await replicate.run(
    "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
    {
      input: {
        image: dataUrl,
        prompt: `portrait of a person, ${style.prompt}, high quality, detailed`,
        negative_prompt: style.negative || "blurry, low quality, distorted",
        prompt_strength: 0.6,
        num_inference_steps: 25,
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

/**
 * POST /projects
 * body: { style_id, aspect_ratio, filename, mime_type }
 * returns: { project_id, upload_url }
 */
app.post("/projects", async (req, res) => {
  try {
    const { style_id, aspect_ratio, filename, mime_type } = req.body || {};
    const project_id = uuidv4();

    // Store project in Supabase
    const { error: dbError } = await supabase
      .from("projects")
      .insert({
        id: project_id,
        style_id: style_id || "S01",
        aspect_ratio: aspect_ratio || "2:3",
        filename,
        mime_type,
        status: "created"
      });

    if (dbError) {
      console.error("DB insert error:", dbError);
      // Continue anyway - storage will still work
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
 * Accepts raw image file, stores in Supabase
 */
app.put("/projects/:id/upload", async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: "No file data received" });
    }

    // Upload to Supabase storage
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

    // Update project status
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
 * Triggers AI generation, stores result in Supabase
 * returns: { preview_url }
 */
app.post("/projects/:id/upload-complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { style_id } = req.body || {};

    // Get project from database
    const { data: project } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .single();

    // Download uploaded image from Supabase storage
    const { data: imageData, error: downloadError } = await supabase.storage
      .from("uploads")
      .download(`${id}/original.jpg`);

    if (downloadError || !imageData) {
      throw new Error("No image found for this project");
    }

    const imageBuffer = Buffer.from(await imageData.arrayBuffer());
    const finalStyleId = style_id || project?.style_id || "S01";

    console.log(`Generating preview for project ${id} with style ${finalStyleId}`);

    const previewBuffer = await generateStylizedImage(imageBuffer, finalStyleId);

    // Upload preview to Supabase storage
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

    // Get public URL for preview
    const { data: urlData } = supabase.storage
      .from("previews")
      .getPublicUrl(previewPath);

    const preview_url = urlData.publicUrl;

    // Update project status
    await supabase
      .from("projects")
      .update({
        status: "preview_ready",
        preview_url,
        style_id: finalStyleId
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
 * Get project status and details
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

// Initialize Supabase then start server
initSupabase().then(() => {
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize Supabase:", err);
  // Start anyway - might work without bucket creation
  app.listen(PORT, () => console.log(`Server listening on ${PORT} (Supabase init failed)`));
});
