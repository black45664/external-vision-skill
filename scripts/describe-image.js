#!/usr/bin/env node
// describe-image.js - describe images with an external vision model (default: Zhipu GLM-4V-Flash)
// Usage:
//   node describe-image.js <image paths or URLs...> [--prompt "question"]
//   node describe-image.js --latest [--prompt "question"]   # extract the last image the user sent from recent Codex sessions
//   node describe-image.js --help
// Exit codes: 0 = success, 1 = failure
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_DIR = path.dirname(path.dirname(__filename));
const CONFIG_FILE = process.env.VISION_CONFIG || path.join(SKILL_DIR, 'config.json');
const DEFAULT_MODEL = 'glm-4v-flash';
const DEFAULT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_TIMEOUT_MS = 60000;
const PLACEHOLDER_KEY = 'YOUR_GLM_API_KEY_HERE';
const ALLOWED_MODELS_DEFAULT = ['deepseek-v4-flash', 'deepseek-v4-pro'];
const WARN_IMAGE_BYTES = 8 * 1024 * 1024; // warn above ~8 MB (base64 payload grows ~33%)
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // hard cap so we never send absurd payloads
const MAX_SESSION_FILES = 20;             // how many newest session files --latest scans
const URL_RE = /^https?:\/\//i;

const USAGE = `describe-image.js - describe images with an external vision model

Usage:
  node describe-image.js <image paths or URLs...> [--prompt "question"]
  node describe-image.js --url <image URL> [--prompt "question"]
  node describe-image.js --latest [--prompt "question"] [--session <session-jsonl>]
  node describe-image.js --help

Sources:
  Local files          Any path (multiple allowed). Remote http(s) URLs are
                       auto-detected and passed straight to the vision API.
  --url <URL>          Explicitly mark the next argument as a remote image URL.

Options:
  --latest             Find the most recent image the user sent in Codex sessions
                       (recovers pasted images even though the text model never saw them)
  --session <file>     Restrict --latest to one session file
  --prompt "text"      Ask a specific question about the image(s)
  --help               Show this help

Exit codes: 0 = success, 1 = failure
`;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function getAllowedModels() {
  const cfg = readConfig();
  if (process.env.VISION_ALLOWED_MODELS) return process.env.VISION_ALLOWED_MODELS.split(',').map(s => s.trim());
  if (Array.isArray(cfg.allowed_models)) return cfg.allowed_models;
  return ALLOWED_MODELS_DEFAULT;
}

// Parse `model = "x"` or `model = 'x'` from TOML (allows leading whitespace / BOM).
function readModelFromText(text) {
  const t = String(text).replace(/^\uFEFF/, '');
  const m = t.match(/^\s*model\s*=\s*("([^"]+)"|'([^']+)')/m);
  return m ? (m[2] || m[3]) : null;
}

