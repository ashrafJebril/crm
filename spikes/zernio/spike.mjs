#!/usr/bin/env node
/*
 * Zernio spike harness — THROWAWAY. Proves the make-or-break claims before any migration.
 *
 * Zero dependencies: Node 18+ built-in `fetch`, `http`, `crypto`.
 * Reads config from environment (see .env.example). Load it however you like, e.g.:
 *   bash:  set -a; . ./.env; set +a; node spike.mjs <cmd>
 *   pwsh:  Get-Content .env | ForEach-Object { if ($_ -match '^(\w+)=(.*)$') { $env:($matches[1]) = $matches[2] } }; node spike.mjs <cmd>
 *
 * Commands:
 *   profile [name]                         Create a Zernio profile (= one tkana customer). Prints its _id.
 *   connect <platform> <profileId>         Get the hosted OAuth connect URL. Open it in a browser signed into the TEST account.
 *   accounts <profileId>                   List connected accounts for a profile (to find accountId).
 *   conversations <profileId> [platform]   List inbox conversations.
 *   send <conversationId> <accountId> <msg> Reply in a conversation.
 *   post <platform> <accountId> <content>  Publish a post (TikTok/Snapchat publish test).
 *   listen                                 Start the webhook + OAuth-redirect receiver (verifies X-Zernio-Signature).
 *
 *   -- comment automations (comment → private DM), added 2026-11-25 --
 *   ca:list <profileId>                    List comment automations. READ-ONLY, safe.
 *   ca:probe-disable <automationId>        Probe every plausible "turn this off" call. SAFE: only stops things.
 *   ca:create ... --i-understand           Create a LIVE automation. SENDS REAL DMs. Gated on purpose.
 *
 * platform ∈ facebook | instagram | whatsapp | tiktok | snapchat (and others Zernio supports)
 */

import http from 'node:http';
import crypto from 'node:crypto';

