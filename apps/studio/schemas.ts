import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { formatSchema } from "./contract.js";
import {
  projectSchema,
  editsSchema,
  narrationSchema,
  commentsSchema,
} from "./model.js";
export async function writeSchemas() {
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "schemas",
  );
  await mkdir(root, { recursive: true });
  for (const [name, schema] of Object.entries({
    studio: formatSchema,
    project: projectSchema,
    edits: editsSchema,
    narration: narrationSchema,
    comments: commentsSchema,
  })) {
    await writeFile(
      path.join(root, `${name}.v1.schema.json`),
      JSON.stringify(
        z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }),
        null,
        2,
      ) + "\n",
    );
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await writeSchemas();
