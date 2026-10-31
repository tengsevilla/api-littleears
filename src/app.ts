import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./lib/env.js";
import routes from "./routes/index.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway: one proxy hop in front of the app
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    // The player fetches media with the Bearer header and seeks with Range requests.
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
