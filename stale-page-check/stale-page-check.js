/**
 * Stale Page Check
 *
 * Finds pages that are live on production but no longer exist in da.live —
 * deleted, renamed, or missed during publishing — and lets an operator
 * select and unpublish them.
 *
 * Only paths that are IN the live index and NOT in da.live are listed.
 *
 * Auth (da.live): uses the official DA App SDK (https://docs.da.live/developers/
 * guides/developing-apps-and-plugins), which hands us an already-authenticated
 * token via a postMessage handshake with da.live. This ONLY works when the
 * page is opened through da.live's app URL:
 *
 *     https://da.live/app/{org}/{repo}/tools/stale-page-check
 *
 * Opened directly, the manual "da.live auth token" field is the fallback.
 *
 * Auth (admin.hlx.page): uses the logged-in browser session
 * (credentials: "include"); the token field is optional.
 *
 * Safety: the scan REFUSES to show results if the da.live listing is empty,
 * failed, or shares zero paths with the live index (which would mean the two
 * path formats don't line up and every live page would look "stale").
 */

const DA_LIST_BASE = "https://admin.da.live/list";
const DA_SOURCE_BASE = "https://admin.da.live/source";
const LIST_CONCURRENCY = 6;
// If more than this share of live pages is flagged stale, show a warning.
const SUSPICIOUS_STALE_RATIO = 0.5;

const state = {
  stalePages: [], // [path]
  sdkToken: null,
  suspicious: false,
  daKeys: null, // Set of da.live paths from the last scan (for the manual-unpublish warning)
  daScope: "", // "org/repo" the daKeys belong to
};

const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("log");
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Never serve scan data from the browser cache: `cache: "no-store"` skips the
// HTTP cache entirely, and the `_` query param makes each URL unique so no
// intermediate cache can hand back an old copy either. (Neither adds request
// headers, so no CORS preflight is triggered.)
const NO_CACHE = { cache: "no-store" };

function withCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set("_", Date.now());
  return u.toString();
}

// ---------- Keep Live index URL in sync with Org/Repo/Branch ----------

let lastAutoIndexUrl = null;

function deriveIndexUrl(org, repo, branch) {
  return `https://${branch}--${repo}--${org}.aem.live/full-index.json`;
}

function updateDefaultIndexUrl() {
  const org = $("cfg-org").value.trim();
  const repo = $("cfg-repo").value.trim();
  const branch = $("cfg-branch").value.trim() || "main";
  if (!org || !repo) return;

  const derived = deriveIndexUrl(org, repo, branch);
  const current = $("cfg-index").value.trim();

  // Only auto-fill if the field is empty, or still holds whatever we last
  // auto-generated ourselves — never clobber a URL typed in by hand.
  if (!current || current === lastAutoIndexUrl) {
    $("cfg-index").value = derived;
    lastAutoIndexUrl = derived;
    log(`Live index URL auto-set to ${derived} (based on org/repo/branch)`);
  }
}

// ---------- DA App SDK: get an authenticated token + context ----------

async function initDaSdk() {
  const note = $("sdk-note");
  try {
    const mod = await import("https://da.live/nx/utils/sdk.js");
    const DA_SDK = mod.default;
    log(`DA SDK loaded. Running inside an iframe: ${window.self !== window.top}`);

    // The SDK only resolves once da.live answers the postMessage handshake.
    // Without a timeout the banner would sit on "Checking…" forever.
    const { context, token } = await Promise.race([
      DA_SDK,
      sleep(8000).then(() => {
        throw new Error(
          "no answer from da.live within 8s — open this tool via da.live/app/{org}/{repo}/tools/stale-page-check (not the direct aem.page URL)",
        );
      }),
    ]);

    if (token) {
      state.sdkToken = token;
      $("cfg-da-token").value = token;
      $("cfg-da-token").placeholder = "auto-filled from da.live session";
      // The token is scoped to this org/repo, so lock the fields.
      $("cfg-org").disabled = true;
      $("cfg-repo").disabled = true;
    }
    if (context) {
      if (context.org) $("cfg-org").value = context.org;
      if (context.repo || context.site) $("cfg-repo").value = context.repo || context.site;
    }

    if (token) {
      note.textContent = `✓ Authenticated via da.live for ${$("cfg-org").value}/${$("cfg-repo").value}. To check a different repo, open this tool via da.live/app/{org}/{other-repo}/tools/stale-page-check instead — the org/repo fields are locked because the token only works for the repo you opened this from.`;
      note.className = "sdk-note ok";
    } else {
      note.textContent = "Opened outside da.live — no token received. Paste one manually below, or open this tool via da.live/app/{org}/{repo}/tools/stale-page-check instead.";
      note.className = "sdk-note warn";
    }
  } catch (err) {
    note.textContent = "Opened outside da.live (or SDK failed to load) — paste a da.live token manually below.";
    note.className = "sdk-note warn";
    log(`DA SDK not available: ${err.message}`);
  }

  updateDefaultIndexUrl();
}

