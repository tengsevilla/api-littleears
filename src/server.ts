import app from "./app.js";
import { env } from "./lib/env.js";
import { db } from "./lib/db.js";
import { startWorker } from "./worker/index.js";

const server = app.listen(env.PORT, () => {
  console.log(`api-littleears listening on :${env.PORT} (${env.NODE_ENV})`);
});

const worker = startWorker();

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  void worker.stop().finally(() => {
    server.close(() => {
      db.end().finally(() => process.exit(0));
    });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
