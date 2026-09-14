import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { config } from "./config.js";
import { chatModel } from "./model.js";

const auth = await createAuth();
const app = buildApp({ auth, chatModel });
await app.listen({ port: config.port, host: "0.0.0.0" });