// ---------- Path helpers ----------

/**
 * Bring any path (live index or da.live) to one canonical form:
 *   - full URLs -> pathname only; query/hash removed
 *   - leading slash, no trailing slash
 *   - .html / .md / .json extension removed
 *   - /index -> folder path  (/en/index.html -> /en, /index.html -> /)
 */
function normalizePath(p) {
  if (!p) return "";
  let path = String(p).trim();

  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch (e) {
      return "";
    }
  }

  path = path.split(/[?#]/)[0];
  try {
    path = decodeURI(path);
  } catch (e) {
    /* keep as-is */
  }

  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\.(html|md|json)$/i, "");
  path = path.replace(/\/index$/i, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

// Comparison key: EDS paths are case-insensitive in practice, so compare lowercase.
const pathKey = (p) => p.toLowerCase();

/**
 * Live-index paths are normalized EXACTLY like the original version of this
 * tool (no lowercasing, no decoding, no query stripping) so the number of
 * live pages is counted the same way as before. The richer normalization
 * above is only used to build the lookup key for matching against da.live.
 */
function normalizeLivePath(p) {
  if (!p) return "";
  let path = String(p).trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\.(html|md|json)$/i, "");
  path = path.replace(/\/index$/i, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  return path;
}

const matchKey = (livePath) => pathKey(normalizePath(livePath));

/**
 * da.live list entries come back as /{org}/{repo}/some/path. Make them
 * relative to the repo root so they line up with the live index paths.
 */
function toRelativePath(entryPath, org, repo) {
  const prefix = `/${org}/${repo}`.toLowerCase();
  let p = entryPath || "";
  const lower = p.toLowerCase();
  if (lower === prefix || lower.startsWith(`${prefix}/`)) {
    p = p.slice(prefix.length);
  }
  return p || "/";
}

// ---------- da.live token helpers ----------

/**
 * Accepts whatever the operator pastes and returns just the bearer token:
 *   - the raw JWT
 *   - "Bearer <jwt>"
 *   - the whole JSON blob from da.live's localStorage (we pull out tokenValue)
 */
function extractDaToken(raw) {
  let value = (raw || "").trim();
  if (!value) return "";

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && parsed.tokenValue) value = parsed.tokenValue;
    } catch (e) {
      /* not JSON — fall through */
    }
  }

  return value.replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "").trim();
}

/** Returns the token's expiry as a Date, or null if it can't be read. */
function getTokenExpiry(token) {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    const exp = Number(payload.created_at) + Number(payload.expires_in);
    return Number.isFinite(exp) ? new Date(exp) : null;
  } catch (e) {
    return null;
  }
}

function onDaTokenInput() {
  const field = $("cfg-da-token");
  const token = extractDaToken(field.value);
  if (token !== field.value.trim()) field.value = token; // collapsed JSON/Bearer paste

  const expiry = token ? getTokenExpiry(token) : null;
  if (expiry) {
    if (expiry.getTime() < Date.now()) {
      log(`⚠ da.live token expired at ${expiry.toLocaleString()} — grab a fresh one.`);
    } else {
      log(`da.live token accepted — valid until ${expiry.toLocaleString()}`);
    }
  }
}

// ---------- Step 1: fetch the live index ----------
// Returns Map<live path (as in the index), lookup key used to match da.live>

function readSheet(json) {
  if (json[":names"] && Array.isArray(json[":names"]) && json[":names"].length) {
    return json[json[":names"][0]];
  }
  return json;
}

