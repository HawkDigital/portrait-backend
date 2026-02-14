import express from "express";
import cors from "cors";
import sharp from "sharp";
import OpenAI from "openai";

const app = express();
app.use(cors());

// Increase payload limit because we're sending base64 images
app.use(express.json({ limit: "15mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple style map (MVP)
const STYLE_PROMPTS = {
  S01: "royal oil painting portrait, rich textures, dramatic lighting",
  S02: "modern cartoon portrait, clean lines, tasteful colors",
  S03: "minimal line art portrait, elegant, simple, high contrast",
  S04: "vintage film portrait, warm grain, soft light",
  S05: "watercolour portrait, soft washes, artistic texture",
  S06: "comic book portrait, bold ink lines, halftone shading",
  S07: "studio portrait, realistic, clean background, softbox lighting",
  S08: "pop art portrait, bold shapes, modern color blocking"
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
    if (!image_base64) return res.status(400).json({ error: "image_base64 required" });
    if (!style_id) return res.status(400).json({ error: "style_id required" });

    const prompt = STYLE_PROMPTS[style_id] || "stylized portrait";

    // Decode base64 image (strip any data URL prefix)
    const cleaned = image_base64.replace(/^data:image\/\w+;base64,/, "");
    const inputBuf = Buffer.from(cleaned, "base64");

    // Normalize input for model
    const inputPng = await sharp(inputBuf)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "cover" })
      .png()
      .toBuffer();

    // Generate stylized image (API-native)
    // If your account/model uses a different method, we swap this call.
    const dataUrl = `data:image/png;base64,${inputPng.toString("base64")}`;

const result = await openai.images.generate({
  model: "gpt-image-1",
  prompt: `Create a high quality portrait from the provided image in this style: ${prompt}. Keep the subject recognizable. Clean background.`
  ,
  // Pass the user photo as the reference image
  image: dataUrl
});


    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("AI response missing image");

    const generatedBuf = Buffer.from(b64, "base64");
    const watermarked = await watermarkPreview(generatedBuf);

    return res.json({
      preview_base64: watermarked.toString("base64")
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
