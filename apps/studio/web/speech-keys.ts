// "Speech keys": one place to add the text-to-speech API keys every demo in
// Studio uses. The service keeps them (macOS Keychain or a private file) and
// only ever sends back whether a key is saved and its last four characters.
import type { SpeechKeysStatus, SpeechKeyState } from "../speech-keys.js";

const ENDPOINT = "/api/speech-keys";

async function request(body?: unknown): Promise<SpeechKeysStatus> {
  const response = await fetch(
    ENDPOINT,
    body === undefined
      ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const result = (await response.json().catch(() => ({}))) as SpeechKeysStatus & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Speech keys are not available (${response.status}).`);
  return result;
}
/** Undefined when this Studio has no speech key service (headless renders). */
export const speechKeysStatus = (): Promise<SpeechKeysStatus | undefined> => request().catch(() => undefined);

/** Which key narration uses for a provider, in a few words. */
export function describeSpeechKey(state: SpeechKeyState): string {
  if (state.active === "studio") return `saved key ${state.hint ?? ""}`.trim();
  if (state.active === "environment") return `key from ${state.envVar}`;
  return state.error ?? "no API key";
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let dialog: HTMLDialogElement | undefined;
let onChange: ((status: SpeechKeysStatus) => void) | undefined;

/** Open the Speech keys dialog. `changed` runs after each save or removal. */
export async function openSpeechKeys(changed?: (status: SpeechKeysStatus) => void): Promise<void> {
  onChange = changed;
  dialog ??= build();
  const list = dialog.querySelector<HTMLElement>(".speech-keys-list")!;
  const foot = dialog.querySelector<HTMLElement>(".speech-keys-foot")!;
  list.replaceChildren(el("p", "speech-key-state", "Loading…"));
  if (!dialog.open) dialog.showModal();
  try {
    render(await request());
  } catch (error) {
    list.replaceChildren(el("p", "speech-key-error", error instanceof Error ? error.message : String(error)));
    foot.textContent = "";
  }
}

function build(): HTMLDialogElement {
  const d = el("dialog", "speech-keys-dialog");
  d.setAttribute("aria-labelledby", "speech-keys-title");
  const head = el("div", "speech-keys-head");
  const title = el("h2", undefined, "Speech keys");
  title.id = "speech-keys-title";
  const close = el("button", "speech-keys-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close speech keys");
  // The library page has no icon sprite: draw the editor's close icon here.
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.onclick = () => d.close();
  head.append(title, close);
  const lead = el(
    "p",
    "speech-keys-lead",
    "Text-to-speech API keys for every demo in Studio. A saved key is used before the environment variable.",
  );
  d.append(head, lead, el("div", "speech-keys-list"), el("p", "speech-keys-foot"));
  // Drop typed keys from the page when the dialog closes.
  d.addEventListener("close", () => d.querySelectorAll("input").forEach((i) => (i.value = "")));
  document.body.append(d);
  return d;
}

function render(status: SpeechKeysStatus): void {
  const d = dialog!;
  d.querySelector(".speech-keys-foot")!.textContent =
    `Kept in ${status.store === "keychain" ? "your macOS Keychain" : status.location}. Studio never shows a saved key again.`;
  const list = d.querySelector<HTMLElement>(".speech-keys-list")!;
  list.replaceChildren(...status.providers.map(row));
}

function row(state: SpeechKeyState): HTMLElement {
  const item = el("form", "speech-key");
  item.dataset.provider = state.id;
  item.autocomplete = "off";
  const name = el("div", "speech-key-name");
  const now = el("span", `speech-key-state ${state.active}`, describeSpeechKey(state));
  now.title = now.textContent ?? "";
  name.append(el("strong", undefined, state.label), now);
  const input = el("input");
  input.type = "password";
  input.name = `${state.id}-api-key`;
  input.placeholder = state.saved ? "Paste a new key to replace it" : `Paste your ${state.label} API key`;
  input.setAttribute("aria-label", `${state.label} API key`);
  input.autocomplete = "off";
  input.spellcheck = false;
  input.required = true;
  const save = el("button", "speech-key-save", "Save");
  save.type = "submit";
  const message = el("p", "speech-key-error");
  message.setAttribute("role", "alert");
  const actions = el("div", "speech-key-actions");
  actions.append(input, save);
  if (state.saved) {
    const remove = el("button", "speech-key-remove", "Remove");
    remove.type = "button";
    remove.onclick = () => void change(item, { provider: state.id, remove: true });
    actions.append(remove);
  }
  item.onsubmit = (event) => {
    event.preventDefault();
    void change(item, { provider: state.id, key: input.value });
  };
  item.append(name, actions, message);
  return item;
}

async function change(form: HTMLFormElement, body: { provider: string; key?: string; remove?: true }): Promise<void> {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    const status = await request(body);
    render(status);
    onChange?.(status);
  } catch (error) {
    buttons.forEach((b) => (b.disabled = false));
    form.querySelector(".speech-key-error")!.textContent = error instanceof Error ? error.message : String(error);
  }
}
