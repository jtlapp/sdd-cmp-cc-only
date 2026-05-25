import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`taxon-tree server listening on http://localhost:${info.port}`);
});
