import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import optical from "./optical";
import App from "./App";
import "./styles.css";

await optical.init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
