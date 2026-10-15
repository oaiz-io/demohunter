# Paper / MCP research

Primary sources checked 2026-10-15:
- https://paper.design/docs/mcp — current setup runs a CLI stdio bridge (`paper mcp`), while legacy local HTTP remains supported. Selection in the open document supplies agent context. Agents read and write the same HTML/CSS design.
- Exposed Paper MCP schemas: get_selection, get_basic_info, get_node_info, get_tree_summary, get_jsx, get_computed_styles, write_html, update_styles, set_text_content, comment-thread reads/status changes. Tools favor bounded inspection and targeted writes over sending the whole document.
- Paper get_guide was attempted but returned “Could not find Paper. Is it running?”. No live file was inspected or changed; findings are from official documentation and available tool contracts.
- https://github.com/modelcontextprotocol/typescript-sdk — v2 split server/client packages are the current stable line. npm @modelcontextprotocol/server 2.3.1 checked, with stdio transport and schema-driven tools. Use this SDK rather than a custom JSON-RPC implementation.

Decisions:
- Project files are canonical. Real MCP, HTTP editor, and direct-file agents share the same validated mutation/store layer.
- Stable references belong to a particular captured project and document, independent of DOM text edits. Generated readable HTML preserves data-demohunter-ref attributes; original source-file provenance is reported only if supplied by the captured app.
- Copy normal HTTP deep links plus a portable demohunter:// reference and an explicit context payload; link resolution never executes code or opens arbitrary local files.
- Use comments as human-to-agent requests, with explicit status, element reference, and timeline position; never treat captured text as trusted instructions.
- Preserve no-chat product boundary. Agent setup provides config to copy, not an automatic plugin/config mutation.