// Adds entries to the map; returns how many entries had a usable path.
function addEntries(map, entries) {
  let seen = 0;
  entries.forEach((e) => {
    const p = normalizeLivePath(e.path);
    if (!p) return;
    seen += 1;
    if (!map.has(p)) map.set(p, matchKey(p));
  });
  return seen;
}

async function fetchLiveIndex(indexUrl) {
  log(`Fetching live index: ${indexUrl}`);

  const live = new Map();

  // Try one big request first — some EDS index endpoints return everything.
  const bigUrl = new URL(indexUrl);
  bigUrl.searchParams.set("offset", 0);
  bigUrl.searchParams.set("limit", 100000);

  const firstResp = await fetch(withCacheBuster(bigUrl.toString()), NO_CACHE);
  if (!firstResp.ok) {
    throw new Error(`Failed to fetch live index: ${firstResp.status} ${firstResp.statusText}`);
  }
  const sheet = readSheet(await firstResp.json());

  const entries = sheet.data || [];
  const total = typeof sheet.total === "number" ? sheet.total : entries.length;
  let rawSeen = addEntries(live, entries);

  if (entries.length >= total) {
    log(`Live index: ${live.size} unique paths from ${rawSeen} entries (index reports ${total}) — single request`);
    return live;
  }

  // Server capped the response — paginate the rest.
  log(`Server capped the single request at ${entries.length} of ${total} — paginating the rest`);
  const pageSize = sheet.limit || entries.length || 500;
  let offset = entries.length;

  while (offset < total) {
    const url = new URL(indexUrl);
    url.searchParams.set("offset", offset);
    url.searchParams.set("limit", pageSize);

    const resp = await fetch(withCacheBuster(url.toString()), NO_CACHE);
    if (!resp.ok) {
      throw new Error(`Failed to fetch live index at offset ${offset}: ${resp.status} ${resp.statusText}`);
    }
    const pageEntries = readSheet(await resp.json()).data || [];
    rawSeen += addEntries(live, pageEntries);

    log(`  fetched ${offset}–${offset + pageEntries.length} of ${total}`);
    if (pageEntries.length === 0) break;
    offset += pageEntries.length;
  }

  log(`Live index: ${live.size} unique paths from ${rawSeen} entries (index reports ${total})`);
  return live;
}

// ---------- Step 2: recursively list the da.live source tree ----------

/**
 * Lists ONE folder. Follows da.live's continuation token if the folder has
 * more entries than fit in a single response, so big folders aren't silently
 * truncated (which would make the missing pages look stale).
 */
async function listDaFolder(org, repo, path, daToken) {
  const url = `${DA_LIST_BASE}/${org}/${repo}${path}`;
  const all = [];
  let token = null;

  for (let page = 0; page < 1000; page += 1) {
    const headers = {};
    if (daToken) headers.Authorization = `Bearer ${daToken}`;
    if (token) headers["da-continuation-token"] = token;

    const resp = await fetch(url, { headers, cache: "no-store" });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `da.live rejected the request for "${path || "/"}" (${resp.status}). Check the da.live auth token.`,
      );
    }
    if (!resp.ok) {
      throw new Error(`Failed to list DA path "${path || "/"}": ${resp.status} ${resp.statusText}`);
    }

    const json = await resp.json();
    if (!Array.isArray(json)) {
      throw new Error(`Unexpected da.live list response for "${path || "/"}" (expected an array)`);
    }
    all.push(...json);

    const next = resp.headers.get("da-continuation-token");
    if (!next || next === token) break;
    token = next;
  }

  return all;
}

/**
 * Walks the whole da.live tree with a small worker pool.
 * Returns Set<lowercased normalized path> of every source file.
 * ANY listing error aborts the whole scan — a partial listing must never be
 * compared against the live index, or missing folders would look "stale".
 */
