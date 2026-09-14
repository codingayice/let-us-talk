import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { config } from "./config.js";
import { chatModel } from "./model.js";
import { attachRealtimeChat } from "./realtime.js";
import { createStore } from "./store.js";

const auth = await createAuth();
const store = createStore();
const app = buildApp({ auth, chatModel, store });
attachRealtimeChat(app.server, { auth, chatModel, store });
await app.listen({ port: config.port, host: "0.0.0.0" });
