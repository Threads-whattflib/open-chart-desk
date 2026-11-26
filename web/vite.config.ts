import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開發時前端跑 5173，/api 與 /ws 轉給本機後端 8510
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8510",
      "/ws": { target: "ws://127.0.0.1:8510", ws: true },
    },
  },
});
