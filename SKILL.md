---
name: external-vision-skill
description: Read and understand images for the user using an external vision model when the main Codex model cannot process images. The main-model allowlist is fully configurable via config.json (allowed_models) or VISION_ALLOWED_MODELS; set it to ["*"] to allow any main model. Use this skill whenever the user sends or pastes an image, attaches a screenshot, references an image file ("看下这张图", "read this image", "screenshot shows..."), or when a message contains the placeholder "image content omitted because you do not support image input". Also use it when you need to inspect image content (OCR, screenshots, diagrams, photos) but your current model cannot process image input.
metadata:
  short-description: Describe images using a customizable external vision model with a configurable main-model allowlist
---

# Describe Images

Your current model cannot process images directly (input modalities: text only). When image content is needed, run the bundled script to have an external vision model (current config: Qwen/Qwen3-VL-32B-Instruct via siliconflow) describe it, then use the text description as if you had seen the image.

## When to use

- The user sends/pastes an image (you will see "image content omitted because you do not support image input" instead of the image)
- The user asks about a local image file (screenshots, photos, diagrams, PDF pages exported as images)
- The user shares an image URL
- You need OCR or visual inspection of any image file

## How to run

> **Node runtime note**: on this machine `node` is NOT on PATH. Always invoke the script with the Codex bundled Node.js:
> `C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` <script path>


Script: `scripts/describe-image.js` (Node.js, no dependencies; run with the `node` in PATH).

1. **User-sent image (no file path known):**
   ```
   "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "<CODEX_HOME>\skills\external-vision-skill\scripts\describe-image.js" --latest
   ```
   This scans the newest Codex session file, finds the most recent image the user sent (local temp path if still present, otherwise reconstructed from base64), and describes it.

2. **Local image file:**
   ```
   "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "<CODEX_HOME>\skills\external-vision-skill\scripts\describe-image.js" "C:\path\to\image.png"
   ```
   Multiple paths are allowed. Paths with spaces must be quoted.

3. **Remote image URL:**
   ```
   "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "<CODEX_HOME>\skills\external-vision-skill\scripts\describe-image.js" --url "https://example.com/img.png"
   ```
   http(s) URLs are also auto-detected without `--url`.

4. **With a specific question:**
   ```
   "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "<CODEX_HOME>\skills\external-vision-skill\scripts\describe-image.js" --prompt "What is the error message in this screenshot?" "C:\path\to\image.png"
   ```

`<CODEX_HOME>` is the Codex home directory, typically `C:\Users\<user>\.codex`.

## API configuration

- Key source (first match wins): env var `VISION_API_KEY` → `config.json` (`{"api_key": "..."}`) in the skill directory. No other fallback; a missing key (or the placeholder `YOUR_GLM_API_KEY_HERE`) is a hard error telling the user to configure config.json.
- Endpoint/model/timeout overrides: env vars `VISION_API_ENDPOINT` / `VISION_API_MODEL` / `VISION_API_TIMEOUT_MS`, or same keys in `config.json`. The current config uses `https://api.siliconflow.cn/v1/chat/completions` and `Qwen/Qwen3-VL-32B-Instruct`; the built-in defaults are `https://open.bigmodel.cn/api/paas/v4/chat/completions`, `glm-4v-flash`, 60 s.
- Main-model allowlist: env var `VISION_ALLOWED_MODELS` (comma-separated) or `allowed_models` in `config.json`. Set it to `["*"]` (or `VISION_ALLOWED_MODELS=*`) to allow any main model; otherwise list the exact model names this skill should run for. The default is `["deepseek-v4-flash", "deepseek-v4-pro"]`.

## Main-model guard (configurable)

The script only runs when the main model in `~/.codex/config.toml` is in the allowlist (`allowed_models` in `config.json`, or env var `VISION_ALLOWED_MODELS`). It reads the top-level `model = ...` line from `~/.codex/config.toml` at startup and exits with an error if the current model is not allowed.

The allowlist is fully customizable:
- To run only for specific models, put their exact names in `allowed_models` (e.g. `["gpt-4o-codex"]`).
- To allow any main model, set `allowed_models` to `["*"]` (or set `VISION_ALLOWED_MODELS=*`).

This lets you decide which main models are allowed to use the vision relay, regardless of provider.

## Notes

- The output is a factual text description; quote OCR text exactly, do not paraphrase.
- **Network access required**: the script calls an external vision API (currently siliconflow). If the sandbox blocks it (error like "network restriction" or fetch/EAI_AGAIN), the command needs network permission — request it via `network_access` / `require_escalated` approval before retrying. If `[sandbox_workspace_write] network_access = true` is present in config.toml this will not be needed.
- If the script fails (network error, missing key), tell the user what happened and offer fallback: switch provider in cc-switch to one that supports images (e.g. 222) for that step.
- The placeholder text in the conversation ("image content omitted...") means the image was never sent to your model; always recover it via `--latest` before answering anything image-related.
- Images larger than 25 MB are refused (8 MB warning) to protect the API call.