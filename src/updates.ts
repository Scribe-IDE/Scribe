// Updates: a quiet check a little after start, and Help > Check for Updates. A new version is
// offered in a small card; installing downloads it, checks its signature, and restarts.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { setStatus } from "./core";

let card: HTMLElement | null = null;

function offer(update: Update) {
  card?.remove();
  card = document.createElement("div");
  card.className = "update-card";
  card.setAttribute("role", "status");
  const text = document.createElement("p");
  text.textContent = `Scribe ${update.version} is ready to install.`;
  const notes = update.body?.trim();
  if (notes) text.title = notes;
  const later = document.createElement("button");
  later.className = "btn";
  later.textContent = "Later";
  later.onclick = () => card?.remove();
  const install = document.createElement("button");
  install.className = "btn btn-primary";
  install.textContent = "Install and Restart";
  install.onclick = async () => {
    install.disabled = later.disabled = true;
    let total = 0;
    let got = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          text.textContent = total ? `Downloading… ${Math.round((got / total) * 100)}%` : "Downloading…";
        } else if (e.event === "Finished") text.textContent = "Installing…";
      });
      await relaunch();
    } catch (e) {
      text.textContent = `The update didn't install: ${e}`;
      install.disabled = later.disabled = false;
    }
  };
  const actions = document.createElement("div");
  actions.className = "update-actions";
  actions.append(later, install);
  card.append(text, actions);
  document.body.append(card);
}

/** Look for a newer version. `quiet` says nothing when there is none or the check fails. */
export async function checkForUpdates(quiet = false) {
  try {
    const update = await check();
    if (update) offer(update);
    else if (!quiet) setStatus("Scribe is up to date", "ok");
  } catch (e) {
    if (!quiet) setStatus(`Couldn't check for updates: ${e}`, "err");
  }
}

/** Once, a while after start, so it never slows opening a project. Not in development builds. */
export function checkForUpdatesLater() {
  if (import.meta.env.DEV) return;
  window.setTimeout(() => checkForUpdates(true), 8000);
}
