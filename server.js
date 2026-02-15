import express from "express";
import cors from "cors";
import sharp from "sharp";
import Replicate from "replicate";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

// For raw file uploads
app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "15mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// Validate API key at startup
if (!process.env.REPLICATE_API_TOKEN) {
  console.error("ERROR: REPLICATE_API_TOKEN environment variable is required");
  process.exit(1);
}

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

// In-memory storage for MVP (use Redis/S3 in production)
const projects = {};
const previews = {};

// Style prompts for each style ID
const STYLE_PROMPTS = {
  S01: {
    prompt: "royal oil painting portrait, rich textures, dramatic lighting, classical art style, museum quality",
    negative: "blurry, low quality, distorted face"
  },
  S02: {
    prompt: "modern cartoon portrait, clean lines, vibrant colors, pixar style, friendly expression",
    negative: "realistic, photograph, blurry"
  },
  S03: {
    prompt: "minimal line art portrait, elegant ink drawing, simple high contrast, white background",
    negative: "colorful, detailed background, realistic"
  },
  S04: {
    prompt: "vintage film portrait, warm grain, soft golden light, 1970s photography style, nostalgic",
    negative: "modern, digital, sharp, cold colors"
  },
  S05: {
    prompt: "watercolor portrait painting, soft washes, artistic brush strokes, delicate colors",
    negative: "digital art, sharp edges, photorealistic"
  },
  S06: {
    prompt: "comic book portrait, bold ink lines, halftone shading, superhero style, dynamic",
    negative: "realistic, soft, watercolor"
  },
  S07: {
    prompt: "professional studio portrait, realistic, clean white background, softbox lighting, headshot",
    negative: "artistic, stylized, colorful background"
  },
  S08: {
    prompt: "pop art portrait, andy warhol style, bold colors, graphic shapes, modern art",
    negative: "realistic, muted colors, traditional"
  }
};

// Watermark helper
async function watermarkPreview(buf) {
  const svg = Buffer.from(`
    <svg width="1200" height="1200">
      <style>
        .t { fill: rgba(255,255,255,0.55); font-size: 56px; font-family: Arial, sans-serif; font-weight: 800; }
      </style>
      <text x="50%" y="92%" text-anchor="middle" class="t">PREVIEW</text>
    </svg>
  `);

  return sharp(buf)
    .resize({ width: 1200, withoutEnlargement: true })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Generate the AI image
async function generateStylizedImage(imageBuffer, styleId) {
  const style = STYLE_PROMPTS[styleId] || STYLE_PROMPTS["S01"];

  // Normalize input: resize and convert to PNG
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
  if (!imageUrl) {
    throw new Error("No image returned from AI model");
  }

  console.log("Generated image URL:", imageUrl);

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch generated image: ${response.status}`);
  }

  const generatedBuf = Buffer.from(await response.arrayBuffer());
  return watermarkPreview(generatedBuf);
}

/**
 * POST /projects
 * body: { style_id, aspect_ratio, filename, mime_type }
 * returns: { project_id, upload_url }
 */
app.post("/projects", (req, res) => {
  try {
    const { style_id, aspect_ratio, filename, mime_type } = req.body || {};

    const project_id = uuidv4();

    projects[project_id] = {
      style_id: style_id || "S01",
      aspect_ratio: aspect_ratio || "2:3",
      filename,
      mime_type,
      status: "created",
      image: null,
      created_at: Date.now()
    };

    // Return URL to our own upload endpoint
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
 * Accepts raw image file in body
 */
app.put("/projects/:id/upload", (req, res) => {
  try {
    const { id } = req.params;

    if (!projects[id]) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: "No file data received" });
    }

    projects[id].image = req.body;
    projects[id].status = "uploaded";

    console.log(`Image uploaded for project ${id}: ${req.body.length} bytes`);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

/**
 * POST /projects/:id/upload-complete
 * Triggers AI generation
 * returns: { preview_url }
 */
app.post("/projects/:id/upload-complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { style_id } = req.body || {};

    if (!projects[id]) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (!projects[id].image) {
      return res.status(400).json({ error: "No image uploaded for this project" });
    }

    const finalStyleId = style_id || projects[id].style_id || "S01";

    console.log(`Generating preview for project ${id} with style ${finalStyleId}`);

    const previewBuffer = await generateStylizedImage(projects[id].image, finalStyleId);

    // Store preview and create URL
    const previewId = uuidv4();
    previews[previewId] = {
      buffer: previewBuffer,
      created_at: Date.now()
    };

    const host = req.get("host");
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const preview_url = `${protocol}://${host}/previews/${previewId}.jpg`;

    projects[id].status = "preview_ready";
    projects[id].preview_id = previewId;

    // Clean up the original image from memory
    projects[id].image = null;

    console.log(`Preview ready: ${preview_url}`);

    res.json({ preview_url });
  } catch (err) {
    console.error("Generation failed:", err);
    res.status(500).json({ error: err.message || "Failed to generate preview" });
  }
});

/**
 * GET /previews/:id.jpg
 * Serves the generated preview image
 */
app.get("/previews/:id.jpg", (req, res) => {
  const id = req.params.id.replace(".jpg", "");

  if (!previews[id]) {
    return res.status(404).send("Preview not found");
  }

  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(previews[id].buffer);
});

// Cleanup old projects/previews every 10 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const id in projects) {
    if (now - projects[id].created_at > maxAge) {
      delete projects[id];
    }
  }

  for (const id in previews) {
    if (now - previews[id].created_at > maxAge) {
      delete previews[id];
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
