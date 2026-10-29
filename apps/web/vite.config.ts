import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const API = process.env.YAY_API ?? "http://localhost:8000";

/** Serve MediaPipe's wasm runtime from our own origin instead of a public CDN. */
function mediapipeWasm(): Plugin {
  const dir = fileURLToPath(new URL("./node_modules/@mediapipe/tasks-vision/wasm", import.meta.url));
  const prefix = "/mediapipe/wasm/";
  return {
    name: "mediapipe-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const name = req.url.slice(prefix.length).split("?")[0]!;
        if (!readdirSync(dir).includes(name)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(readFileSync(join(dir, name)));
      });
    },
    generateBundle() {
      for (const name of readdirSync(dir)) {
        this.emitFile({ type: "asset", fileName: `mediapipe/wasm/${name}`, source: readFileSync(join(dir, name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeWasm()],
  server: {
    port: 5173,
    // Same-origin API: cutout PNGs can be used as WebGL textures without CORS setup.
    proxy: {
      "/v1": API,
      "/files": API,
      "/health": API,
      // Benchmark endpoints (API runs with YAY_DEV_MODE=1). Not all of /dev: public/dev/
      // holds local test photos.
      "/dev/bench": API,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        bench: fileURLToPath(new URL("./bench.html", import.meta.url)),
      },
    },
  },
});
