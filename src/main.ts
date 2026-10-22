import "./styles.css";
import { t } from "./i18n";

// Milestone M1: a placeholder screen that proves build, text system and deploy all work.
function render(root: HTMLElement): void {
  const box = document.createElement("main");
  box.className = "splash";

  const icon = document.createElement("img");
  icon.src = `${import.meta.env.BASE_URL}icons/icon-192.png`;
  icon.alt = "";
  icon.width = 128;
  icon.height = 128;

  const title = document.createElement("h1");
  title.textContent = t("appName");

  const tagline = document.createElement("p");
  tagline.textContent = t("appTagline");

  const notice = document.createElement("p");
  notice.className = "muted";
  notice.textContent = t("buildingNotice");

  const version = document.createElement("p");
  version.className = "version";
  version.dataset.testid = "version";
  version.textContent = t("versionLabel", { version: __APP_VERSION__ });

  const lab = document.createElement("a");
  lab.className = "button";
  lab.href = `${import.meta.env.BASE_URL}lab.html`;
  lab.textContent = t("openLab");

  box.append(icon, title, tagline, notice, lab, version);
  root.replaceChildren(box);
  document.title = t("appName");
}

const root = document.getElementById("app");
if (root) render(root);
