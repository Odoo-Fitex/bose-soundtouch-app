import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: { target: "es2022", outDir: "dist" },
  server: { host: true, port: 5173 },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "SoundTide",
        short_name: "SoundTide",
        description: "Local-first replacement app for Bose SoundTouch 10/20/30",
        theme_color: "#1F3A5F",
        background_color: "#0E1320",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /\/health$/,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /\/(devices|presets|scenes|schedules|nas)/,
            handler: "NetworkFirst",
            options: { cacheName: "soundtide-api", networkTimeoutSeconds: 4 },
          },
        ],
      },
    }),
  ],
});
