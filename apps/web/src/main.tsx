import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
