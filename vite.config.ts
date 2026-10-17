import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  base: "/v1.1/",
  plugins: [
    {
      name: "mirror-version-assets",
      enforce: "pre",
      transform(code, id) {
        if (id.includes("node_modules") || !/\.(?:tsx?|json)$/.test(id.split("?")[0])) return;
        return code.replaceAll("/assets/", "/v1.1/assets/");
      },
    },
    react(),
  ],
  optimizeDeps: { include: mode === "test" ? [] : ["@xmaxai/web-sdk"] },
  resolve: {
    alias: {
      "cos-js-sdk-v5": fileURLToPath(new URL("./node_modules/cos-js-sdk-v5/src/cos.js", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    headers: { "Cache-Control": "no-store" },
    proxy: {
      "/v1.1/api": {
        target: "http://127.0.0.1:3002",
        rewrite: path => path.replace(/^\/v1\.1(?=\/)/, ""),
      },
    },
    fs: { deny: ["**/.env", "**/.env.*", "**/.data/**", "**/server/**", "**/.git/**", "**/*.{crt,pem,key}"] },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
}));
