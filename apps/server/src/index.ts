import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { config } from "./config.js";
import { chatModel } from "./model.js";
import { attachRealtimeChat } from "./realtime.js";
import { createStore } from "./store.js";
import { ChatService } from "./chat-service.js";

const auth = await createAuth();
const store = createStore();
const chatService = new ChatService(store, chatModel);
const app = buildApp({ auth, chatModel, store, chatService });
attachRealtimeChat(app.server, { auth, chatModel, store, chatService });
await app.listen({ port: config.port, host: "0.0.0.0" });
