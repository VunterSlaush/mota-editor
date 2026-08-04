import { IconContext } from "@phosphor-icons/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import { createAppContext } from "./wiring/context";
import "./ui/styles.css";

const context = createAppContext();
void context.restoreWorkspace.execute();

/** Every icon's default size and weight — call sites override only where they differ. */
const ICON_DEFAULTS = { size: 16, weight: "regular" } as const;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IconContext.Provider value={ICON_DEFAULTS}>
      <App context={context} />
    </IconContext.Provider>
  </React.StrictMode>,
);