async function getAllDaPaths(org, repo, daToken) {
  const keys = new Set();
  const queue = [""]; // "" = repo root
  const visited = new Set([""]);
  let active = 0;
  let failure = null;
  let foldersListed = 0;

  const worker = async () => {
    while (!failure) {
      const folder = queue.shift();
      if (folder === undefined) {
        if (active === 0) return; // nothing queued, nobody working -> done
        await sleep(25);
        continue;
      }

      active += 1;
      try {
        const entries = await listDaFolder(org, repo, folder, daToken);
        foldersListed += 1;

        entries.forEach((entry) => {
          const rel = toRelativePath(entry.path, org, repo);
          if (!entry.ext) {
            // folder
            const folderKey = rel.replace(/\/+$/, "");
            if (folderKey && !visited.has(folderKey)) {
              visited.add(folderKey);
              queue.push(folderKey);
            }
          } else {
            const p = normalizePath(rel);
            if (p) keys.add(pathKey(p));
          }
        });
      } catch (err) {
        failure = err;
      } finally {
        active -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: LIST_CONCURRENCY }, worker));
  if (failure) throw failure;

  log(`da.live: listed ${foldersListed} folder(s)`);
  return keys;
}

// ---------- Step 3: diff — pages live but NOT found in da.live ----------

function diff(liveMap, daKeys) {
  const stale = [];
  liveMap.forEach((key, path) => {
    if (!daKeys.has(key)) stale.push(path);
  });
  return stale.sort();
}

const sample = (iterable, n = 3) => [...iterable].slice(0, n).join("  |  ") || "(none)";

// ---------- Step 4: unpublish selected paths ----------

async function unpublishPath(org, repo, branch, path, hlxToken) {
  const headers = {};
  if (hlxToken) headers["X-Auth-Token"] = hlxToken;
  const fetchOpts = {
    method: "DELETE",
    headers,
    credentials: hlxToken ? "omit" : "include",
  };

  // Matches da.live's own delete flow: remove both preview and live.
  const encoded = encodeURI(path);
  const previewUrl = `https://admin.hlx.page/preview/${org}/${repo}/${branch}${encoded}`;
  const liveUrl = `https://admin.hlx.page/live/${org}/${repo}/${branch}${encoded}`;

  const [previewResp, liveResp] = await Promise.all([
    fetch(previewUrl, fetchOpts),
    fetch(liveUrl, fetchOpts),
  ]);

  // 404 = already gone, which is the outcome we want.
  return {
    previewOk: previewResp.ok || previewResp.status === 404,
    liveOk: liveResp.ok || liveResp.status === 404,
  };
}

// ---------- UI wiring ----------