const BASE = (process.env.ZERNIO_BASE_URL || 'https://zernio.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.ZERNIO_API_KEY || '';
const WEBHOOK_SECRET = process.env.ZERNIO_WEBHOOK_SECRET || '';
const PORT = Number(process.env.PORT || 4444);
const PUBLIC_URL = (process.env.ZERNIO_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const REDIRECT_PATH = '/oauth/redirect';
const WEBHOOK_PATH = '/webhooks/zernio';

const KNOWN_PLATFORMS = ['facebook', 'instagram', 'whatsapp', 'tiktok', 'snapchat'];

function requireKey() {
  if (!API_KEY) {
    console.error('✗ ZERNIO_API_KEY is not set. Copy .env.example → .env, fill it, and load it into the environment.');
    process.exit(1);
  }
}

/** Thin API client that logs every request and throws on non-2xx. */
async function api(method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const started = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (err) {
    console.error(`✗ ${method} ${url.pathname} — network error: ${err.message}`);
    throw err;
  }
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  const ms = Date.now() - started;
  console.log(`${res.ok ? '✓' : '✗'} ${method} ${url.pathname}${url.search}  → ${res.status} (${ms}ms)`);
  if (!res.ok) {
    console.error(typeof json === 'string' ? json : JSON.stringify(json, null, 2));
    throw new Error(`Zernio API ${res.status} on ${method} ${path}`);
  }
  return json;
}

function pick(obj, ...keys) {
  // Return the first defined value among nested candidates, e.g. pick(r, 'profile._id', '_id', 'id')
  for (const k of keys) {
    const val = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
    if (val != null) return val;
  }
  return undefined;
}

// ---- Commands -------------------------------------------------------------

async function cmdProfile(name = 'tkana-spike-customer') {
  requireKey();
  const r = await api('POST', '/profiles', { body: { name, description: 'Zernio spike — throwaway test profile' } });
  const id = pick(r, 'profile._id', 'data.profile._id', '_id', 'id');
  console.log('\nProfile created.');
  console.log('  profileId:', id);
  console.log('\nNext: node spike.mjs connect facebook', id);
}

async function cmdConnect(platform, profileId) {
  requireKey();
  if (!platform || !profileId) return help('connect <platform> <profileId>');
  if (!KNOWN_PLATFORMS.includes(platform)) console.log(`(note: "${platform}" is not in the expected set ${KNOWN_PLATFORMS.join(', ')} — trying anyway)`);
  const redirect_url = `${PUBLIC_URL}${REDIRECT_PATH}`;
  const r = await api('GET', `/connect/${platform}`, { query: { profileId, redirect_url } });
  const authUrl = pick(r, 'authUrl', 'data.authUrl', 'url');
  console.log('\n=== MAKE-OR-BREAK TEST ===');
  console.log('1. Open this URL in a browser signed into the TEST', platform, 'account:\n');
  console.log('  ', authUrl, '\n');
  console.log('2. WATCH the consent screen:');
  console.log('   ✓ PASS  → it shows ZERNIO\'s app name and completes with NO "add as tester" / NO App Review.');
  console.log('   ✗ FAIL  → it asks for OUR app, or errors "app not available to this user".');
  console.log('3. After authorizing you land on', redirect_url, '(run `node spike.mjs listen` first to capture it).');
  console.log('   Also expect an `account.connected` webhook if the listener is running.');
}

async function cmdAccounts(profileId) {
  requireKey();
  if (!profileId) return help('accounts <profileId>');
  const r = await api('GET', '/accounts', { query: { profileId } });
  const accounts = r.accounts || r.data || [];
  console.log(`\n${accounts.length} connected account(s):`);
  for (const a of accounts) {
    const status = a.platformStatus || (a.isActive ? 'active' : 'inactive');
    console.log(`  • ${String(a.platform).padEnd(10)} ${a.displayName || a.username || a.name || ''}  [accountId ${a._id}]  status=${status}`);
  }
}

async function cmdWa(profileId) {
  requireKey();
  if (!profileId) return help('wa <profileId>');
  const r = await api('GET', '/whatsapp/phone-numbers', { query: { profileId } });
  console.log('  provisioned numbers:', JSON.stringify(r.numbers || []));
  console.log('  connected WABAs:', JSON.stringify(r.connected || []));
  if (r.sandbox) console.log('  sandbox:', r.sandbox.phoneNumber, '(message this to test WhatsApp without provisioning; start template:', r.sandbox.template?.name + ')');
}

async function cmdConversations(profileId, platform) {
  requireKey();
  if (!profileId) return help('conversations <profileId> [platform]');
  const r = await api('GET', '/inbox/conversations', { query: { profileId, platform } });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdSend(conversationId, accountId, ...msg) {
  requireKey();
  const message = msg.join(' ');
  if (!conversationId || !accountId || !message) return help('send <conversationId> <accountId> <message>');
  const r = await api('POST', `/inbox/conversations/${conversationId}/messages`, { body: { accountId, message } });
  console.log('Sent:', JSON.stringify(r, null, 2));
}

async function cmdPost(platform, accountId, ...content) {
  requireKey();
  const text = content.join(' ');
  if (!platform || !accountId || !text) return help('post <platform> <accountId> <content>');
  const r = await api('POST', '/posts', {
    body: { content: text, platforms: [{ platform, accountId }], publishNow: true },
  });
  console.log('Published:', JSON.stringify(r, null, 2));
}

// ---- Comment automations (comment → private DM) ---------------------------
//
// Added 2026-11-25 for the comment auto-reply feature. The docs publish exactly
// two endpoints — POST /comment-automations (create) and GET /comment-automations
// (list) — and NOTHING for update, delete, or setting isActive back to false.
// `isActive` appears in the create RESPONSE schema, which hints it is settable,
// but no endpoint for doing so is documented.
//
// That gap decides the whole feature: an automation runs at Zernio, not in our
// process, so if there is no way to disable one we must not ship a UI toggle
// that pretends otherwise. `ca:probe-disable` below settles it by probing,
// because no amount of further doc-reading can.

/**
 * A raw request that does NOT throw on non-2xx — we want the status codes
 * themselves as the result, including the 404s and 405s.
 */
async function probe(method, path, body) {
  const url = new URL(BASE + path);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, ok: res.ok, body: json };
  } catch (err) {
    return { status: 0, ok: false, body: `network error: ${err.message}` };
  }
}

async function cmdCaList(profileId) {
  requireKey();
  const r = await api('GET', '/comment-automations', { query: { profileId } });
  const list = r.automations || r.data || r.items || [];
  if (!Array.isArray(list)) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`\n${list.length} comment automation(s):`);
  for (const a of list) {
    const id = a._id || a.id;
    const stats = a.stats ? ` dmsSent=${a.stats.dmsSent} failed=${a.stats.dmsFailed}` : '';
    console.log(`  • [${id}] ${a.name || '(unnamed)'}  active=${a.isActive}  account=${a.accountId}  keywords=${JSON.stringify(a.keywords)}${stats}`);
  }
  console.log('\nFull payload (field names matter for the client):');
  console.log(JSON.stringify(r, null, 2));
}

