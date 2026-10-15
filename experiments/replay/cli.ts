// Compatibility entry point for existing local MCP configurations.
import { main } from "../../apps/studio/cli.js";
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
