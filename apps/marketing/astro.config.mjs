import { defineConfig } from "astro/config";

// Astro loads env with an empty prefix, and under `vp run` Vite+'s loadEnv then reports every
// variable to the task cache. Any env difference (TERM, VP_RAW_SUBCOMMAND, an agent's session
// vars) would rerun `astro check`. Without the runner client, loadEnv reads process.env directly;
// file tracking does not use this client.
delete process.env.VP_RUN_NODE_CLIENT_PATH;

const port = Number(process.env.PORT ?? 4173);

// `site` decides the canonical and install-script origins baked into prerendered HTML, so a fork
// must resolve it from its own deployment instead of upstream's t3.codes.
const site = (() => {
  const explicitSite = process.env.MARKETING_SITE_URL?.trim();
  if (explicitSite) {
    return explicitSite;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  // Pages build absolute URLs from `Astro.site` without a request to fall back on.
  return `http://localhost:${port}`;
})();

export default defineConfig({
  site,
  server: {
    port,
  },
});
