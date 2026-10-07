// Theme control shared by the Parrot page and materials lab.
// Changes display only, using the dashboard data-theme and theme query conventions.
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const requested = new URLSearchParams(window.location.search).get("theme");
    if (requested === "light" || requested === "dark") document.documentElement.dataset.theme = requested;
    const update = () => setDark(document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return <button type="button" className="parrot-button parrot-button--small" aria-label={`Switch to ${dark ? "light" : "dark"} theme`} onClick={() => {
    document.documentElement.dataset.theme = dark ? "light" : "dark"; setDark(!dark);
  }}>{dark ? "Light" : "Dark"}</button>;
}
