import express from "express";
import cors from "cors";
import sharp from "sharp";
import Replicate from "replicate";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// Validate API key at startup
if (!process.env.REPLICATE_API_TOKEN) {
  console.error("ERROR: REPLICATE_API_TOKEN environment variable is required");
  process.exit(1);
}

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

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

/**
 * POST /preview
 * body: { image_base64: "...", style_id: "S01" }
 * returns: { preview_base64: "..." }
 */
app.post("/preview", async (req, res) => {
  try {
    const { image_base64, style_id } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 required" });
    }
    if (!style_id) {
      return res.status(400).json({ error: "style_id required" });
    }
    if (!STYLE_PROMPTS[style_id]) {
      return res.status(400).json({ error: `Invalid style_id. Valid options: ${Object.keys(STYLE_PROMPTS).join(", ")}` });
    }

    const style = STYLE_PROMPTS[style_id];

    // Decode base64 image (strip any data URL prefix)
    const cleaned = image_base64.replace(/^data:image\/\w+;base64,/, "");
    const inputBuf = Buffer.from(cleaned, "base64");

    // Normalize input: resize and convert to PNG
    const inputPng = await sharp(inputBuf)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "cover" })
      .png()
      .toBuffer();

    // Create data URL for Replicate
    const dataUrl = `data:image/png;base64,${inputPng.toString("base64")}`;

    console.log(`Processing style ${style_id}: "${style.prompt}"`);

    // Use SDXL for image-to-image stylization
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

    // Output is a URL - fetch the generated image
    const imageUrl = Array.isArray(output) ? output[0] : output;

    if (!imageUrl) {
      throw new Error("No image returned from AI model");
    }

    console.log("Generated image URL:", imageUrl);

    // Fetch the generated image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch generated image: ${response.status}`);
    }

    const generatedBuf = Buffer.from(await response.arrayBuffer());
    const watermarked = await watermarkPreview(generatedBuf);

    return res.json({
      preview_base64: watermarked.toString("base64")
    });

  } catch (err) {
    console.error("Preview generation failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to generate preview"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
