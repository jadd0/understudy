// Regenerates data/evals/threads.schema.json from the zod schema in lib/evals/threads.ts.
import { writeFileSync } from "node:fs";
import { threadJsonSchema } from "@/lib/evals/threads";

writeFileSync("data/evals/threads.schema.json", `${JSON.stringify(threadJsonSchema(), null, 2)}\n`);
console.log("wrote data/evals/threads.schema.json");
