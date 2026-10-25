# cyberbrick-mcp

MCP server that drives the Bambu Lab CyberBrick desktop app over CDP.

- Start here: `README.md` (English, tool list) / `README.zh-CN.md` (中文), `docs/MCP接口文档.md` (tool contracts), `docs/设计与踩坑笔记.md` (architecture, app internals, pitfalls, upgrade checklist).
- Reverse-engineering artifacts live in `~/codespace/rea/targets/` (CyberBrick.app copy + extracted asar), not in this repo.
- REA MCP is enabled for this project via `.mcp.json`.
- Never read, log, or export the app's auth tokens, private keys, or AES keys. Device-binding, PIN, private-key and firmware-upgrade commands need explicit user confirmation.
