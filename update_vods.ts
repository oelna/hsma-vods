// deno-lint-ignore-file no-explicit-any
/**
 * CommanderRoot Vault — daily updater
 * Deno script:
 *  - Warm-up GET to set cookies + XSRF-TOKEN
 *  - POST login with JSON + CSRF headers
 *  - GET VODs (paged) with CSRF
 *  - For NEW VODs only: GET file_info
 *  - Merge and write vods.json for static frontend
 *
 * ENV:
 *  VAULT_BASE_URL (e.g. https://vault.root-space.eu)  [required]
 *  VAULT_USERNAME                                    [required]
 *  VAULT_PASSWORD                                    [required]
 *  VAULT_TOTP                                        [optional]
 *  VAULT_TARGET_USER  (username or numeric ID)       [optional] defaults to logged-in username
 *  VODS_JSON_PATH   (default: "vods.json")
 *  PAGE_LIMIT       (default: "100")
 */
import { getSetCookies } from "https://deno.land/std@0.224.0/http/cookie.ts";

type CookieJar = Map<string, string>;
const env = (k: string, d?: string) => Deno.env.get(k) ?? d;

const BASE = env("VAULT_BASE_URL")!;
const USER = env("VAULT_USERNAME")!;
const PASS = env("VAULT_PASSWORD")!;
const TOTP = env("VAULT_TOTP");
const TARGET_USER_OVERRIDE = env("VAULT_TARGET_USER");
const JSON_PATH = env("VODS_JSON_PATH", "vods.json")!;
const PAGE_LIMIT = Number(env("PAGE_LIMIT", "100"));

if (!BASE || !USER || !PASS) {
  console.error("Missing required env: VAULT_BASE_URL, VAULT_USERNAME, VAULT_PASSWORD");
  Deno.exit(1);
}

function originOf(url: string) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

const ORIGIN = originOf(BASE);

