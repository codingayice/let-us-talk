import { buildApp } from "./app.js";
import { config } from "./config.js";
import { chatModel } from "./model.js";

const app = buildApp({ chatModel });
await app.listen({ port: config.port, host: "0.0.0.0" });
