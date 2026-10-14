// The person using this copy of Scribe: a name, email and affiliation kept on this computer.
// It signs new papers and git commits; nothing is sent anywhere.
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./core";

export interface Profile { name: string; email: string; affiliation: string; }

const KEY = "scribe.profile";
export const profile: Profile = { name: "", email: "", affiliation: "" };

const fields: (keyof Profile)[] = ["name", "email", "affiliation"];

function render() {
  for (const field of fields) $<HTMLInputElement>(`profile-${field}`).value = profile[field];
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch {}
}

for (const field of fields) {
  $(`profile-${field}`).addEventListener("input", (e) => {
    profile[field] = (e.target as HTMLInputElement).value;
    save();
  });
}

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
