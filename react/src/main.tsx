import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatWidget } from "./ChatWidget";
import "./index.css";

const PERSONA_ID = "7e420e4b-6c47-4e8a-913d-23388827e979";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatWidget defaultPersonaId={PERSONA_ID} />
  </StrictMode>
);
