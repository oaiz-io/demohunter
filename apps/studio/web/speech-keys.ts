// "Speech keys": one place to add the text-to-speech API keys every demo in
// Studio uses. The service keeps them (macOS Keychain or a private file) and
// only ever sends back whether a key is saved and its last four characters.
import type { SpeechKeysStatus, SpeechKeyState } from "../speech-keys.js";

const ENDPOINT = "/api/speech-keys";

async function request(body?: unknown, refresh = false): Promise<SpeechKeysStatus> {
  const response = await fetch(
    refresh ? `${ENDPOINT}?refresh=1` : ENDPOINT,
    body === undefined
      ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const result = (await response.json().catch(() => ({}))) as SpeechKeysStatus & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Speech keys are not available (${response.status}).`);
  return result;
}
/** The service's last known status (it does not read the Keychain again).
 * Undefined when this Studio has no speech key service (headless renders). */
export const speechKeysStatus = (): Promise<SpeechKeysStatus | undefined> => request().catch(() => undefined);

/** Which key narration uses for a provider, in a few words. */
export function describeSpeechKey(state: SpeechKeyState): string {
  if (state.active === "studio") return `saved key ${state.hint ?? ""}`.trim();
  if (state.active === "environment")
    return state.agents ? `key from ${state.envVar}` : `key from ${state.envVar} (not for agents)`;
  return state.error ? "cannot read the saved key" : "no API key";
}
const explain = (state: SpeechKeyState) =>
  state.active === "environment" && !state.agents
    ? `Studio keeps ${state.envVar} from the coding agents it starts, so their narration needs a saved key.`
    : "";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let dialog: HTMLDialogElement | undefined;
let onChange: ((status: SpeechKeysStatus) => void) | undefined;

/** Open the Speech keys dialog. `changed` runs after each save or removal,
 * and with the fresh status when the dialog opens. */
export async function openSpeechKeys(changed?: (status: SpeechKeysStatus) => void): Promise<void> {
  onChange = changed;
  dialog ??= build();
  const list = dialog.querySelector<HTMLElement>(".speech-keys-list")!;
  list.replaceChildren(el("p", "speech-key-state", "Loading…"));
  dialog.querySelector(".speech-keys-announce")!.textContent = "";
  if (!dialog.open) dialog.showModal();
  try {
    // The person asked to see the keys: read the store again (a locked
    // Keychain asks to unlock now, not on every page load).
    const status = await request(undefined, true);
    render(status);
    onChange?.(status);
  } catch (error) {
    list.replaceChildren(el("p", "speech-key-error", error instanceof Error ? error.message : String(error)));
    dialog.querySelector(".speech-keys-foot")!.textContent = "";
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
  const announce = el("p", "speech-keys-announce");
  announce.setAttribute("role", "status");
  d.append(head, lead, el("div", "speech-keys-list"), announce, el("p", "speech-keys-foot"));
  // Drop typed keys from the page when the dialog closes.
  d.addEventListener("close", () => d.querySelectorAll("input").forEach((i) => (i.value = "")));
  document.body.append(d);
  return d;
}

function render(status: SpeechKeysStatus): void {
  const d = dialog!;
  d.querySelector(".speech-keys-foot")!.textContent =
    `Kept in ${status.store === "keychain" ? "your macOS Keychain" : status.location}. Studio never shows a saved key again.`;
  d.querySelector<HTMLElement>(".speech-keys-list")!.replaceChildren(...status.providers.map(row));
}
/** After a change, only that provider's row is rebuilt: keys typed in other
 * rows stay. */
function renderRow(status: SpeechKeysStatus, provider: string): HTMLElement | undefined {
  const state = status.providers.find((p) => p.id === provider);
  const current = dialog!.querySelector<HTMLElement>(`.speech-key[data-provider="${provider}"]`);
  if (!state || !current) {
    render(status);
    return undefined;
  }
  const next = row(state);
  current.replaceWith(next);
  return next;
}

function row(state: SpeechKeyState): HTMLElement {
  // Not a <form> with a password field: browsers would offer to save the key
  // in their password manager (and sync it).
  const item = el("div", "speech-key");
  item.dataset.provider = state.id;
  const name = el("div", "speech-key-name");
  const now = el("span", `speech-key-state ${state.active}`, describeSpeechKey(state));
  now.title = explain(state) || describeSpeechKey(state);
  const status = el("span", "speech-key-status");
  status.append(now);
  // Remove sits with the status, so every row's field has the same width.
  if (state.saved) {
    const remove = el("button", "speech-key-remove", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove the saved ${state.label} key`);
    remove.onclick = () => void change(item, state.label, { provider: state.id, remove: true });
    status.append(remove);
  }
  name.append(el("strong", undefined, state.label), status);
  const input = el("input", "speech-key-input");
  input.type = "text";
  input.name = `${state.id}-speech-key`;
  input.placeholder = state.saved ? "Paste a new key to replace it" : `Paste your ${state.label} API key`;
  input.setAttribute("aria-label", `${state.label} API key`);
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  // Password managers: not a login field.
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-form-type", "other");
  const save = el("button", "speech-key-save", "Save");
  save.type = "button";
  const message = el("p", "speech-key-error");
  message.setAttribute("role", "alert");
  // A store that cannot be read says why under the field, in full.
  message.textContent = state.error ?? explain(state);
  if (!state.error && explain(state)) message.className = "speech-key-note";
  const submit = () => {
    if (!input.value.trim()) return input.focus();
    void change(item, state.label, { provider: state.id, key: input.value });
  };
  save.onclick = submit;
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  const actions = el("div", "speech-key-actions");
  actions.append(input, save);
  item.append(name, actions, message);
  return item;
}

async function change(row: HTMLElement, label: string, body: { provider: string; key?: string; remove?: true }): Promise<void> {
  const buttons = row.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    const status = await request(body);
    const next = renderRow(status, body.provider);
    next?.querySelector("input")?.focus();
    dialog!.querySelector(".speech-keys-announce")!.textContent = body.remove ? `${label} key removed.` : `${label} key saved.`;
    onChange?.(status);
  } catch (error) {
    buttons.forEach((b) => (b.disabled = false));
    const message = row.querySelector(".speech-key-error, .speech-key-note")!;
    message.className = "speech-key-error";
    message.textContent = error instanceof Error ? error.message : String(error);
  }
}