const jar: CookieJar = new Map();
function setCookiesFrom(resp: Response) {
  const cookies = getSetCookies(resp.headers);
  for (const c of cookies) {
    // store by name only for same-origin use
    jar.set(c.name, c.value);
  }
}
function cookieHeader(): string | undefined {
  if (jar.size === 0) return undefined;
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}
function xsrfHeaderValue(): string | undefined {
  const v = jar.get("XSRF-TOKEN");
  if (!v) return undefined;
  try {
    // Cookie is URL-encoded; header must be decoded
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
function defaultHeaders(json = false): HeadersInit {
  const h: HeadersInit = {
    "Accept": "application/json, text/plain, */*",
    "Origin": ORIGIN,
    "Referer": `${ORIGIN}/`,
    "X-Requested-With": "XMLHttpRequest",
  };
  const xsrf = xsrfHeaderValue();
  if (xsrf) {
    // Many stacks accept either; safe to send both
    (h as any)["X-XSRF-TOKEN"] = xsrf;
    (h as any)["X-CSRF-Token"] = xsrf;
  }
  const ck = cookieHeader();
  if (ck) (h as any)["Cookie"] = ck;
  if (json) (h as any)["Content-Type"] = "application/json";
  return h;
}

async function fetchWithCookies(input: string, init?: RequestInit) {
  const resp = await fetch(input, init);
  setCookiesFrom(resp);
  return resp;
}

async function warmup() {
  const r = await fetchWithCookies(`${BASE}/`, { headers: defaultHeaders() });
  if (!r.ok) throw new Error(`Warm-up failed: ${r.status} ${r.statusText}`);
}

async function login() {
  const body: any = { action: "login", username: USER, password: PASS };
  if (TOTP) body.totp = TOTP;
  const r = await fetchWithCookies(`${BASE}/api/users.php`, {
    method: "POST",
    headers: defaultHeaders(true),
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Login HTTP error: ${r.status}`);
  if (j.error === "TOTP_REQUIRED" && !TOTP) {
    throw new Error("Login requires TOTP; set VAULT_TOTP and retry.");
  }
  if (j.error) throw new Error(`Login error: ${j.error}`);
  if (!j.data) throw new Error(`Login: missing data`);
  return j.data as { ID: string; username: string };
}

type Vod = Record<string, any>;

async function fetchVodPage(page: number, limit: number, targetUser: string) {
  const url = new URL(`${BASE}/api/twitch_vods.php`);
  //url.searchParams.set("page", String(page));
  //url.searchParams.set("limit", String(limit));
  url.searchParams.set("targetUser", targetUser);

  const r = await fetchWithCookies(url.toString(), { headers: defaultHeaders() });
  if (!r.ok) throw new Error(`VOD list failed: ${r.status}`);
  const list = await r.json();
  // console.log(list);
  return list;
}

function resolveVodIdForFileInfo(v: Vod): string | undefined {
  for (const k of ["id", "vod_id", "twitch_id", "vodId"]) {
    if (v[k]) return String(v[k]);
  }
  return undefined;
}

async function fetchFileInfo(vodId: string) {
  const url = new URL(`${BASE}/api/twitch_vods.php`);
  url.searchParams.set("get", "file_info");
  url.searchParams.set("ids", vodId);
  // url.searchParams.set("targetUser", targetUser);

  const r = await fetchWithCookies(url.toString(), { headers: defaultHeaders() });
  if (!r.ok) throw new Error(`file_info failed: ${r.status}`);
  const j = await r.json();
  // Common shapes: {data:[...]}, {files:[...]}
  const arr = j.data ?? j.files ?? [];
  return Array.isArray(arr) ? arr : [];
}

function mapFileInfoToStoredFile(f: any): StoredFile {
  return {
    fileId:       f.fileId ?? f.id ?? f.versionId ?? undefined,
    fileName:     f.fileName ?? f.name ?? undefined,
    fileSizeRaw:  typeof f.fileSizeRaw === "number" ? f.fileSizeRaw
                 : (typeof f.size === "number" ? f.size : undefined),
    fileSize:     f.fileSize ?? (typeof f.fileSizeRaw === "number" ? `${f.fileSizeRaw} B` : undefined),
    downloadUrl:  f.downloadUrl ?? f.url ?? undefined,
    contentType:  f.contentType ?? f.mimeType ?? undefined,
    metadata:     f.metadata ?? undefined, // {width,height,codec_name,codec_type,...}
  };
}

type StoredFile = {
  fileId?: string;
  fileName?: string;
  fileSizeRaw?: number;
  fileSize?: string;          // human-readable
  downloadUrl?: string;       // may expire
  contentType?: string;       // if available
  metadata?: Record<string, unknown>; // e.g., width/height/codec_name
};

type StoredVod = {
  id: string;
  title?: string;
  channel?: string;
  recorded_at?: string | number;
  created_at?: string | number;
  duration_seconds?: number;
  twitch_id?: string;
  files?: StoredFile[];
  filesFetchedAt?: string;
};

type Store = {
  meta: {
    generatedAt: string; // ISO
    baseUrl: string;
    targetUser: string;
    total: number;
  };
  vods: StoredVod[]; // newest first
};

async function loadStore(path: string): Promise<Store | null> {
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveStore(path: string, store: Store) {
  const text = JSON.stringify(store, null, 2);
  await Deno.writeTextFile(path, text);
}

function byIdSet(store: Store | null): Set<string> {
  const s = new Set<string>();
  if (!store) return s;
  for (const v of store.vods ?? []) {
    s.add(v.id);
  }
  return s;
}

function normalizeVod(v: any): StoredVod | null {
  if (!v.ID) return null;

  const out: StoredVod = {
    id: v.ID,
    title: v.title ?? v.name ?? undefined,
    channel: v.channel ?? v.twitch_channel ?? undefined,
    created_at: v.twitch_createdAt ?? undefined,
    duration_seconds: v.twitch_duration ?? v.duration ?? undefined,
    twitch_id: v.twitch_ID ?? undefined,
    // do NOT set files here when you haven't fetched them
    // files: undefined,
  };
  return out;
}

function mergeVodPreservingFiles(oldV: StoredVod | undefined, fresh: StoredVod): StoredVod {
  if (!oldV) return fresh;
  // Start with old (which has files), overlay fresh fields,
  // but keep old files if fresh.files is missing/undefined.
  const merged: StoredVod = { ...oldV, ...fresh };
  if (fresh.files === undefined) merged.files = oldV.files;
  return merged;
}

function needsFileInfo(v: StoredVod | undefined): boolean {
  if (!v) return true;                         // no record yet
  if (!v.files || v.files.length === 0) return true;  // missing or empty
  if (!v.filesFetchedAt) return true;          // no timestamp → refresh
  return false;
}

async function main() {
  console.log("Warm-up…");
  await warmup();

  console.log("Login…");
  const user = await login();
  const targetUser = user.username;
  console.log(`Logged in as ${user.username} (${user.ID}); targetUser=${targetUser}`);

  // Load existing store
  const existing = await loadStore(JSON_PATH);
  const seen = byIdSet(existing);

  // Fetch all pages
  console.log("Fetching VOD pages…");
  const all: StoredVod[] = [];
  let page = 1;
  while (true) {
    const list = await fetchVodPage(page, PAGE_LIMIT, targetUser);
    console.log(list.data);
    if (!Array.isArray(list.data) || list.data.length === 0) break;

    for (const raw of list.data) {
      console.log(raw);
      const sv = normalizeVod(raw);
      if (sv) all.push(sv);
    }
    if (list.data.length < PAGE_LIMIT) break; // last page
    page += 1;
  }
  console.log(`Total VODs listed: ${all.length}`);

  // Fill files for NEW entries only
  // Seed with existing (preserve files)
  const mergedById = new Map<string, StoredVod>();
  for (const v of existing?.vods ?? []) mergedById.set(v.id, v);

  let newCount = 0, refreshedCount = 0;

  for (const v of all /* normalized list items (no files set here) */) {
    const old = mergedById.get(v.id);
    const mustFetch = needsFileInfo(old) || !seen.has(v.id); // new or missing/stale files

    if (mustFetch) {
      if (!seen.has(v.id)) newCount++; else refreshedCount++;
      const rawFiles = await fetchFileInfo(v.id, targetUser);
      const files: StoredFile[] = rawFiles.map(mapFileInfoToStoredFile);
      const withFiles: StoredVod = { ...old, ...v, files, filesFetchedAt: new Date().toISOString() };
      mergedById.set(v.id, withFiles);
    } else {
      // update metadata but keep existing files
      const keepFiles: StoredVod = { ...old, ...v, files: old!.files, filesFetchedAt: old!.filesFetchedAt };
      mergedById.set(v.id, keepFiles);
    }
  }

  console.log(`New VODs: ${newCount}, refreshed missing/stale file info: ${refreshedCount}`);

  // Sort newest first (by recorded_at or created_at)
  const mergedList = Array.from(mergedById.values()).sort((a, b) => {
    const ta = Number(new Date((a.recorded_at ?? a.created_at) as any));
    const tb = Number(new Date((b.recorded_at ?? b.created_at) as any));
    return tb - ta;
  });

  const store: Store = {
    meta: {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE,
      targetUser,
      total: mergedList.length,
    },
    vods: mergedList,
  };

  await saveStore(JSON_PATH, store);
  console.log(`Wrote ${JSON_PATH} with ${store.vods.length} entries.`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e?.stack || e);
    Deno.exit(1);
  });
}
