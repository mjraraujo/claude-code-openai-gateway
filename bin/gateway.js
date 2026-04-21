#!/usr/bin/env node

/**
 * Codex Gateway — Interactive OpenAI Login for Claude Code
 * 
 * Uses the exact same endpoints as the official Codex CLI (codex-rs):
 *   - auth.openai.com/api/accounts/deviceauth/usercode
 *   - auth.openai.com/api/accounts/deviceauth/token
 *   - auth.openai.com/codex/device  (verification page)
 *
 * Then proxies Claude Code's Anthropic API calls → OpenAI API.
 *
 * Usage:
 *   node codex-gateway.js          # Login + launch
 *   node codex-gateway.js --login  # Force re-login
 *   node codex-gateway.js --setup  # Configure target model/endpoint
 *   node codex-gateway.js --serve  # Headless: run proxy only (for Docker)
 */

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

// ─── Codex Auth Constants (from codex-rs source) ────────────────────────────

const AUTH_ISSUER = 'https://auth.openai.com';
const DEVICE_USERCODE_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFY_URL = `${AUTH_ISSUER}/codex/device`;
const OAUTH_TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(process.env.HOME || '~', '.codex-gateway');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
// Port chosen at startup (mutable). Seeded from $CODEX_GATEWAY_PORT
// (operator override) and falls back to the historical 18923. When the
// preferred port is occupied by a non-gateway process we may pick a
// different one from PORT_FALLBACK_RANGE; the final value is written
// to PORT_FILE so the Next.js dashboard can find us.
const DEFAULT_PROXY_PORT = 18923;
const PORT_FALLBACK_RANGE_END = 18933; // inclusive — 11 ports total
let PROXY_PORT = (() => {
  const raw = process.env.CODEX_GATEWAY_PORT;
  if (!raw) return DEFAULT_PROXY_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    console.warn(`  ⚠️  Ignoring invalid CODEX_GATEWAY_PORT=${raw}`);
    return DEFAULT_PROXY_PORT;
  }
  return n;
})();
const PORT_FILE = path.join(CONFIG_DIR, 'port');
// Sentinel route used by `probeGatewayHealth()` to recognise an
// already-running claude-codex gateway when EADDRINUSE fires.
const HEALTH_PATH = '/__gateway';
const HEALTH_BODY = 'claude-codex-gateway';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return {
    target_api_url: 'https://api.openai.com/v1/chat/completions',
    default_model: 'gpt-4o',
  };
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data.expires_at && Date.now() < data.expires_at - 60000) {
      return data;
    }
  }
  return null;
}

function saveToken(tokenData) {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

// ─── Port discovery helpers ──────────────────────────────────────────────────

/**
 * Persist the chosen port so the Next.js dashboard (and any other
 * consumer using `web/src/lib/runtime/gateway.ts`) can locate the
 * gateway when it isn't on the default 18923. Best-effort — failures
 * are logged but never fatal, since the port file is just a hint.
 */
function writePortFile(port) {
  try {
    ensureConfigDir();
    fs.writeFileSync(PORT_FILE, String(port) + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn(`  ⚠️  Could not write port file ${PORT_FILE}: ${e.message}`);
  }
}

/**
 * Probe a local port for an existing claude-codex gateway. Returns
 * true only if the sentinel `GET /__gateway` route responds with the
 * expected body within `timeoutMs`. Any other response (including
 * connection-refused or a non-gateway HTTP server) returns false, so
 * we never confuse an unrelated service for our own.
 */
function probeGatewayHealth(port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: HEALTH_PATH,
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(false);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; if (body.length > 256) req.destroy(); });
        res.on('end', () => resolve(body.trim() === HEALTH_BODY));
        res.on('error', () => resolve(false));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Try to bind to `port` on 127.0.0.1 to confirm it is free. Resolves
 * to true if the port is available, false on EADDRINUSE / EACCES,
 * and rejects on truly unexpected errors so we don't silently swallow
 * something interesting (e.g. ENFILE).
 */
function isPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.unref();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(false);
      } else {
        reject(err);
      }
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Linear scan over the fallback range looking for a free port. Skips
 * the seed value so callers know the result is genuinely different.
 */
