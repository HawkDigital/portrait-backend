import sharp from "sharp";

// Create a simple test image with face-like colors
const testImageBuf = await sharp({
  create: {
    width: 200,
    height: 200,
    channels: 3,
    background: { r: 220, g: 180, b: 160 }
  }
}).jpeg().toBuffer();

const testImage = testImageBuf.toString("base64");

console.log("Testing with cartoon style (S02)...\n");

const res = await fetch("https://portrait-backend-b08c.onrender.com/preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ image_base64: testImage, style_id: "S02" })
});

const data = await res.json();
console.log("Status:", res.status);

if (data.preview_base64) {
  console.log("SUCCESS!");
  // Save the result to see it
  const buf = Buffer.from(data.preview_base64, "base64");
  const fs = await import("fs");
  fs.writeFileSync("result.jpg", buf);
  console.log("Saved to result.jpg");
} else {
  console.log("Error:", data.error);
}
