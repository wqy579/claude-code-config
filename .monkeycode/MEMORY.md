# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: Discovered by Agent while configuring CLI Proxy API v8 for model fallback routing
- Category: Operations & Deployment
- Instructions:
  - CLI Proxy API v8 binary: `/usr/local/bin/cli-proxy-api`, config: `/root/.config/cli-proxy-api/config.yaml`, runs on port 8317
  - Config auto-reloads on file change (file watcher); no restart needed for config updates
  - `openai-compatibility` MUST be nested under root `api-keys:` section, not at root level (causes api-keys=0)
  - Management API secret: `e6f85692c9d52951384f824e4f02c91b6307bf359843d1accc96c3528b366204`
  - Access API key: `local-claude-code-key`
  - Cross-provider fallback is achieved by using the SAME alias across providers — when primary provider exhausts all keys, request automatically falls back to the next provider with that alias
  - Sensenova upstream: `https://token.sensenova.cn/v1` with 5 keys (3 models: glm-5.2, deepseek-v4-pro, sensenova-6.8-flash-lite)
  - Agnes upstream: `https://apihub.agnes-ai.cn/v1` with 1 key (4 models + fallback aliases for the 3 sensenova models)
  - glm-5.2 and deepseek-v4-pro have exhausted sensenova quota; sensenova-6.8-flash-lite still has quota
  - All sensenova keys return "token plan entitlement exhausted" (code 8) when quota is gone
  - OPENAI_API_KEY env var is UUID format (`29f7401b-...`), not valid for api.openai.com
  - gpt-5.4/gpt-5.3 unavailable — no valid OpenAI key
  - Error logs: `/root/.cli-proxy-api/logs/error-v1-chat-completions-*.log`
  - Proxy startup log: `/tmp/proxy_start.log`
  - Sensenova keys stored in: `/workspace/chat-web/proxy.js` TOKEN_POOL array
  - Test config examples: `/tmp/config.example.yaml`, `/tmp/proxy_config_v2.yaml`, `/tmp/test_config.yaml`