function getCurrentModel() {
  const p = process.env.VISION_CONFIG_TOML || path.join(os.homedir(), '.codex', 'config.toml');
  try {
    return readModelFromText(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function getApiKey() {
  const cfg = readConfig();
  let key = process.env.VISION_API_KEY || cfg.api_key || null;
  let source = process.env.VISION_API_KEY ? 'env VISION_API_KEY' : (cfg.api_key ? 'config.json' : 'none');
  if (key === PLACEHOLDER_KEY || (typeof key === 'string' && key.trim() === '')) {
    key = null;
    source = source + ' (placeholder - edit config.json)';
  }
  return { key, source };
}

function getEndpoint() {
  const cfg = readConfig();
  if (process.env.VISION_API_ENDPOINT) return process.env.VISION_API_ENDPOINT;
  if (cfg.endpoint) return cfg.endpoint;
  return DEFAULT_ENDPOINT;
}

function getModel() {
  const cfg = readConfig();
  if (process.env.VISION_API_MODEL) return process.env.VISION_API_MODEL;
  if (cfg.model) return cfg.model;
  return DEFAULT_MODEL;
}

function getTimeoutMs() {
  const cfg = readConfig();
  const n = Number(process.env.VISION_API_TIMEOUT_MS || cfg.timeout_ms);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
  return { mime, data: 'data:' + mime + ';base64,' + buf.toString('base64') };
}

// Best-effort recovery of a local image path mentioned on the same session line,
// so --latest can use the original file instead of reconstructing from base64:
//   file:///C:/path/img.png | "path":"C:\path\img.png" | "C:\path\img.png" | "/path/img.png"
function findLocalImagePath(line) {
  const m = line.match(/file:\/\/\/([^")\s]+\.(?:png|jpg|jpeg|webp|bmp))/i) ||
            line.match(/"path"\s*:\s*"([^"]+\.(?:png|jpg|jpeg|webp|bmp))"/i) ||
            line.match(/"([A-Za-z]:\\[^"]*\.(?:png|jpg|jpeg|webp|bmp))"/i) ||
            line.match(/"(\/(?:[^"\/]+\/)*[^"\/]+\.(?:png|jpg|jpeg|webp|bmp))"/i);
  if (!m) return null;
  let p = m[1];
  if (m[0].toLowerCase().startsWith('file:///')) {
    try { p = decodeURIComponent(p); } catch {}
  }
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

// Find the most recent image the user sent by scanning the newest Codex session
// files (JSONL) for an input_image content part. Codex stores pasted images as
// base64 data URLs; if the original temp file is gone we reconstruct it.
function findLatestUserImage(sessionFile) {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  if (!sessionFile && !fs.existsSync(sessionsRoot)) return null;

  const files = [];
  if (sessionFile) {
    files.push(sessionFile);
  } else {
    (function collect(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) collect(p);
        else if (e.name.endsWith('.jsonl')) {
          try { files.push([p, fs.statSync(p).mtimeMs]); } catch { /* file vanished */ }
        }
      }
    })(sessionsRoot);
    files.sort((a, b) => b[1] - a[1]); // newest first
  }

  const ordered = sessionFile ? files : files.slice(0, MAX_SESSION_FILES).map(f => f[0]);
  for (const f of ordered) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!raw.includes('data:image')) continue; // quick reject before splitting lines
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/"image_url":"(data:image\/[^;]+;base64,[^"]+)"/);
      if (!m) continue;
      const local = findLocalImagePath(lines[i]);
      if (local) return { file: local, from: f };
      const ext = (m[1].match(/^data:image\/(\w+)/) || [])[1] || 'png';
      const tmp = path.join(os.tmpdir(), 'codex-vision-latest-' + process.pid + '-' + Date.now() + '.' + ext);
      try {
        fs.writeFileSync(tmp, Buffer.from(m[1].split(',')[1], 'base64'));
        return { file: tmp, from: f + ' (reconstructed from base64)' };
      } catch (e) {
        console.error('[describe-image] warning: could not write ' + tmp + ': ' + e.message);
      }
    }
  }
  return null;
}