/**
 * THE question this whole spike exists to answer: can an automation be turned
 * off once it exists?
 *
 * Safe to run. Every call here tries to STOP an automation — the worst outcome
 * is that a test automation gets disabled or deleted, which is what we want
 * anyway. It never creates anything and never sends a message.
 *
 * Stops at the first call that works, so we don't delete a rule we only needed
 * to deactivate.
 */
async function cmdCaProbeDisable(automationId) {
  requireKey();
  if (!automationId) return help('ca:probe-disable <automationId>   (get one from `ca:list`)');

  const enc = encodeURIComponent(automationId);
  const candidates = [
    // Least destructive first: flip the flag in place.
    ['PATCH',  `/comment-automations/${enc}`, { isActive: false }],
    ['PUT',    `/comment-automations/${enc}`, { isActive: false }],
    ['POST',   `/comment-automations/${enc}`, { isActive: false }],
    ['PATCH',  `/comment-automations/${enc}/status`, { isActive: false }],
    // Verb-style endpoints.
    ['POST',   `/comment-automations/${enc}/disable`, undefined],
    ['POST',   `/comment-automations/${enc}/deactivate`, undefined],
    ['POST',   `/comment-automations/${enc}/pause`, undefined],
    // Last resort: remove it entirely.
    ['DELETE', `/comment-automations/${enc}`, undefined],
  ];

  console.log('\n=== PROBE: can a comment automation be switched off? ===');
  console.log('Target automation:', automationId);
  console.log('Every call below tries to STOP it. Nothing is created, nothing is sent.\n');

  // Zernio distinguishes the two kinds of 404, which is what makes probing with
  // a FAKE id useful: a missing ROUTE answers
  //   {"error":"No such API endpoint: …","code":"endpoint_not_found"}
  // while a route that exists and merely could not find the row answers
  //   {"error":"Automation not found"}.
  // The second means the endpoint is real and simply undocumented.
  const isMissingRoute = (r) =>
    r.status === 404 &&
    (r.body?.code === 'endpoint_not_found' ||
      String(r.body?.error || '').startsWith('No such API endpoint'));

  const results = [];
  let winner = null;
  for (const [method, path, body] of candidates) {
    const r = await probe(method, path, body);
    const exists = r.ok || (r.status === 404 && !isMissingRoute(r)) || r.status === 400 || r.status === 422;
    const verdict =
      r.ok ? '✓ WORKS'
      : isMissingRoute(r) ? '· no such endpoint'
      : r.status === 404 ? '✓ ENDPOINT EXISTS (id not found)'
      : r.status === 405 ? '· method not allowed on this path'
      : r.status === 400 || r.status === 422 ? '✓ ENDPOINT EXISTS (body rejected)'
      : r.status === 401 || r.status === 403 ? '! auth/plan refused'
      : `· ${r.status}`;
    console.log(`  ${verdict.padEnd(34)} ${method.padEnd(6)} ${path}`);
    if (!r.ok && r.body) {
      const msg = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      console.log(`${' '.repeat(41)}${msg.slice(0, 160)}`);
    }
    results.push({ method, path, status: r.status, ok: r.ok, exists, body: r.body });
    if (r.ok) { winner = { method, path, body }; break; }
  }

  console.log('\n--- VERDICT ---');
  const real = results.filter((r) => r.exists);
  if (winner) {
    console.log(`✓ Disable CONFIRMED WORKING: ${winner.method} ${winner.path}`);
    console.log('  → Build the settings card WITH a real on/off toggle, as designed.');
    console.log('  → Now run `ca:list` to confirm isActive flipped to false.');
  } else if (real.length) {
    console.log('✓ These endpoints EXIST (undocumented) — the id was fake, so none could succeed:');
    for (const r of real) console.log(`    ${r.method} ${r.path}  → ${r.status} ${JSON.stringify(r.body)}`);
    console.log('\n  → A disable path almost certainly exists. To prove it end to end you need a');
    console.log('    REAL automation id: `ca:create … --i-understand`, then re-run this probe');
    console.log('    against that id. Only then is the toggle proven.');
  } else {
    console.log('✗ Every candidate answered endpoint_not_found.');
    console.log('  Treat "no disable" as confirmed, and:');
    console.log('    1. do NOT ship a UI toggle (see the design doc, "The blocking unknown"),');
    console.log('    2. open a ticket with Zernio asking for a deactivate endpoint.');
  }
  console.log('\nRaw results:');
  console.log(JSON.stringify(results, null, 2));
}

