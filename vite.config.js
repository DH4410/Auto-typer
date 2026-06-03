import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function copyExtensionFiles() {
  const files = ["manifest.json", "background.js", "content.js"];

  return {
    name: "copy-extension-files",
    closeBundle() {
      const outDir = resolve("dist");
      mkdirSync(outDir, { recursive: true });
      for (const file of files) {
        copyFileSync(resolve(file), resolve(outDir, file));
      }
    }
  };
}

export default defineConfig({
  root: "src/sidepanel",
  plugins: [react(), copyExtensionFiles()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve("src/sidepanel/index.html")
    }
  }
});
