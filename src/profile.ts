// The person using this copy of Scribe: a name, email and affiliation kept on this computer.
// It signs new papers and git commits; nothing is sent anywhere.
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./core";

export interface Profile { name: string; email: string; affiliation: string; }

const KEY = "scribe.profile";
export const profile: Profile = { name: "", email: "", affiliation: "" };

const button = $("profile-btn");
const popover = $("profile-popover");
const fields: (keyof Profile)[] = ["name", "email", "affiliation"];
const listeners: (() => void)[] = [];

/** Run `fn` whenever the profile changes (the greeting uses the name, for instance). */
export const onProfileChange = (fn: () => void) => { listeners.push(fn); };

/** "Georgios Kiritsis" -> "GK"; nothing set -> a neutral mark. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const PERSON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.75" r="2.5"/><path d="M3.25 13.25a4.75 4.75 0 019.5 0"/></svg>';

function render() {
  const mark = initials(profile.name);
  if (mark) button.textContent = mark;
  else button.innerHTML = PERSON;
  button.title = profile.name ? `${profile.name} (profile)` : "Set up your profile";
  for (const field of fields) $<HTMLInputElement>(`profile-${field}`).value = profile[field];
  for (const fn of listeners) fn();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch {}
}

function toggle(show = popover.hidden) {
  popover.hidden = !show;
  button.setAttribute("aria-expanded", String(show));
  if (show) $<HTMLInputElement>("profile-name").focus();
}

for (const field of fields) {
  $(`profile-${field}`).addEventListener("input", (e) => {
    profile[field] = (e.target as HTMLInputElement).value;
    save();
    render();
  });
}
button.onclick = () => toggle();
document.addEventListener("pointerdown", (e) => {
  const target = e.target as Node;
  if (!popover.hidden && !popover.contains(target) && !button.contains(target)) toggle(false);
});
popover.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Enter") {
    e.stopPropagation();
    toggle(false);
  }
});

/** Load the saved profile; the first time, start from the name and email git already knows. */
export async function loadProfile() {
  let saved: Partial<Profile> | null = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch {}
  if (saved) {
    for (const field of fields) if (typeof saved[field] === "string") profile[field] = saved[field]!;
  } else {
    const git = await invoke<{ name: string; email: string }>("git_identity").catch(() => null);
    if (git) {
      profile.name = git.name;
      profile.email = git.email;
      save();
    }
  }
  render();
}
