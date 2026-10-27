import { initializeTemporarySession } from './lib/temporarySession';
import { FixedClientError, renderClientError } from './lib/clientError';
import { LocaleProvider, useMessages } from './i18n/LocaleProvider';
import { initializeLocale } from './i18n/locale';
import { initializeLocaleBridge } from './i18n/nativeLocale';
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
import { bootstrapMigration } from "./api/migration";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
function BootstrapFailure({ error }: { error: unknown }) {
  const t = useMessages();
  const isolation = error instanceof FixedClientError && error.code === 'session.isolation';
  return <div className="p-6 space-y-3"><h1>{t(isolation ? 'temporary.bootstrapTitle' : 'bootstrap.title')}</h1><p>{t(isolation ? 'temporary.bootstrapDescription' : 'bootstrap.description')}</p><p role="alert">{renderClientError(t, error)}</p><button onClick={() => location.reload()}>{t('common.retry')}</button></div>;
}
function render(content: React.ReactNode, withTheme = true) {
  initializeLocale();
  if (withTheme) initializeLocaleBridge();
  root.render(<React.StrictMode><LocaleProvider>{withTheme ? <ThemeProvider>{content}</ThemeProvider> : content}</LocaleProvider></React.StrictMode>);
}
initializeTemporarySession().then(() => bootstrapMigration()).then(() => render(<App />)).catch(error => render(<BootstrapFailure error={error} />, false));
