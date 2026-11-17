// Pure element-edit helpers shared by the server and the browser client
// (no zod, so the client bundles stay small).
import type { ElementPatch } from "./element-edit.js";
export type { ElementPatch };
import type { ReplayEdits, Target } from "./model.js";

export type ElementEdit = ReplayEdits["elements"][number];
export function elementKey(target: Target): string {
  return JSON.stringify([
    target.scene ?? null,
    target.ref ?? null,
    target.nodeId ?? null,
    target.documentId ?? null,
    target.selector ?? null,
  ]);
}
export function effectiveElementEdit(
  elements: ElementEdit[],
  target: Target,
): ElementEdit | undefined {
  let result: ElementEdit | undefined;
  for (const edit of elements)
    if (elementKey(edit.target) === elementKey(target))
      result = {
        ...result,
        ...edit,
        style: { ...result?.style, ...edit.style },
        transform: edit.transform ?? result?.transform,
      };
  return result;
}
/** Patch only this target, preserving unrelated elements and properties. */
export function patchElement(
  elements: ElementEdit[],
  target: Target,
  patch: ElementPatch,
  id: string,
): void {
  const matching = elements.filter(
    (edit) => elementKey(edit.target) === elementKey(target),
  );
  if (patch.reset) {
    for (let i = elements.length - 1; i >= 0; i--)
      if (elementKey(elements[i]!.target) === elementKey(target))
        elements.splice(i, 1);
    matching.length = 0;
    if (
      !Object.keys(patch).some(
        (key) =>
          key !== "reset" && patch[key as keyof ElementPatch] !== undefined,
      )
    )
      return;
  }
  let edit = matching.at(-1);
  if (!edit) {
    edit = { id, target };
    elements.push(edit);
    matching.push(edit);
  }
  if (patch.text === null) for (const e of matching) delete e.text;
  else if (patch.text !== undefined) edit.text = patch.text;
  if (patch.hidden !== undefined) edit.hidden = patch.hidden;
  for (const [name, value] of Object.entries(patch.style ?? {})) {
    if (value === null)
      for (const e of matching) {
        if (e.style) delete e.style[name];
      }
    else (edit.style ??= {})[name] = value;
  }
  if (patch.transform === null) for (const e of matching) delete e.transform;
  else if (patch.transform)
    edit.transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      ...effectiveElementEdit(elements, target)?.transform,
      ...patch.transform,
    };
}
