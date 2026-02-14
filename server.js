import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

const projects = {};

app.post("/projects", (req, res) => {
  const project_id = uuidv4();

  projects[project_id] = {
    style_id: req.body.style_id,
    aspect_ratio: req.body.aspect_ratio,
    status: "created"
  };

  res.json({
    project_id,
    upload_url: "https://httpbin.org/put"
  });
});

app.post("/projects/:id/upload-complete", (req, res) => {
  const { id } = req.params;

  if (!projects[id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  projects[id].status = "preview_ready";

  res.json({
    preview_url: "https://picsum.photos/600/900"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running");
});
