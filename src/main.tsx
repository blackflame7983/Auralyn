import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
import { bootstrapMigration } from "./api/migration";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
bootstrapMigration().then(() => root.render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)).catch(error => root.render(<div className="p-6">
  <h1>移行した設定を確認できませんでした</h1>
  <p>設定を読み込めないため画面の起動を止めました。設定を保持したまま再試行してください。</p>
  <p role="alert">{String(error)}</p>
  <button onClick={() => location.reload()}>再試行</button>
</div>));