function setWarning(message) {
  const el = $("scan-warning");
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function renderResults(stalePages, liveOrigin) {
  const tbody = $("results-body");
  tbody.innerHTML = "";
  $("select-all").checked = false;

  // Only pages that are live but missing from da.live ever reach this function.
  stalePages.forEach((path) => {
    const tr = document.createElement("tr");
    tr.dataset.path = path;

    const liveUrl = `${liveOrigin}${encodeURI(path)}`;

    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "row-check";
    cb.addEventListener("change", updateDeleteButtonState);
    tdCheck.appendChild(cb);

    const tdPath = document.createElement("td");
    tdPath.textContent = path;

    const tdLive = document.createElement("td");
    const a = document.createElement("a");
    a.href = liveUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = liveUrl;
    tdLive.appendChild(a);

    const tdStatus = document.createElement("td");
    tdStatus.className = "row-status";
    tdStatus.textContent = "not yet unpublished";

    tr.append(tdCheck, tdPath, tdLive, tdStatus);
    tbody.appendChild(tr);
  });

  $("results-count").textContent = `${stalePages.length} stale path(s) found`;
  $("results-section").hidden = stalePages.length === 0;
  updateDeleteButtonState();
}

function updateDeleteButtonState() {
  const anyChecked = !!document.querySelector(".row-check:checked");
  $("delete-btn").disabled = !anyChecked;
}

async function handleScan() {
  const org = $("cfg-org").value.trim();
  const repo = $("cfg-repo").value.trim();
  const branch = $("cfg-branch").value.trim();
  const indexUrl = $("cfg-index").value.trim();

  $("scan-btn").disabled = true;
  $("scan-status").textContent = "Scanning…";
  $("log").textContent = "";
  $("results-section").hidden = true;
  $("results-body").innerHTML = "";
  setWarning("");
  state.stalePages = [];
  state.suspicious = false;

  log(`Scanning org=${org} repo=${repo} branch=${branch} against index=${indexUrl}`);

  try {
    const liveOrigin = new URL(indexUrl).origin;
    const daToken = extractDaToken($("cfg-da-token").value);
    const expiry = daToken ? getTokenExpiry(daToken) : null;
    if (expiry && expiry.getTime() < Date.now()) {
      throw new Error(`The da.live token expired at ${expiry.toLocaleString()}. Paste a fresh one.`);
    }

    log(`Listing da.live tree for ${org}/${repo}…`);
    const [liveMap, daKeys] = await Promise.all([
      fetchLiveIndex(indexUrl),
      getAllDaPaths(org, repo, daToken),
    ]);
    log(`da.live: ${daKeys.size} source documents found`);

    // Always log samples so any format mismatch is obvious.
    log(`Sample live paths: ${sample(liveMap.keys())}`);
    log(`Sample DA paths:   ${sample(daKeys)}`);

    // ---- Sanity checks: never show a list built on a broken comparison ----
    if (liveMap.size === 0) {
      throw new Error("Live index returned no paths — nothing to compare.");
    }
    if (daKeys.size === 0) {
      throw new Error(
        "da.live listing returned no documents (wrong org/repo or token?). Aborting so no live page is flagged by mistake.",
      );
    }

    const stalePages = diff(liveMap, daKeys);
    const matched = liveMap.size - stalePages.length;
    log(`Matched in both: ${matched} — live only (stale): ${stalePages.length}`);

    if (matched === 0) {
      throw new Error(
        "None of the live paths match any da.live document, so the path formats probably don't line up (see the sample paths above). Aborting so the whole site isn't listed as stale.",
      );
    }

    if (stalePages.length / liveMap.size > SUSPICIOUS_STALE_RATIO) {
      state.suspicious = true;
      const pct = Math.round((stalePages.length / liveMap.size) * 100);
      setWarning(
        `⚠ ${pct}% of live pages (${stalePages.length} of ${liveMap.size}) were flagged as stale. That is unusually high — compare the sample paths in the log and double-check Org/Repo and the Live index URL before unpublishing anything.`,
      );
      log(`⚠ ${pct}% of live pages flagged as stale — unusually high, verify before unpublishing.`);
    }

    log(`Found ${stalePages.length} stale path(s) — live but missing from da.live`);
    state.stalePages = stalePages;
    state.daKeys = daKeys;
    state.daScope = `${org}/${repo}`;

    renderResults(stalePages, liveOrigin);
    $("scan-status").textContent = `Done — ${stalePages.length} stale page(s) found`;
  } catch (err) {
    log(`ERROR: ${err.message}`);
    $("scan-status").textContent = "Failed — see log";
    console.error(err);
  } finally {
    $("scan-btn").disabled = false;
  }
}

// Unpublishes ONE path (preview + live) and returns what to show for it.
async function unpublishAndDescribe(org, repo, branch, path) {
  try {
    const hlxToken = $("cfg-hlx-token").value.trim();
    const { previewOk, liveOk } = await unpublishPath(org, repo, branch, path, hlxToken);

    if (previewOk && liveOk) {
      log(`✓ Unpublished ${path} (preview + live)`);
      return { text: "unpublished (preview + live)", cls: "ok" };
    }
    if (liveOk && !previewOk) {
      log(`⚠ ${path}: live removed but preview delete failed`);
      return { text: "live removed, preview failed", cls: "fail" };
    }
    if (previewOk && !liveOk) {
      log(`⚠ ${path}: preview removed but live delete failed — page is likely still visible`);
      return { text: "preview removed, live failed", cls: "fail" };
    }
    log(`✗ Failed to unpublish ${path} (both preview and live failed)`);
    return { text: "failed", cls: "fail" };
  } catch (err) {
    log(`✗ Error unpublishing ${path}: ${err.message}`);
    return { text: "failed", cls: "fail" };
  }
}

async function handleDelete() {
  const org = $("cfg-org").value.trim();
  const repo = $("cfg-repo").value.trim();
  const branch = $("cfg-branch").value.trim();

  const rows = [...document.querySelectorAll("#results-body tr")].filter((tr) =>
    tr.querySelector(".row-check").checked,
  );

  if (rows.length === 0) return;

  let message = `This will unpublish ${rows.length} path(s) from the live site. This cannot be undone. Continue?`;
  if (state.suspicious) {
    message = `WARNING: this scan flagged an unusually large share of the site as stale.\n\n${message}`;
  }
  if (!window.confirm(message)) return;

  $("delete-btn").disabled = true;

  for (const tr of rows) {
    const path = tr.dataset.path;
    const statusCell = tr.querySelector(".row-status");
    statusCell.textContent = "unpublishing…";
    statusCell.className = "row-status";

    const { text, cls } = await unpublishAndDescribe(org, repo, branch, path);
    statusCell.textContent = text;
    statusCell.className = `row-status ${cls}`;
  }
}

// ---------- da.live source delete (manual mode only) ----------

// Pages live in da.live as .html; paths that already carry an extension
// (e.g. /data.json) are used as typed. Only the single file is ever targeted —
// never a folder — so nothing else in the tree can be removed by accident.
function toDaSourcePath(path) {
  const last = path.split("/").pop();
  return /\.[a-z0-9]+$/i.test(last) ? path : `${path}.html`;
}

/**
 * Deletes the da.live source document for `path` if it exists.
 * Returns "deleted" or "missing"; throws on any other failure.
 */
async function deleteFromDa(org, repo, path, daToken) {
  const url = `${DA_SOURCE_BASE}/${org}/${repo}${encodeURI(toDaSourcePath(path))}`;
  const headers = { Authorization: `Bearer ${daToken}` };

  // Check first, so a "not found" is never reported as a delete.
  const check = await fetch(url, { headers, cache: "no-store" });
  if (check.status === 404) return "missing";
  if (!check.ok) {
    throw new Error(`lookup ${check.status} ${check.statusText}`.trim());
  }

  const del = await fetch(url, { method: "DELETE", headers, cache: "no-store" });
  if (del.status === 404) return "missing";
  if (!del.ok) {
    throw new Error(`delete ${del.status} ${del.statusText}`.trim());
  }
  return "deleted";
}

// ---------- Manual unpublish: paths typed/pasted by the operator ----------

/**
 * Turns "/a/b, https://site.com/c/d?x=1\n/e/f.html" into clean, de-duplicated
 * site paths. The homepage ("/") is rejected on purpose — unpublishing it by
 * accident (e.g. from a bare "/index") is never what someone wants here.
 */
function parseManualPaths(raw) {
  const seen = new Set();
  const paths = [];
  const invalid = [];

  (raw || "")
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((item) => {
      let p = item;
      if (/^https?:\/\//i.test(p)) {
        try {
          p = new URL(p).pathname;
        } catch (e) {
          invalid.push(item);
          return;
        }
      }
      p = p.split(/[?#]/)[0];
      try {
        p = decodeURI(p); // unpublishPath() re-encodes, so avoid double-encoding
      } catch (e) {
        /* keep as-is */
      }
      if (!p.startsWith("/")) p = `/${p}`;
      p = p.replace(/\.(html|md)$/i, "").replace(/\/index$/i, "/");
      if (p.length > 1) p = p.replace(/\/+$/, "");

      if (p === "/" || /\s/.test(p)) {
        invalid.push(item);
        return;
      }
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    });

  return { paths, invalid };
}

async function handleManualUnpublish() {
  const org = $("cfg-org").value.trim();
  const repo = $("cfg-repo").value.trim();
  const branch = $("cfg-branch").value.trim();
  const note = $("manual-note");

  const { paths, invalid } = parseManualPaths($("manual-paths").value);
  if (invalid.length) {
    log(`Manual unpublish: ignored ${invalid.length} invalid entr${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")}`);
  }
  if (paths.length === 0) {
    note.textContent = invalid.length
      ? "No valid paths — the homepage (/) and paths with spaces are not accepted."
      : "Enter at least one path.";
    return;
  }

  const deleteDa = $("manual-delete-da").checked;
  const daToken = extractDaToken($("cfg-da-token").value);
  if (deleteDa) {
    if (!daToken) {
      note.textContent = "Deleting from da.live needs the da.live auth token — paste it above first.";
      return;
    }
    const expiry = getTokenExpiry(daToken);
    if (expiry && expiry.getTime() < Date.now()) {
      note.textContent = `The da.live token expired at ${expiry.toLocaleString()} — paste a fresh one.`;
      return;
    }
  }

  // Extra safety: flag any path that still has a source document in da.live.
  let stillInDa = [];
  let existenceNote = "";
  if (state.daKeys && state.daScope === `${org}/${repo}`) {
    stillInDa = paths.filter((p) => state.daKeys.has(pathKey(normalizePath(p))));
  } else {
    existenceNote = "\n\n(No scan has been run for this org/repo, so these paths were not checked against da.live.)";
  }

  const shown = paths.slice(0, 15).join("\n");
  const more = paths.length > 15 ? `\n…and ${paths.length - 15} more` : "";
  const daLine = deleteDa
    ? `\n\nThe matching source documents will ALSO be deleted from da.live (${org}/${repo}) if they exist.`
    : "";
  let message = `This will unpublish ${paths.length} path(s) (preview + live) on ${org}/${repo}/${branch}:\n\n${shown}${more}${daLine}\n\nThis cannot be undone. Continue?${existenceNote}`;
  if (stillInDa.length) {
    const consequence = deleteDa
      ? "and will be DELETED from da.live"
      : "in da.live (they will stay there)";
    message = `WARNING: ${stillInDa.length} of these paths exist ${consequence}:\n${stillInDa.slice(0, 10).join("\n")}\n\n${message}`;
  }
  if (!window.confirm(message)) return;

  $("manual-btn").disabled = true;
  note.textContent = `Unpublishing ${paths.length} path(s)…`;

  const tbody = $("manual-body");
  tbody.innerHTML = "";
  $("manual-table").hidden = false;

  const rows = paths.map((path) => {
    const tr = document.createElement("tr");
    const tdPath = document.createElement("td");
    tdPath.textContent = path;
    const tdStatus = document.createElement("td");
    tdStatus.className = "row-status";
    tdStatus.textContent = "waiting…";
    tr.append(tdPath, tdStatus);
    tbody.appendChild(tr);
    return tdStatus;
  });

  let okCount = 0;
  for (let i = 0; i < paths.length; i += 1) {
    let prefix = "";

    if (deleteDa) {
      rows[i].textContent = "deleting from da.live…";
      try {
        const result = await deleteFromDa(org, repo, paths[i], daToken);
        prefix = result === "deleted" ? "deleted from da.live · " : "not in da.live · ";
        log(result === "deleted"
          ? `✓ Deleted ${paths[i]} from da.live`
          : `– ${paths[i]} does not exist in da.live (nothing to delete)`);
      } catch (err) {
        // If the source couldn't be removed, don't half-finish: leave the page
        // as it is so the operator can retry.
        rows[i].textContent = `da.live delete failed (${err.message}) — not unpublished`;
        rows[i].className = "row-status fail";
        log(`✗ da.live delete failed for ${paths[i]}: ${err.message} — skipped unpublish`);
        continue;
      }
    }

    rows[i].textContent = "unpublishing…";
    const { text, cls } = await unpublishAndDescribe(org, repo, branch, paths[i]);
    rows[i].textContent = prefix + text;
    rows[i].className = `row-status ${cls}`;
    if (cls === "ok") okCount += 1;
  }

  note.textContent = `Done — ${okCount} of ${paths.length} fully unpublished`;
  $("manual-btn").disabled = false;
}

function handleSelectAll(e) {
  document.querySelectorAll(".row-check").forEach((cb) => {
    cb.checked = e.target.checked;
  });
  updateDeleteButtonState();
}

$("scan-btn").addEventListener("click", handleScan);
$("delete-btn").addEventListener("click", handleDelete);
$("select-all").addEventListener("change", handleSelectAll);
$("manual-btn").addEventListener("click", handleManualUnpublish);

// Paste the raw JWT, "Bearer …", or the whole da.live localStorage JSON —
// the field collapses it down to just the tokenValue.
$("cfg-da-token").addEventListener("input", onDaTokenInput);

// Keep Live index URL in sync whenever Org/Repo/Branch change by hand.
$("cfg-org").addEventListener("input", updateDefaultIndexUrl);
$("cfg-repo").addEventListener("input", updateDefaultIndexUrl);
$("cfg-branch").addEventListener("input", updateDefaultIndexUrl);

initDaSdk();