async function findFreePort(seed, end) {
  for (let p = seed; p <= end; p++) {
    if (p === PROXY_PORT) continue; // skip the one that already failed
    try {
      if (await isPortFree(p)) return p;
    } catch {
      // Treat unexpected errors as "not usable" and keep scanning.
    }
  }
  return null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`);
    else if (process.platform === 'linux') execSync(`xdg-open "${url}"`);
    else if (process.platform === 'win32') execSync(`start "${url}"`);
  } catch (e) { /* silent */ }
}

/**
 * HTTP POST using native https module.
 * Supports both JSON body (contentType=json) and form-encoded.
 */
function curlPost(url, data, contentType = 'json') {
  let body, ctHeader;
  if (contentType === 'json') {
    body = JSON.stringify(data);
    ctHeader = 'application/json';
  } else {
    body = new URLSearchParams(data).toString();
    ctHeader = 'application/x-www-form-urlencoded';
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqModule = parsed.protocol === 'https:' ? https : http;
    const req = reqModule.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': ctHeader,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(result.trim()));
        } catch (e) {
          reject(new Error(`Request failed: invalid JSON response`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Setup Wizard ────────────────────────────────────────────────────────────

async function runSetup() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    ⚙️  Claude Codex — Settings                   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const existing = loadConfig();

  const targetApiUrl = await ask(`Target API URL [${existing.target_api_url}]: `)
    || existing.target_api_url;

  const defaultModel = await ask(`Default model [${existing.default_model}]: `)
    || existing.default_model;

  const config = { target_api_url: targetApiUrl, default_model: defaultModel };
  saveConfig(config);
  console.log(`\n✅ Settings saved to ${CONFIG_FILE}\n`);
}

// ─── Device Code Flow (matching codex-rs implementation) ─────────────────────

async function deviceCodeLogin() {
  console.log('\n  🔐 Starting OpenAI interactive login...\n');

  // Step 1: Request a device code via JSON POST (same as codex-rs)
  const deviceResp = await curlPost(DEVICE_USERCODE_URL, { client_id: CLIENT_ID });

  if (!deviceResp.device_auth_id || !deviceResp.user_code) {
    throw new Error(`Device code request failed: ${JSON.stringify(deviceResp)}`);
  }

  const {
    device_auth_id,
    user_code,
    interval: pollIntervalStr = '5',
    expires_at,
  } = deviceResp;

  // Step 2: Show the user code and open the browser
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log(`  │  Your login code is:  ${user_code.padEnd(24)}│`);
  console.log('  └─────────────────────────────────────────────────┘\n');
  console.log(`  1. Open: ${DEVICE_VERIFY_URL}`);
  console.log('  2. Enter the code above and sign in to your account.\n');
  console.log('  Waiting for browser login to complete...');

  openBrowser(DEVICE_VERIFY_URL);

  // Step 3: Poll for the authorization code
  const pollInterval = (parseInt(pollIntervalStr, 10) || 5) * 1000;
  const deadline = expires_at ? new Date(expires_at).getTime() : Date.now() + 900000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    try {
      const tokenResp = await curlPost(DEVICE_TOKEN_URL, {
        device_auth_id,
        user_code,
      });

      if (tokenResp.authorization_code) {
        // Got the auth code! Now exchange it for tokens via PKCE
        console.log('\n  ✅ Browser auth complete! Exchanging for token...');

        const { authorization_code, code_verifier, code_challenge } = tokenResp;
        const redirectUri = `${AUTH_ISSUER}/deviceauth/callback`;

        // Exchange auth code for real tokens
        const exchangeResp = await curlPost(OAUTH_TOKEN_URL, {
          grant_type: 'authorization_code',
          code: authorization_code,
          redirect_uri: redirectUri,
          client_id: CLIENT_ID,
          code_verifier: code_verifier,
        }, 'form');

        if (exchangeResp.access_token) {
          const tokenData = {
            access_token: exchangeResp.access_token,
            refresh_token: exchangeResp.refresh_token,
            id_token: exchangeResp.id_token,
            expires_at: Date.now() + ((exchangeResp.expires_in || 86400) * 1000),
          };
          saveToken(tokenData);
          console.log('  ✅ Login successful! Token cached.\n');
          return tokenData;
        } else {
          throw new Error(`Token exchange failed: ${JSON.stringify(exchangeResp)}`);
        }
      }
    } catch (e) {
      // If polling returns non-JSON (403/404 = pending), keep waiting
      if (e.message && e.message.includes('Request failed')) {
        process.stdout.write('.');
        continue;
      }
      // If it's a JSON parse error from a 403, keep polling
      if (e.message && e.message.includes('not valid JSON')) {
        process.stdout.write('.');
        continue;
      }
      throw e;
    }
  }

  throw new Error('Login timed out. Please try again.');
}

// ─── Refresh Token ───────────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken) {
  try {
    const resp = await curlPost(OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }, 'form');

    if (resp.access_token) {
      const tokenData = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token || refreshToken,
        id_token: resp.id_token,
        expires_at: Date.now() + ((resp.expires_in || 86400) * 1000),
      };
      saveToken(tokenData);
      return tokenData;
    }
  } catch (e) { /* fall through to re-login */ }
  return null;
}

// ─── Token Exchange: id_token → OpenAI API Key ──────────────────────────────
// Same as codex-rs obtain_api_key() in server.rs

function getAccountId(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch (e) {
    return null;
  }
}

function mapMessagesToResponses(anthMessages) {
  const input = [];
  for (const m of anthMessages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        input.push({ type: 'message', role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        const texts = [];
        for (const b of m.content) {
          if (b.type === 'text') texts.push(b.text);
          if (b.type === 'tool_result') {
            const contentStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: contentStr });
          }
        }
        if (texts.length > 0) {
          input.push({ type: 'message', role: 'user', content: texts.join('\n') });
        }
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        input.push({ type: 'message', role: 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        const texts = [];
        for (const b of m.content) {
          if (b.type === 'text') texts.push(b.text);
          if (b.type === 'tool_use') {
            input.push({
              type: 'function_call',
              call_id: b.id,
              name: b.name,
              arguments: JSON.stringify(b.input || {})
            });
          }
        }
        if (texts.length > 0) {
          input.push({ type: 'message', role: 'assistant', content: texts.join('\n') });
        }
      }
    }
  }
  return input;
}

function startProxy(config, accessToken, accountId) {
  return new Promise((resolve, reject) => {
    let resolved = false; // guards against the original listen() callback
                          // firing again after a fallback rebind below.
    const server = http.createServer((req, res) => {
      // Sentinel route for sibling-process detection. Must be cheap,
      // unauthenticated, and unmistakably ours so probeGatewayHealth()
      // can recognise an existing gateway when EADDRINUSE fires.
      if (req.method === 'GET' && req.url === HEALTH_PATH) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(HEALTH_BODY);
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        return res.end('Not Found');
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const anthReq = JSON.parse(body);

          const oaiPayload = {
            model: config.default_model || 'gpt-5.3-codex',
            stream: true,
            store: false,
            instructions: typeof anthReq.system === 'string' ? anthReq.system : (JSON.stringify(anthReq.system) || ''),
            input: mapMessagesToResponses(anthReq.messages || []),
          };

          if (anthReq.tools?.length > 0) {
            oaiPayload.tools = anthReq.tools.map(t => {
              const params = t.input_schema || { type: 'object', properties: {} };
              // Conform to strict JSON schema
              params.additionalProperties = false;
              if (!params.required) {
                params.required = Object.keys(params.properties || {});
              }
              return {
                type: 'function',
                name: t.name,
                description: t.description,
                parameters: params
              };
            });
          }

          const targetUrl = new URL(config.target_api_url);
          const postData = JSON.stringify(oaiPayload);

          const proxyReq = https.request(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
              'Authorization': `Bearer ${accessToken}`,
              'chatgpt-account-id': accountId || '',
              'originator': 'codex_cli_rs',
              'User-Agent': 'codex_cli_rs/1.0'
            },
          }, (proxyRes) => {
            if (proxyRes.statusCode >= 400) {
              let errBody = '';
              proxyRes.on('data', d => errBody += d);
              proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errBody } }));
              });
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });

            const emitSSE = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

            let buffer = '';
            let currentIndex = 0;
            let currentModel = oaiPayload.model;

            proxyRes.on('data', chunk => {
              buffer += chunk;
              let lines = buffer.split('\n');
              buffer = lines.pop();

              for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;
                
                try {
                  const data = JSON.parse(dataStr);
                  if (data.type === 'response.created') {
                    currentModel = data.response?.model || currentModel;
                    emitSSE('message_start', {
                      type: 'message_start',
                      message: {
                        id: data.response?.id || 'msg_unknown',
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: currentModel,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 1 }
                      }
                    });
                  } else if (data.type === 'response.output_item.added') {
                    if (data.item?.type === 'message') {
                      emitSSE('content_block_start', {
                        type: 'content_block_start',
                        index: currentIndex,
                        content_block: { type: 'text', text: '' }
                      });
                    } else if (data.item?.type === 'function_call') {
                      emitSSE('content_block_start', {
                        type: 'content_block_start',
                        index: currentIndex,
                        content_block: { type: 'tool_use', id: data.item.call_id, name: data.item.name, input: {} }
                      });
                    }
                  } else if (data.type === 'response.output_text.delta') {
                    if (data.delta) {
                      emitSSE('content_block_delta', {
                        type: 'content_block_delta',
                        index: currentIndex,
                        delta: { type: 'text_delta', text: data.delta }
                      });
                    }
                  } else if (data.type === 'response.function_call_arguments.delta') {
                    if (data.delta) {
                      emitSSE('content_block_delta', {
                        type: 'content_block_delta',
                        index: currentIndex,
                        delta: { type: 'input_json_delta', partial_json: data.delta }
                      });
                    }
                  } else if (data.type === 'response.output_item.done') {
                    emitSSE('content_block_stop', { type: 'content_block_stop', index: currentIndex });
                    currentIndex++;
                  } else if (data.type === 'response.completed') {
                    const usage = data.response?.usage || { output_tokens: 15 };
                    const outputs = data.response?.output || [];
                    const stopReason = (outputs.length > 0 && outputs[outputs.length - 1].type === 'function_call') ? 'tool_use' : 'end_turn';
                    emitSSE('message_delta', {
                      type: 'message_delta',
                      delta: { stop_reason: stopReason, stop_sequence: null },
                      usage: { output_tokens: usage.output_tokens }
                    });
                    emitSSE('message_stop', { type: 'message_stop' });
                    res.end();
                  }
                } catch (e) { /* ignore */ }
              }
            });

            proxyRes.on('end', () => res.end());
          });

          proxyReq.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
            }
          });

          proxyReq.write(postData);
          proxyReq.end();
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: e.message } }));
        }
      });
    });

    server.on('error', async (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // Try to fall back to another port in our reserved range. We
        // intentionally do NOT kill whatever owns the conflicting port
        // — gateway.js runs as the user, so killing arbitrary PIDs
        // would be a footgun. Reuse-detection lives one layer up in
        // main(), which probes the port before calling startProxy.
        const fallback = await findFreePort(DEFAULT_PROXY_PORT, PORT_FALLBACK_RANGE_END);
        if (fallback !== null) {
          console.warn(`  ⚠️  Port ${PROXY_PORT} in use — falling back to ${fallback}`);
          PROXY_PORT = fallback;
          // Rebind on the new port. Listening twice on one server
          // throws, but our previous listen() never bound (it errored
          // synchronously into this handler), so this is safe.
          server.listen(PROXY_PORT, '127.0.0.1', () => {
            if (resolved) return;
            resolved = true;
            writePortFile(PROXY_PORT);
            console.log(`  ✅ Proxy running on http://127.0.0.1:${PROXY_PORT}`);
            resolve(server);
          });
          return;
        }
        console.error(`\n  ❌ No free port found in ${DEFAULT_PROXY_PORT}-${PORT_FALLBACK_RANGE_END}.`);
        console.error(`     Stop the conflicting process or set CODEX_GATEWAY_PORT to`);
        console.error(`     another value before retrying.\n`);
        return reject(err);
      }
      console.error(`\n  ❌ Proxy server error: ${err && err.message ? err.message : err}\n`);
      reject(err);
    });

    // Bind to loopback only. The proxy has no authentication of its
    // own (it relies on the OAuth token cached at ~/.codex-gateway), so
    // it must never be reachable from a non-local network. In the
    // Docker image Mission Control runs in the same container and
    // reaches us over container loopback, so 127.0.0.1 is sufficient.
    server.listen(PROXY_PORT, '127.0.0.1', () => {
      if (resolved) return;
      resolved = true;
      writePortFile(PROXY_PORT);
      console.log(`  ✅ Proxy running on http://127.0.0.1:${PROXY_PORT}`);
      resolve(server);
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Headless poll for a usable token written by another process (the web
 * dashboard's device-code flow shares the same token.json). Resolves
 * once a fresh token appears or rejects if the deadline elapses.
 */
async function waitForToken(maxWaitMs = 24 * 60 * 60 * 1000, intervalMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const tok = loadToken();
    if (tok) {
      console.log('  ✅ Token found — proceeding');
      return tok;
    }
    // Try to refresh from a possibly-expired token on disk so the
    // dashboard doesn't have to do the device-code dance for every
    // container restart.
    if (fs.existsSync(TOKEN_FILE)) {
      try {
        const oldToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (oldToken?.refresh_token) {
          const refreshed = await refreshAccessToken(oldToken.refresh_token);
          if (refreshed) {
            console.log('  ✅ Token refreshed from disk');
            return refreshed;
          }
        }
      } catch { /* ignore */ }
    }
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for token (use the dashboard at :3000 to sign in)');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup')) {
    await runSetup();
    return;
  }

  const config = loadConfig();
  
  // Override for Codex responses API
  config.target_api_url = 'https://chatgpt.com/backend-api/codex/responses';
  config.default_model = 'gpt-5.3-codex';

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     🚀 Claude Codex — Anthropic-shaped Gateway   ║');
  console.log('║     (proxies Claude Code → ChatGPT Codex API)    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`  Model: ${config.default_model}  |  API: ${config.target_api_url}\n`);

  const isServe = args.includes('--serve');

  // Get token
  let tokenData = null;

  if (!args.includes('--login')) {
    tokenData = loadToken();
    if (tokenData) {
      console.log('  🔑 Using cached token (still valid)');
    }
  }

  if (!tokenData) {
    const oldToken = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : null;
    if (oldToken?.refresh_token && !args.includes('--login')) {
      console.log('  🔄 Token expired, refreshing...');
      tokenData = await refreshAccessToken(oldToken.refresh_token);
      if (tokenData) {
        console.log('  ✅ Token refreshed!');
      }
    }

    if (!tokenData) {
      if (isServe) {
        // Headless: poll for a token written by the web dashboard
        // login flow instead of opening a browser-based device code.
        console.log('  ⏳ No token yet — waiting for web dashboard login...');
        tokenData = await waitForToken();
      } else {
        tokenData = await deviceCodeLogin();
      }
    }
  }

  const bearerToken = tokenData.access_token;
  const accountId = getAccountId(tokenData.id_token);

  // Reuse path: in interactive mode, if our preferred port already
  // belongs to a healthy claude-codex gateway (e.g. the operator left
  // one running, or the Docker entrypoint owns :18923), don't try to
  // start a second proxy — just point Claude at the existing one. We
  // skip this in --serve mode because that path is the one that
  // *provides* the gateway; the dashboard polls token.json and would
  // never see progress otherwise.
  let proxyServer = null;
  let reusedExistingGateway = false;
  if (!isServe) {
    const healthy = await probeGatewayHealth(PROXY_PORT);
    if (healthy) {
      console.log(`  ♻️  Reusing existing claude-codex gateway on 127.0.0.1:${PROXY_PORT}`);
      reusedExistingGateway = true;
      // Make sure the port file matches reality so the dashboard
      // resolves the same URL we're about to hand to Claude.
      writePortFile(PROXY_PORT);
    }
  }

  if (!reusedExistingGateway) {
    // Start proxy
    console.log('  🔄 Starting streaming proxy (Anthropic → ChatGPT Codex backend)...');
    proxyServer = await startProxy(config, bearerToken, accountId);
  }

  // Headless mode: serve the proxy and stop here. Used by the Docker
  // container, which runs the Next.js dashboard alongside.
  if (isServe) {
    console.log(`  ✅ Proxy listening on port ${PROXY_PORT}`);
    console.log('  (--serve mode: not launching Claude)');
    process.on('SIGINT', () => { if (proxyServer) proxyServer.close(); process.exit(0); });
    process.on('SIGTERM', () => { if (proxyServer) proxyServer.close(); process.exit(0); });
    return;
  }

  // Prepare isolated Claude config to bypass login screen
  const claudeConfigDir = path.join(CONFIG_DIR, 'claude-config');
  if (!fs.existsSync(claudeConfigDir)) {
    fs.mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  }

  // Generate a realistic-looking dummy API key (Claude validates format)
  const dummyKey = `sk-ant-api03-${crypto.randomBytes(36).toString('base64url')}-${crypto.randomBytes(18).toString('base64url')}`;

  // Write claude.json with hasCompletedOnboarding=true to skip TUI login
  const claudeJson = path.join(claudeConfigDir, '.claude.json');
  const claudeJsonData = { hasCompletedOnboarding: true };
  fs.writeFileSync(claudeJson, JSON.stringify(claudeJsonData, null, 2), { mode: 0o600 });

  // Create settings dir and apiKeyHelper
  const settingsDir = path.join(claudeConfigDir, '.claude');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  }

  // Write apiKeyHelper script
  const keyHelperScript = path.join(settingsDir, 'api-key-helper.sh');
  fs.writeFileSync(keyHelperScript, `#!/bin/sh\necho "${dummyKey}"\n`, { mode: 0o755 });

  // Write settings.json with apiKeyHelper
  const settingsJson = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsJson, JSON.stringify({
    apiKeyHelper: keyHelperScript,
  }, null, 2), { mode: 0o600 });

  // ── Argument sanitisation for the spawned `claude` process ──────────
  //
  // Two interactivity foot-guns the upstream CLI surfaces:
  //
  //   1. `--print` / `-p` puts the CLI in non-interactive print mode
  //      and requires piped stdin. When the user runs `claude-codex
  //      --print` from a terminal (no pipe) the CLI hangs ~3s and
  //      then dies with "Input must be provided either through
  //      stdin...". Detect that combination and drop the flag with a
  //      warning so the chat opens normally.
  //
  //   2. The Write/Edit/Bash tools all prompt for confirmation
  //      unless the user opts out, which makes long agent runs grind
  //      to a halt. By operator request the gateway defaults to
  //      `--dangerously-skip-permissions` so every tool call goes
  //      through without a prompt. The user can still opt out by
  //      passing any explicit permission flag (`--permission-mode`,
  //      `--allowedTools`, or `--dangerously-skip-permissions`
  //      itself), in which case we leave their choice alone. Set
  //      `CODEX_GATEWAY_SAFE_PERMISSIONS=1` to disable the auto-
  //      injection entirely if the dangerous default is ever
  //      undesirable in a particular environment.
  let claudeArgs = args.filter((a) => a !== '--login');

  const stdinIsTty = Boolean(process.stdin.isTTY);
  const printIdx = claudeArgs.findIndex((a) => a === '--print' || a === '-p');
  if (printIdx !== -1 && stdinIsTty) {
    console.warn(
      '  ⚠️  --print/-p requires piped stdin; running interactively instead.\n' +
      '      Pipe input (e.g. `echo "hi" | claude-codex --print`) to use print mode.',
    );
    claudeArgs.splice(printIdx, 1);
  }

  const hasPermissionFlag = claudeArgs.some(
    (a) =>
      a === '--permission-mode' ||
      a.startsWith('--permission-mode=') ||
      a === '--allowedTools' ||
      a.startsWith('--allowedTools=') ||
      a === '--dangerously-skip-permissions',
  );
  if (!hasPermissionFlag && process.env.CODEX_GATEWAY_SAFE_PERMISSIONS !== '1') {
    claudeArgs.push('--dangerously-skip-permissions');
    console.warn(
      '  ⚠️  Auto-applying --dangerously-skip-permissions (Claude tools will not prompt).\n' +
      '      Set CODEX_GATEWAY_SAFE_PERMISSIONS=1 to disable this default,\n' +
      '      or pass an explicit --permission-mode / --allowedTools flag.',
    );
  }

  // Launch claude
  console.log('  🚀 Launching Claude Code through the claude-codex gateway...\n');
  console.log('  ─────────────────────────────────────────────────\n');

  const claudeEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://localhost:${PROXY_PORT}`,
    ANTHROPIC_API_KEY: dummyKey,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };

  const claude = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: claudeEnv,
  });

  const closeProxy = () => { if (proxyServer) proxyServer.close(); };

  claude.on('close', (code) => {
    closeProxy();
    process.exit(code || 0);
  });

  claude.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('\n  ❌ "claude" command not found. Install with: npm install -g @anthropic-ai/claude-code');
    } else {
      console.error(`\n  ❌ Error: ${err.message}`);
    }
    closeProxy();
    process.exit(1);
  });

  process.on('SIGINT', () => { claude.kill('SIGINT'); closeProxy(); });
  process.on('SIGTERM', () => { claude.kill('SIGTERM'); closeProxy(); });
}

main().catch(err => {
  console.error(`\n  ❌ Fatal: ${err.message}`);
  process.exit(1);
});