async function describe(source, prompt) {
  const { key, source: keySource } = getApiKey();
  if (!key) {
    console.error('ERROR: no API key found. Set VISION_API_KEY or put {"api_key":"..."} in ' + CONFIG_FILE);
    console.error('       (if you copied config.example.json, replace "' + PLACEHOLDER_KEY + '" with your real key)');
    process.exit(1);
  }

  let imagePart;
  if (source.kind === 'url') {
    imagePart = { type: 'image_url', image_url: { url: source.value } };
  } else {
    let size = 0;
    try { size = fs.statSync(source.value).size; } catch {}
    if (size > MAX_IMAGE_BYTES) {
      console.error('ERROR: image too large (' + (size / 1048576).toFixed(1) + ' MB). Limit is ' + (MAX_IMAGE_BYTES / 1048576) + ' MB.');
      process.exit(1);
    }
    if (size > WARN_IMAGE_BYTES) {
      console.error('[describe-image] warning: image is ' + (size / 1048576).toFixed(1) + ' MB; very large images may be rejected by the API.');
    }
    const dataUrl = toDataUrl(source.value);
    imagePart = { type: 'image_url', image_url: { url: dataUrl.data } };
  }

  const content = [
    { type: 'text', text: prompt || 'Describe this image in detail. If it contains text, quote it exactly. Be specific and factual.' },
    imagePart,
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  let resp;
  try {
    resp = await fetch(getEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: getModel(),
        messages: [{ role: 'user', content }],
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    console.error('ERROR: request ' + (timedOut ? 'timed out after ' + getTimeoutMs() + ' ms' : 'failed: ' + (e.message || e)));
    console.error('       If this looks like a network restriction, allow network access (e.g. [sandbox_workspace_write] network_access = true in ~/.codex/config.toml) and retry.');
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error('ERROR: API ' + resp.status + ': ' + JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  const answer = body.choices?.[0]?.message?.content;
  if (!answer) {
    console.error('ERROR: empty response: ' + JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  return answer;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const currentModel = getCurrentModel();
  const allowedModels = getAllowedModels();
  const modelAllowed = allowedModels.includes('*') || allowedModels.includes(currentModel);
  if (!modelAllowed) {
    console.error('ERROR: external-vision-skill is only enabled when the main model is in allowed_models (current config.toml model: ' + (currentModel || 'unknown') + '; allowed: ' + allowedModels.join(' / ') + '). Set "allowed_models": ["*"] in ' + CONFIG_FILE + ' or VISION_ALLOWED_MODELS=* to allow any main model.');
    process.exit(1);
  }

  const promptIdx = args.indexOf('--prompt');
  let prompt = null;
  if (promptIdx >= 0) {
    prompt = args[promptIdx + 1] || null;
    args.splice(promptIdx, 2);
  }

  const sessionIdx = args.indexOf('--session');
  let sessionFile = null;
  if (sessionIdx >= 0) {
    sessionFile = args[sessionIdx + 1];
    args.splice(sessionIdx, 2);
  }

  let sources = [];
  let note = null;
  if (args.includes('--latest')) {
    const img = findLatestUserImage(sessionFile);
    if (!img) {
      console.error('ERROR: no image found in recent Codex sessions');
      process.exit(1);
    }
    sources = [{ kind: 'file', value: img.file }];
    note = 'source: ' + img.from;
  } else {
    // consume explicit --url <value> first
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--url') {
        const next = args[i + 1];
        if (!next || next.startsWith('--')) {
          console.error('ERROR: --url requires a value (e.g. --url https://example.com/img.png)');
          process.exit(1);
        }
        sources.push({ kind: 'url', value: next });
        i++;
      } else if (URL_RE.test(args[i])) {
        sources.push({ kind: 'url', value: args[i] });
      } else {
        sources.push({ kind: 'file', value: args[i] });
      }
    }
  }

  if (sources.length === 0) {
    console.error('usage: node describe-image.js <image paths or URLs...> | --latest [--prompt "question"]  (use --help for details)');
    process.exit(1);
  }

  const missing = sources.filter(s => s.kind === 'file' && !fs.existsSync(s.value));
  if (missing.length) {
    console.error('ERROR: file not found: ' + missing.map(s => s.value).join(', '));
    process.exit(1);
  }

  const { source: keySource } = getApiKey();
  console.error('[describe-image] key: ' + keySource + ', model: ' + getModel());
  if (note) console.error('[describe-image] ' + note);

  let all = [];
  for (const s of sources) {
    const out = await describe(s, prompt);
    all.push('### ' + s.value + '\n' + out.trim());
  }
  console.log(all.join('\n\n'));
})().catch(e => {
  console.error('ERROR: ' + (e.message || e));
  process.exit(1);
});