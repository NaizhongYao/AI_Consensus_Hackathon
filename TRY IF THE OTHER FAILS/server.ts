import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

const MYMIZU_API_KEY = "56b13329-6163-4884-afc8-b6839cd3f618";
let MYMIZU_USER_TOKEN: string | null = null;
let TOKEN_EXPIRY: number = 0;

async function getMymizuToken() {
  if (MYMIZU_USER_TOKEN && Date.now() < TOKEN_EXPIRY) {
    return MYMIZU_USER_TOKEN;
  }
  
  const res = await fetch(`https://api.mymizu.co/api/start?api_key=${MYMIZU_API_KEY}&platform=ios&client_version=1.0.0&client_build=12345&uuid=material-recovery-app-001`);
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();
  MYMIZU_USER_TOKEN = data.new_token;
  TOKEN_EXPIRY = Date.now() + 1000 * 60 * 50; // Cache for 50 minutes (assuming standard 1h token)
  return MYMIZU_USER_TOKEN;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API Route to fetch mymizu spots
  app.get("/api/mymizu/spots", async (req, res) => {
    try {
      const token = await getMymizuToken();
      
      const params = new URLSearchParams({
        api_key: MYMIZU_API_KEY,
        user_token: token || "",
        latitude: String(req.query.lat || 35.6804),
        longitude: String(req.query.lng || 139.7690),
        radius: String(req.query.radius || 20000)
      });
      
      const spotsRes = await fetch(`https://api.mymizu.co/api/spots?${params.toString()}`);
      if (!spotsRes.ok) throw new Error(`Spots fetch failed: ${spotsRes.status}`);
      const spotsData = await spotsRes.json();
      res.json(spotsData);
    } catch (error: any) {
      console.error("Mymizu backend proxy error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