/**
 * Create a live comment automation.
 *
 * DANGER: this is outward-facing. Once active, Zernio sends REAL private DMs to
 * REAL people who comment the keyword on the connected account — and Meta allows
 * exactly one per comment, so a mistake cannot be undone. Gated behind an
 * explicit flag on purpose.
 *
 * Use a throwaway keyword nobody would ever type, and scope it to one test post
 * with --post, so a stranger cannot trigger it.
 */
async function cmdCaCreate(...argv) {
  requireKey();
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [profileId, accountId, keyword, ...dmParts] = args;
  const dmMessage = dmParts.join(' ');
  const postFlag = argv.find((a) => a.startsWith('--post='));
  const platformPostId = postFlag ? postFlag.slice('--post='.length) : undefined;

  if (!profileId || !accountId || !keyword || !dmMessage) {
    return help('ca:create <profileId> <accountId> <keyword> <dm message...> [--post=<platformPostId>] --i-understand');
  }
  if (!flags.has('--i-understand')) {
    console.error('\n✗ Refusing to create a live automation without --i-understand.\n');
    console.error('  Once active, Zernio sends REAL private DMs to REAL people who comment');
    console.error('  this keyword on that account. Meta allows ONE private reply per comment,');
    console.error('  ever — a wrong message cannot be retried.\n');
    console.error('  Before you pass the flag:');
    console.error('    • use a nonsense keyword nobody would type (e.g. zzspikeprobe77),');
    console.error('    • pass --post=<platformPostId> so only one test post is in scope,');
    console.error('    • be ready to run `ca:probe-disable` straight afterwards.\n');
    process.exitCode = 1;
    return;
  }

  const body = {
    profileId,
    accountId,
    name: `spike probe ${new Date().toISOString()}`,
    trigger: 'comment',
    keywords: [keyword],
    matchMode: 'exact',
    dmMessage,
    repeatPolicy: { mode: 'once' },
    isActive: true,
    ...(platformPostId ? { platformPostId } : {}),
  };

  if (!platformPostId) {
    console.log('⚠ No --post given: this rule is ACCOUNT-WIDE and watches the 5 newest posts.');
  }
  console.log('Creating with body:', JSON.stringify(body, null, 2));
  const r = await api('POST', '/comment-automations', { body });
  const id = pick(r, 'automation._id', 'automation.id', 'data.automation._id', '_id', 'id');
  console.log('\nCreated.');
  console.log('  automationId:', id);
  console.log('  Full response (field names matter for the client):');
  console.log(JSON.stringify(r, null, 2));
  console.log('\n>>> NEXT, IMMEDIATELY: node spike.mjs ca:probe-disable', id);
}

// ---- Webhook + redirect receiver -----------------------------------------

function verifySignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return null; // can't verify without the secret
  const computed = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(String(signature || ''));
  const b = Buffer.from(computed);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function summarizeEvent(evt) {
  const type = evt?.type || evt?.event || '(unknown type)';
  const lines = [`  event: ${type}`];
  const d = evt?.data || evt?.payload || evt;
  if (type.startsWith('message.')) {
    lines.push(`  conversationId: ${pick(d, 'conversationId', 'conversation._id', 'conversation.id')}`);
    lines.push(`  accountId: ${pick(d, 'accountId', 'account._id')}`);
    lines.push(`  platform: ${pick(d, 'platform')}`);
    lines.push(`  direction: ${pick(d, 'direction')}`);
    lines.push(`  from: ${pick(d, 'sender.name', 'sender.username', 'from')}`);
    lines.push(`  text: ${pick(d, 'text', 'message', 'body', 'content')}`);
    lines.push(`  messageId: ${pick(d, 'messageId', '_id', 'id')}`);
  } else if (type.startsWith('account.')) {
    lines.push(`  platform: ${pick(d, 'platform')}`);
    lines.push(`  accountId: ${pick(d, 'accountId', 'account._id')}`);
    lines.push(`  profileId: ${pick(d, 'profileId')}`);
    lines.push(`  name: ${pick(d, 'account.name', 'name', 'username')}`);
  } else if (type.startsWith('whatsapp.number.')) {
    lines.push('  >>> WhatsApp number lifecycle event — this is the provisioning/KYC signal we care about');
    lines.push(`  ${JSON.stringify(d)}`);
  }
  return lines.join('\n');
}

function cmdListen() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, PUBLIC_URL);

    if (req.method === 'GET' && url.pathname === REDIRECT_PATH) {
      const q = Object.fromEntries(url.searchParams.entries());
      console.log('\n── OAuth redirect landed ──');
      console.log(JSON.stringify(q, null, 2));
      if (q.error) console.log('✗ Connect returned an error:', q.error);
      else console.log('✓ Redirect captured (profileId/tempToken present = OAuth leg completed).');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Connected — you can close this tab.</h2>');
      return;
    }

    if (req.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const sig = req.headers['x-zernio-signature'] || req.headers['x-late-signature'];
        const ok = verifySignature(rawBody, sig);
        let evt; try { evt = JSON.parse(rawBody); } catch { evt = rawBody; }
        console.log('\n── Webhook received ──');
        console.log('  signature:', ok === null ? '(no secret set — cannot verify)' : ok ? '✓ VALID' : '✗ INVALID');
        console.log(summarizeEvent(evt));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('zernio spike listener up');
  });

  server.listen(PORT, () => {
    console.log(`Listening on :${PORT}`);
    console.log(`  webhook  → ${PUBLIC_URL}${WEBHOOK_PATH}`);
    console.log(`  redirect → ${PUBLIC_URL}${REDIRECT_PATH}`);
    if (!WEBHOOK_SECRET) console.log('  ⚠ ZERNIO_WEBHOOK_SECRET not set — signatures will not be verified.');
    console.log('\nRegister the webhook URL above in Zernio (Settings → Webhooks), subscribe to message.received, account.connected, whatsapp.number.*');
    console.log('Send a DM to a connected account to see message.received arrive.');
  });
}

// ---- CLI ------------------------------------------------------------------

function help(usage) {
  if (usage) console.error('Usage: node spike.mjs ' + usage);
  else {
    console.log('Zernio spike harness. Commands:');
    console.log('  profile [name]');
    console.log('  connect <platform> <profileId>');
    console.log('  accounts <profileId>');
    console.log('  wa <profileId>');
    console.log('  conversations <profileId> [platform]');
    console.log('  send <conversationId> <accountId> <message...>');
    console.log('  post <platform> <accountId> <content...>');
    console.log('  listen');
    console.log('');
    console.log('  comment automations (comment → private DM):');
    console.log('  ca:list <profileId>                     read-only');
    console.log('  ca:probe-disable <automationId>         safe — only tries to stop things');
    console.log('  ca:create <profileId> <accountId> <keyword> <dm...> [--post=<id>] --i-understand');
    console.log('                                          ⚠ sends REAL DMs');
  }
  process.exitCode = 1;
}

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'profile': await cmdProfile(...args); break;
    case 'connect': await cmdConnect(...args); break;
    case 'accounts': await cmdAccounts(...args); break;
    case 'wa': await cmdWa(...args); break;
    case 'conversations': await cmdConversations(...args); break;
    case 'send': await cmdSend(...args); break;
    case 'post': await cmdPost(...args); break;
    case 'listen': cmdListen(); break;
    case 'ca:list': await cmdCaList(...args); break;
    case 'ca:probe-disable': await cmdCaProbeDisable(...args); break;
    case 'ca:create': await cmdCaCreate(...args); break;
    default: help();
  }
} catch (err) {
  console.error('\nSpike command failed:', err.message);
  process.exitCode = 1;
}
