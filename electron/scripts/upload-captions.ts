/**
 * Upload the episodes' subtitles (`E##_captions_sk.srt`, `E##_captions_en.srt`) to their videos
 * on the Svätonázor YouTube channel.
 *
 *   npm run captions -w @lusk/electron -- auth            # one-time sign-in with the channel account
 *   npm run captions -w @lusk/electron -- match           # match episode folders to channel videos, print the table
 *   npm run captions -w @lusk/electron -- confirm         # accept that table (plan/upload refuse until then)
 *   npm run captions -w @lusk/electron -- plan            # dry run: per video, which tracks would be added / replaced
 *   npm run captions -w @lusk/electron -- upload --only E01
 *   caffeinate -i npm run captions -w @lusk/electron -- upload --all --wait
 *
 * Nothing on the drive is written: the SRTs and `.lusk` projects are only read.
 *
 * Matching uses the episode number in the YouTube title, the title words, and the duration:
 * the episode's `.lusk` project records its source's length, and a video of the same length
 * (±1.5 s) is the one the subtitles were timed to. Shorts (< 3 min) are never candidates.
 * Corrections go in `<work>/overrides.json`: `{"E05": "<videoId>", "E31": null}`.
 *
 * Tracks: one per language. A video's own uploaded track in that language (trackKind
 * `standard`, `sk`/`sk-SK`… alike) is replaced in place with captions.update, after its
 * current file is downloaded to `<work>/backups/`; further standard tracks in the same
 * language are backed up and deleted. Auto-generated (`asr`) and `forced` tracks are left
 * alone. With nothing to replace, a new track is inserted, published (not draft).
 *
 * Final SRTs only: an episode is uploaded only when `<work>/final.json` lists it with the
 * sha256 of each SRT (`{"E01": {"sk": "<sha256>", "en": "<sha256>", "at": "…"}}`), written
 * by whoever signs the subtitles off. A file regenerated after that no longer matches and
 * is held back until its entry is updated. The dry run marks such episodes.
 *
 * Resumable: `<work>/state.json` records every finished track (video, caption id, file
 * hash), so a rerun skips it without spending quota. Each video's tracks are listed live
 * right before acting, so a run cut off between the upload and the state write replaces
 * the new track instead of adding a second one.
 *
 * Quota (10,000 units/day by default, resets at midnight Pacific): list 50, insert 400,
 * update 450, download 200, delete 50. The script counts what it spends per Pacific day
 * and never starts a track it can't finish today; on Google's quotaExceeded it stops
 * cleanly (exit 75). `--wait` sleeps until the reset instead and carries on.
 *
 * Secrets live outside the repo, in the work dir: `client_secret.json` (the OAuth
 * client, a "Desktop app" downloaded from Google Cloud) and `token.json` (mode 600).
 *
 * Options:
 *   --episodes <dir>   EPISODES folder (default: the Svätonázor shared drive)
 *   --work <dir>       secrets, state, log, backups (default: ~/LuskBatch/youtube)
 *   --only E01,E07     restrict plan/upload to these episodes     --from E10   start here
 *   --all              upload: every matched episode (required unless --only is given)
 *   --quota <n>        daily budget in units (default 10000)
 *   --wait             upload: when the quota runs out, wait for the reset and continue
 *   --reupload-changed upload: replace tracks already uploaded whose SRT has changed since
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

// ── Options ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const VALUE_OPTIONS = new Set(["--episodes", "--work", "--only", "--from", "--quota"]);
const COMMAND = argv.find((a, i) => !a.startsWith("--") && !VALUE_OPTIONS.has(argv[i - 1]));

const EPISODES = opt("episodes") ??
  path.join(homedir(), "Library/CloudStorage/GoogleDrive-xzsiros@gmail.com/Shared drives/Svätonázor/EPISODES");
const WORK = opt("work") ?? path.join(homedir(), "LuskBatch/youtube");
const ONLY = opt("only")?.split(",").map((s) => s.trim().toUpperCase());
const FROM = opt("from")?.toUpperCase();
const DAILY_QUOTA = Number(opt("quota") ?? 10_000);

const CLIENT_SECRET_FILE = path.join(WORK, "client_secret.json");
const TOKEN_FILE = path.join(WORK, "token.json");
const MATCHES_FILE = path.join(WORK, "matches.json");
const OVERRIDES_FILE = path.join(WORK, "overrides.json");
const STATE_FILE = path.join(WORK, "state.json");
const FINAL_FILE = path.join(WORK, "final.json");
const LOG_FILE = path.join(WORK, "upload.log");
const BACKUP_DIR = path.join(WORK, "backups");

const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

const LANGS = ["sk", "en"] as const;
type Lang = (typeof LANGS)[number];
/** Names of newly inserted tracks; replaced tracks keep theirs (captions.update can't rename). */
const TRACK_NAMES: Record<Lang, string> = { sk: "Slovenčina", en: "English" };

const COST = { read: 1, captionsList: 50, insert: 400, update: 450, download: 200, delete: 50 };
/** Shorter videos are shorts, never episodes. */
const MIN_EPISODE_S = 180;

// ── Small helpers ───────────────────────────────────────────────────────────

mkdirSync(WORK, { recursive: true });

function log(msg: string) {
  console.log(msg);
  appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as T) : fallback;
}

function writeJson(file: string, value: unknown, mode?: number) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
  if (mode) chmodSync(file, mode);
}

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const base64url = (buf: Buffer) => buf.toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

/** ISO 8601 duration (PT1H2M3S) → seconds. */
function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

/** Same language if the primary subtags match: `sk` = `sk-SK`, `en` = `en-GB`. */
const sameLanguage = (a: string, b: string) => a.split("-")[0].toLowerCase() === b.split("-")[0].toLowerCase();

// ── Quota bookkeeping (Google resets it at midnight Pacific) ────────────────

interface TrackRecord {
  videoId: string;
  captionId: string;
  action: "inserted" | "replaced";
  file: string;
  sha256: string;
  at: string;
  replaced?: { id: string; name: string; language: string; backup: string }[];
}
interface State {
  quota: { day: string; used: number };
  tracks: Record<string, TrackRecord>; // "E01:sk"
}

const state: State = readJson<State>(STATE_FILE, { quota: { day: "", used: 0 }, tracks: {} });
const saveState = () => writeJson(STATE_FILE, state);

const pacificDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

function msUntilQuotaReset(): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return 86_400_000 - elapsed;
}

function quotaUsed(): number {
  if (state.quota.day !== pacificDay()) state.quota = { day: pacificDay(), used: 0 };
  return state.quota.used;
}

class QuotaStop extends Error {}

/** Refuse to start work that today's remaining budget can't finish. */
function ensureBudget(units: number) {
  if (quotaUsed() + units > DAILY_QUOTA) {
    throw new QuotaStop(`today's budget is spent (${state.quota.used}/${DAILY_QUOTA} units, next step needs ${units})`);
  }
}

// ── OAuth ───────────────────────────────────────────────────────────────────

interface ClientSecret { client_id: string; client_secret: string }
interface Token { access_token: string; refresh_token: string; expires_at: number; channel?: { id: string; title: string } }

function clientSecret(): ClientSecret {
  if (!existsSync(CLIENT_SECRET_FILE)) {
    throw new Error(`No OAuth client at ${CLIENT_SECRET_FILE} — download the Desktop-app client JSON from Google Cloud and save it there.`);
  }
  const json = JSON.parse(readFileSync(CLIENT_SECRET_FILE, "utf-8"));
  const c = json.installed ?? json.web;
  if (!c?.client_id) throw new Error(`${CLIENT_SECRET_FILE} is not an OAuth client JSON (expected an "installed" key).`);
  return c;
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) {
    if (json.error === "invalid_grant") {
      throw new Error("The sign-in expired or was revoked — run `auth` again. (While the consent screen is in Testing, Google expires refresh tokens after 7 days.)");
    }
    throw new Error(`Token request failed: ${json.error} ${json.error_description ?? ""}`);
  }
  return json;
}

let token: Token | undefined;

async function accessToken(): Promise<string> {
  token ??= readJson<Token | undefined>(TOKEN_FILE, undefined);
  if (!token) throw new Error("Not signed in — run `auth` first.");
  if (token.expires_at > Date.now() + 60_000) return token.access_token;
  const { client_id, client_secret } = clientSecret();
  const json = await tokenRequest({ client_id, client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" });
  token = { ...token, access_token: json.access_token, expires_at: Date.now() + json.expires_in * 1000 };
  writeJson(TOKEN_FILE, token, 0o600);
  return token.access_token;
}

/** Installed-app flow: the browser signs in and Google redirects back to a loopback port. */
async function auth() {
  const { client_id, client_secret } = clientSecret();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const expectedState = base64url(randomBytes(16));

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", state: expectedState,
    code_challenge: challenge, code_challenge_method: "S256",
  }).toString();

  console.log("Opening the browser to sign in. Pick the Google account (and channel) that owns Svätonázor.");
  console.log(`If it doesn't open: ${url}\n`);
  execFile("open", [url.toString()]);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Sign-in timed out after 5 minutes.")), 5 * 60_000);
    server.on("request", (req, res) => {
      const q = new URL(req.url ?? "/", redirectUri).searchParams;
      if (!q.get("code") && !q.get("error")) { res.writeHead(404).end(); return; }
      const ok = q.get("state") === expectedState && q.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(ok ? "<h3>Signed in — you can close this tab.</h3>" : `<h3>Sign-in failed: ${q.get("error") ?? "state mismatch"}</h3>`);
      clearTimeout(timer);
      ok ? resolve(q.get("code")!) : reject(new Error(`Sign-in failed: ${q.get("error") ?? "state mismatch"}`));
    });
  }).finally(() => server.close());

  const json = await tokenRequest({
    code, client_id, client_secret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
  });
  if (!json.refresh_token) throw new Error("Google returned no refresh token — revoke the app's access in your Google account and run `auth` again.");
  token = { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + json.expires_in * 1000 };
  writeJson(TOKEN_FILE, token, 0o600);

  const channel = await myChannel();
  token.channel = { id: channel.id, title: channel.snippet.title };
  writeJson(TOKEN_FILE, token, 0o600);
  saveState();
  console.log(`Signed in as channel "${channel.snippet.title}" (${channel.id}). Token saved to ${TOKEN_FILE}.`);
}

// ── YouTube API ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(`${status} ${reason}: ${message}`);
  }
}

async function call(method: string, url: string, units: number, body?: { data: Buffer; contentType: string }): Promise<Response> {
  ensureBudget(units);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": body.contentType } : {}) },
      body: body && new Uint8Array(body.data),
    });
    // Google counts a request against the quota whether or not it succeeds.
    quotaUsed();
    state.quota.used += units;
    saveState();
    if (res.ok) return res;

    const text = await res.text();
    let reason = "", message = text;
    try {
      const err = JSON.parse(text).error;
      reason = err.errors?.[0]?.reason ?? err.status ?? "";
      message = err.message ?? text;
    } catch { /* not JSON */ }
    if (res.status === 401 && attempt === 0 && token) { token.expires_at = 0; continue; }
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      state.quota.used = Math.max(state.quota.used, DAILY_QUOTA);
      saveState();
      throw new QuotaStop(`YouTube says the daily quota is used up (${message})`);
    }
    if ((res.status >= 500 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") && attempt < 4) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new ApiError(res.status, reason, message);
  }
}

const getJson = async (url: string, units: number) => (await call("GET", url, units)).json() as Promise<any>;

async function myChannel() {
  const json = await getJson(`${API}/channels?part=snippet,contentDetails&mine=true`, COST.read);
  if (!json.items?.length) throw new Error("This account has no YouTube channel — sign in again and pick the Svätonázor channel.");
  return json.items[0];
}

interface Video { id: string; title: string; durationS: number; privacy: string; publishedAt: string }

async function listChannelVideos(): Promise<{ channel: { id: string; title: string }; videos: Video[] }> {
  const channel = await myChannel();
  const uploads = channel.contentDetails.relatedPlaylists.uploads;
  const ids: string[] = [];
  let pageToken = "";
  do {
    const page = await getJson(
      `${API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? `&pageToken=${pageToken}` : ""}`,
      COST.read,
    );
    ids.push(...page.items.map((i: any) => i.contentDetails.videoId));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);

  const videos: Video[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const page = await getJson(`${API}/videos?part=snippet,contentDetails,status&id=${ids.slice(i, i + 50).join(",")}`, COST.read);
    for (const v of page.items) {
      videos.push({
        id: v.id, title: v.snippet.title, durationS: parseIsoDuration(v.contentDetails.duration),
        privacy: v.status.privacyStatus, publishedAt: v.snippet.publishedAt,
      });
    }
  }
  return { channel: { id: channel.id, title: channel.snippet.title }, videos };
}

interface Caption {
  id: string;
  snippet: { videoId: string; language: string; name: string; trackKind: string; isDraft: boolean; lastUpdated: string; status: string };
}

async function listCaptions(videoId: string): Promise<Caption[]> {
  return (await getJson(`${API}/captions?part=snippet&videoId=${videoId}`, COST.captionsList)).items;
}

function multipart(metadata: unknown, media: Buffer) {
  const boundary = `lusk-${randomBytes(12).toString("hex")}`;
  const data = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    media,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { data, contentType: `multipart/related; boundary=${boundary}` };
}

async function insertCaption(videoId: string, lang: Lang, media: Buffer): Promise<Caption> {
  const meta = { snippet: { videoId, language: lang, name: TRACK_NAMES[lang], isDraft: false } };
  return (await call("POST", `${UPLOAD_API}/captions?part=snippet&uploadType=multipart`, COST.insert, multipart(meta, media))).json() as Promise<Caption>;
}

async function updateCaption(captionId: string, media: Buffer): Promise<Caption> {
  const meta = { id: captionId, snippet: { isDraft: false } };
  return (await call("PUT", `${UPLOAD_API}/captions?part=snippet&uploadType=multipart`, COST.update, multipart(meta, media))).json() as Promise<Caption>;
}

/** Saves the track's current file (original format) to the backup folder. */
async function backupCaption(code: string, caption: Caption): Promise<string> {
  const res = await call("GET", `${API}/captions/${caption.id}`, COST.download);
  const data = Buffer.from(await res.arrayBuffer());
  const head = data.subarray(0, 200).toString("utf-8").replace(/^﻿/, "");
  const ext = head.startsWith("WEBVTT") ? "vtt" : /-->/.test(head) ? "srt" : head.trimStart().startsWith("<") ? "xml" : "txt";
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `${code}_${caption.snippet.language}_${caption.id}_${stamp}.${ext}`);
  writeFileSync(file, data);
  writeJson(file.replace(/\.[^.]+$/, ".json"), caption);
  return file;
}

async function deleteCaption(captionId: string) {
  await call("DELETE", `${API}/captions?id=${captionId}`, COST.delete);
}

// ── Episodes on the drive (read-only) ───────────────────────────────────────

interface Episode {
  code: string;
  num: number;
  title: string;
  dir: string;
  srt: Partial<Record<Lang, string>>;
  srtEndMs?: number;
  /** Length of the source the subtitles were made from, from the episode's .lusk project. */
  sourceMs?: number;
}

function srtEndMs(file: string): number | undefined {
  const times = [...readFileSync(file, "utf-8").matchAll(/-->\s*(\d+):(\d+):(\d+)[,.](\d+)/g)];
  const last = times.at(-1);
  return last ? ((Number(last[1]) * 60 + Number(last[2])) * 60 + Number(last[3])) * 1000 + Number(last[4]) : undefined;
}

function sourceDurationMs(dir: string, code: string): number | undefined {
  const luskDir = path.join(dir, "PROJECT", "LUSK");
  if (!existsSync(luskDir)) return undefined;
  const files = readdirSync(luskDir).filter((f) => f.endsWith(".lusk"));
  const pick = files.find((f) => f === `${code}_auto.lusk`) ?? files.find((f) => f === `${code}.lusk`) ??
    files.sort((a, b) => statSync(path.join(luskDir, b)).mtimeMs - statSync(path.join(luskDir, a)).mtimeMs)[0];
  if (!pick) return undefined;
  try {
    const json = execFileSync("unzip", ["-p", path.join(luskDir, pick), "project.json"], { maxBuffer: 512 * 1024 * 1024 });
    return JSON.parse(json.toString("utf-8")).videoDurationMs;
  } catch {
    return undefined;
  }
}

function scanEpisodes(withDurations: boolean): Episode[] {
  const episodes: Episode[] = [];
  for (const name of readdirSync(EPISODES).sort()) {
    const m = /^(E(\d{2,3}))\s+(.+)$/.exec(name);
    if (!m) continue;
    const [, code, num, title] = m;
    const dir = path.join(EPISODES, name);
    const srt: Episode["srt"] = {};
    for (const lang of LANGS) {
      const file = path.join(dir, `${code}_captions_${lang}.srt`);
      if (existsSync(file)) srt[lang] = file;
    }
    if (!Object.keys(srt).length) continue;
    const ep: Episode = { code, num: Number(num), title: title.trim(), dir, srt };
    if (withDurations) {
      ep.srtEndMs = srtEndMs(srt.sk ?? srt.en!);
      ep.sourceMs = sourceDurationMs(dir, code);
    }
    episodes.push(ep);
  }
  return episodes;
}

function selected<T extends { code: string }>(items: T[]): T[] {
  return items.filter((e) => (!ONLY || ONLY.includes(e.code)) && (!FROM || e.code >= FROM));
}

// ── Matching ────────────────────────────────────────────────────────────────

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const IGNORED_TOKENS = new Set(["svatonazor", "podcast", "epizoda", "episode", "ep", "diel", "cast"]);

function tokens(s: string): string[] {
  return [...new Set(normalize(s).split(/[^a-z0-9]+/)
    .filter((t) => (t.length >= 2 || /^\d$/.test(t)) && !IGNORED_TOKENS.has(t) && !/^e\d+$/.test(t)))];
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Same word, give or take Slovak endings and a typo ("Kannancov" / "Kanaáncov"). */
function similarToken(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return false;
  let prefix = 0;
  while (prefix < min && a[prefix] === b[prefix]) prefix++;
  return prefix >= min - 2 || (min >= 6 && levenshtein(a, b) <= 2);
}

/** Share of the folder title's words found in the video title. */
function titleCoverage(folderTitle: string, videoTitle: string): number {
  const a = tokens(folderTitle), b = tokens(videoTitle);
  if (!a.length) return 0;
  return a.filter((t) => b.some((u) => similarToken(t, u))).length / a.length;
}

function episodeNumberInTitle(title: string): number | undefined {
  const m = /\bE\s?(\d{1,3})\b/i.exec(title) ??
    /\b(?:ep(?:izóda|izoda|isode)?|diel|časť|cast)\.?\s*#?\s*(\d{1,3})\b/i.exec(title) ??
    /#\s?(\d{1,3})\b/.exec(title);
  return m ? Number(m[1]) : undefined;
}

interface MatchEntry {
  code: string;
  folder: string;
  videoId: string | null;
  videoTitle?: string;
  privacy?: string;
  durationS?: number;
  sourceMs?: number;
  srtEndMs?: number;
  score?: number;
  via: string[];
  notes: string[];
}
interface Matches { createdAt: string; channel: { id: string; title: string }; confirmed: boolean; confirmedAt?: string; entries: MatchEntry[] }

function scorePair(ep: Episode, v: Video) {
  const via: string[] = [];
  let score = titleCoverage(ep.title, v.title);
  if (score > 0) via.push(`title ${Math.round(score * 100)}%`);
  const num = episodeNumberInTitle(v.title);
  if (num === ep.num) { score += 0.6; via.push("number"); } else if (num !== undefined) score -= 0.4;
  if (ep.sourceMs && Math.abs(v.durationS * 1000 - ep.sourceMs) <= 1500) { score += 0.6; via.push("duration"); }
  if (ep.srtEndMs && ep.srtEndMs > v.durationS * 1000 + 60_000) score -= 1; // subtitles a minute longer than the video
  return { score, via };
}

async function match() {
  const overrides = readJson<Record<string, string | null>>(OVERRIDES_FILE, {});
  console.log("Reading the channel's videos…");
  const { channel, videos } = await listChannelVideos();
  writeJson(path.join(WORK, "videos.json"), videos);
  console.log(`Channel "${channel.title}": ${videos.length} videos (${videos.filter((v) => v.durationS >= MIN_EPISODE_S).length} of 3 min or longer).`);
  console.log("Reading the episode folders (SRTs and .lusk durations)…");
  const episodes = scanEpisodes(true);

  const byId = new Map(videos.map((v) => [v.id, v]));
  const pool = videos.filter((v) => v.durationS >= MIN_EPISODE_S && !Object.values(overrides).includes(v.id));
  const assigned = new Map<string, { video: Video; score: number; via: string[] }>();

  // Greedy one-to-one assignment, best-scoring pairs first.
  const pairs = episodes.filter((e) => !(e.code in overrides))
    .flatMap((ep) => pool.map((v) => ({ ep, v, ...scorePair(ep, v) })))
    .filter((p) => p.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const usedVideos = new Set<string>();
  for (const p of pairs) {
    if (assigned.has(p.ep.code) || usedVideos.has(p.v.id)) continue;
    assigned.set(p.ep.code, { video: p.v, score: p.score, via: p.via });
    usedVideos.add(p.v.id);
  }

  const entries: MatchEntry[] = episodes.map((ep) => {
    const base = { code: ep.code, folder: ep.title, sourceMs: ep.sourceMs, srtEndMs: ep.srtEndMs, notes: [] as string[] };
    let video: Video | undefined, score: number | undefined, via: string[] = [];
    if (ep.code in overrides) {
      const id = overrides[ep.code];
      if (id === null) return { ...base, videoId: null, via: ["override: skip"] };
      video = byId.get(id);
      if (!video) return { ...base, videoId: null, via: [], notes: [`override ${id} is not a video on this channel`] };
      via = ["override"];
    } else {
      const a = assigned.get(ep.code);
      if (!a) return { ...base, videoId: null, via: [], notes: ["no match"] };
      ({ video, score, via } = a);
    }
    const entry: MatchEntry = {
      ...base, videoId: video.id, videoTitle: video.title, privacy: video.privacy, durationS: video.durationS,
      score: score && Math.round(score * 100) / 100, via,
    };
    if (score !== undefined && score < 1.2) entry.notes.push("WEAK — check");
    const rival = pairs.find((p) => p.ep.code === ep.code && p.v.id !== video!.id);
    if (score !== undefined && rival && score - rival.score < 0.3) entry.notes.push(`close runner-up: ${rival.v.id} "${rival.v.title}"`);
    if (ep.sourceMs && Math.abs(video.durationS * 1000 - ep.sourceMs) > 1500) {
      entry.notes.push(`video ${fmtDuration(video.durationS * 1000)} ≠ source ${fmtDuration(ep.sourceMs)} — timings may be off`);
    }
    if (ep.srtEndMs && ep.srtEndMs > video.durationS * 1000 + 1000) {
      entry.notes.push(`subtitles run ${Math.round(ep.srtEndMs / 1000 - video.durationS)} s past the video end`);
    }
    if (video.privacy !== "public") entry.notes.push(video.privacy);
    return entry;
  });

  const matches: Matches = { createdAt: new Date().toISOString(), channel, confirmed: false, entries };
  writeJson(MATCHES_FILE, matches);
  printMatches(matches, videos.filter((v) => v.durationS >= MIN_EPISODE_S && !entries.some((e) => e.videoId === v.id)));
}

function printMatches(matches: Matches, unmatchedVideos: Video[]) {
  const lines: string[] = [];
  lines.push(`Channel: ${matches.channel.title} (${matches.channel.id})`, "");
  lines.push(`${pad("Ep", 4)} ${pad("Folder", 36)} ${pad("Video", 11)} ${pad("YouTube title", 52)} ${pad("YT", 8)} ${pad("source", 8)} ${pad("srt end", 8)} ${pad("matched by", 28)} notes`);
  for (const e of matches.entries) {
    lines.push([
      pad(e.code, 4), pad(e.folder, 36), pad(e.videoId ?? "—", 11), pad(e.videoTitle ?? "", 52),
      pad(e.durationS ? fmtDuration(e.durationS * 1000) : "—", 8), pad(fmtDuration(e.sourceMs), 8), pad(fmtDuration(e.srtEndMs), 8),
      pad(e.via.join(", "), 28), e.notes.join("; "),
    ].join(" "));
  }
  const matched = matches.entries.filter((e) => e.videoId).length;
  lines.push("", `${matched} of ${matches.entries.length} episode folders matched.`);
  if (unmatchedVideos.length) {
    lines.push("", "Channel videos (≥ 3 min) not matched to any folder:");
    for (const v of unmatchedVideos) lines.push(`  ${v.id}  ${fmtDuration(v.durationS * 1000).padStart(8)}  ${v.privacy.padEnd(8)}  ${v.title}`);
  }
  const text = lines.join("\n");
  console.log(`\n${text}`);
  writeFileSync(path.join(WORK, "matches.txt"), text + "\n");
  console.log(`\nSaved to ${MATCHES_FILE} (and matches.txt). Fix mistakes in ${OVERRIDES_FILE} and rerun \`match\`; when it's right, run \`confirm\`.`);
}

function loadConfirmedMatches(): Matches {
  const m = readJson<Matches | undefined>(MATCHES_FILE, undefined);
  if (!m) throw new Error("No match table yet — run `match` first.");
  if (!m.confirmed) throw new Error("The match table isn't confirmed — check it (matches.txt) and run `confirm`.");
  const signedIn = readJson<Token | undefined>(TOKEN_FILE, undefined)?.channel;
  if (signedIn && signedIn.id !== m.channel.id) {
    throw new Error(`Signed in as channel ${signedIn.title}, but the match table is for ${m.channel.title}.`);
  }
  return m;
}

// ── Plan: what each video needs ─────────────────────────────────────────────

interface TrackPlan {
  code: string;
  lang: Lang;
  videoId: string;
  file: string;
  media: Buffer;
  sha256: string;
  action: "add" | "replace" | "done" | "changed";
  target?: Caption;
  extras: Caption[];
}

function recordFor(code: string, lang: Lang, videoId: string): TrackRecord | undefined {
  const rec = state.tracks[`${code}:${lang}`];
  return rec?.videoId === videoId ? rec : undefined;
}

/** Plans one video's tracks; lists its captions only if some track isn't done yet. */
async function planVideo(ep: Episode, videoId: string): Promise<{ tracks: TrackPlan[]; others: Caption[] }> {
  const files = LANGS.filter((l) => ep.srt[l]).map((lang) => {
    const media = readFileSync(ep.srt[lang]!);
    return { lang, file: ep.srt[lang]!, media, sha: sha256(media), rec: recordFor(ep.code, lang, videoId) };
  });
  const needsWork = files.some((f) => !f.rec || (f.rec.sha256 !== f.sha && flag("reupload-changed")));
  const captions = needsWork ? await listCaptions(videoId) : [];

  const tracks = files.map(({ lang, file, media, sha, rec }): TrackPlan => {
    const base = { code: ep.code, lang, videoId, file, media, sha256: sha, extras: [] as Caption[] };
    if (rec && (rec.sha256 === sha || !flag("reupload-changed"))) return { ...base, action: rec.sha256 === sha ? "done" : "changed" };
    const standard = captions
      .filter((c) => c.snippet.trackKind.toLowerCase() === "standard" && sameLanguage(c.snippet.language, lang))
      .sort((a, b) =>
        Number(b.snippet.language === lang) - Number(a.snippet.language === lang) ||
        Number(a.snippet.isDraft) - Number(b.snippet.isDraft) ||
        b.snippet.lastUpdated.localeCompare(a.snippet.lastUpdated));
    if (!standard.length) return { ...base, action: "add" };
    return { ...base, action: "replace", target: standard[0], extras: standard.slice(1) };
  });
  const handled = new Set(tracks.flatMap((t) => [t.target, ...t.extras]).filter(Boolean).map((c) => c!.id));
  return { tracks, others: captions.filter((c) => !handled.has(c.id)) };
}

const describe = (c: Caption) =>
  `"${c.snippet.name}" (${c.snippet.language}, ${c.snippet.trackKind}${c.snippet.isDraft ? ", draft" : ""}, updated ${c.snippet.lastUpdated.slice(0, 10)})`;

const cueCount = (media: Buffer) => (media.toString("utf-8").match(/-->/g) ?? []).length;

function trackCost(t: TrackPlan): number {
  if (t.action === "add") return COST.insert;
  if (t.action === "replace" || t.action === "changed") {
    return COST.download + COST.update + t.extras.length * (COST.download + COST.delete);
  }
  return 0;
}

function printVideoPlan(entry: MatchEntry, tracks: TrackPlan[], others: Caption[]) {
  console.log(`\n${entry.code}  ${entry.folder}  →  https://youtu.be/${entry.videoId}  "${entry.videoTitle}"`);
  for (const t of tracks) {
    const src = `${path.basename(t.file)} (${cueCount(t.media)} cues)`;
    if (t.action === "done") console.log(`    ${t.lang}  done      already uploaded (${recordFor(t.code, t.lang, t.videoId)!.captionId})`);
    else if (t.action === "changed") console.log(`    ${t.lang}  changed   uploaded before, SRT changed since — skipped (use --reupload-changed)`);
    else if (t.action === "add") console.log(`    ${t.lang}  ADD       "${TRACK_NAMES[t.lang]}" ← ${src}`);
    else {
      console.log(`    ${t.lang}  REPLACE   ${describe(t.target!)} ← ${src}  (keeps its name)`);
      for (const x of t.extras) console.log(`    ${t.lang}  DELETE    ${describe(x)} — second ${t.lang} track`);
    }
  }
  for (const c of others) console.log(`    ${c.snippet.language.padEnd(3)} keep      ${describe(c)}`);
}

/** Why an episode's SRTs aren't signed off for upload, or undefined when they are. */
function notFinal(ep: Episode): string | undefined {
  const final = readJson<Record<string, Partial<Record<Lang, string>>>>(FINAL_FILE, {})[ep.code];
  if (!final) return "not in final.json";
  const stale = LANGS.filter((l) => ep.srt[l] && final[l] !== sha256(readFileSync(ep.srt[l]!)));
  return stale.length ? `${stale.join(", ")} SRT differs from the one in final.json` : undefined;
}

async function plan() {
  const matches = loadConfirmedMatches();
  const episodes = new Map(scanEpisodes(false).map((e) => [e.code, e]));
  const entries = selected(matches.entries).filter((e) => e.videoId);
  console.log(`Dry run for ${entries.length} videos — nothing is uploaded. (Listing each video's tracks costs ${COST.captionsList} units.)`);

  const totals = { add: 0, replace: 0, delete: 0, done: 0, changed: 0, units: 0, videos: 0 };
  const saved: unknown[] = [];
  try {
    for (const entry of entries) {
      const ep = episodes.get(entry.code);
      if (!ep) { console.log(`\n${entry.code}: folder or SRTs missing now — skipped`); continue; }
      const { tracks, others } = await planVideo(ep, entry.videoId!);
      printVideoPlan(entry, tracks, others);
      const held = notFinal(ep);
      if (held) console.log(`    HELD BACK — ${held}`);
      for (const t of tracks) {
        if (t.action === "add") totals.add++;
        else if (t.action === "replace") { totals.replace++; totals.delete += t.extras.length; }
        else totals[t.action]++;
        totals.units += trackCost(t);
      }
      if (tracks.some((t) => t.action === "add" || t.action === "replace")) totals.videos++;
      saved.push({
        code: entry.code, videoId: entry.videoId,
        tracks: tracks.map((t) => ({ lang: t.lang, action: t.action, target: t.target, extras: t.extras })), others,
      });
    }
  } catch (err) {
    if (!(err instanceof QuotaStop)) throw err;
    console.log(`\nStopped: ${err.message}. The plan above is partial.`);
  }
  writeJson(path.join(WORK, "plan.json"), { createdAt: new Date().toISOString(), videos: saved });

  const units = totals.units + totals.videos * COST.captionsList;
  console.log(`\nSummary: ${totals.add} to add, ${totals.replace} to replace, ${totals.delete} extra tracks to delete, ` +
    `${totals.done} already done${totals.changed ? `, ${totals.changed} changed since upload (skipped)` : ""}.`);
  console.log(`Upload cost ≈ ${units.toLocaleString("en")} units ≈ ${Math.ceil(units / DAILY_QUOTA)} day(s) at ${DAILY_QUOTA.toLocaleString("en")}/day. ` +
    `Used today: ${quotaUsed().toLocaleString("en")}.`);
}

// ── Upload ──────────────────────────────────────────────────────────────────

async function uploadTrack(t: TrackPlan) {
  const key = `${t.code}:${t.lang}`;
  ensureBudget(trackCost(t));
  if (t.action === "add") {
    const created = await insertCaption(t.videoId, t.lang, t.media);
    state.tracks[key] = {
      videoId: t.videoId, captionId: created.id, action: "inserted", file: path.basename(t.file), sha256: t.sha256, at: new Date().toISOString(),
    };
    saveState();
    log(`${key} added ${created.id} to ${t.videoId}`);
    return;
  }
  // Back up everything first: nothing is replaced or deleted without its file on disk.
  const replaced: NonNullable<TrackRecord["replaced"]> = [];
  for (const c of [t.target!, ...t.extras]) {
    const backup = await backupCaption(t.code, c);
    replaced.push({ id: c.id, name: c.snippet.name, language: c.snippet.language, backup });
    log(`${key} backed up ${c.id} ${describe(c)} → ${backup}`);
  }
  await updateCaption(t.target!.id, t.media);
  log(`${key} replaced ${t.target!.id} on ${t.videoId}`);
  for (const x of t.extras) {
    await deleteCaption(x.id);
    log(`${key} deleted second ${t.lang} track ${x.id} on ${t.videoId}`);
  }
  state.tracks[key] = {
    videoId: t.videoId, captionId: t.target!.id, action: "replaced", file: path.basename(t.file), sha256: t.sha256,
    at: new Date().toISOString(), replaced,
  };
  saveState();
}

async function upload() {
  if (!ONLY && !flag("all")) throw new Error("Say which episodes: `--only E01` for a test, `--all` for every matched episode.");
  const matches = loadConfirmedMatches();
  const episodes = new Map(scanEpisodes(false).map((e) => [e.code, e]));
  const entries = selected(matches.entries).filter((e) => e.videoId);
  if (ONLY) {
    const missing = ONLY.filter((c) => !entries.some((e) => e.code === c));
    if (missing.length) throw new Error(`Not in the confirmed match table (or unmatched): ${missing.join(", ")}`);
  }
  log(`Upload run: ${entries.length} videos${ONLY ? ` (${ONLY.join(", ")})` : ""}; quota used today ${quotaUsed()}/${DAILY_QUOTA}`);

  for (let i = 0; i < entries.length; ) {
    const entry = entries[i];
    const ep = episodes.get(entry.code);
    try {
      if (!ep) { log(`${entry.code}: folder or SRTs missing — skipped`); i++; continue; }
      const held = notFinal(ep);
      if (held) { log(`${entry.code}: held back — ${held}`); i++; continue; }
      const { tracks } = await planVideo(ep, entry.videoId!);
      for (const t of tracks) {
        if (t.action === "done") continue;
        if (t.action === "changed") { log(`${t.code}:${t.lang} SRT changed since its upload — skipped (use --reupload-changed)`); continue; }
        await uploadTrack(t);
      }
      i++;
    } catch (err) {
      if (!(err instanceof QuotaStop)) {
        log(`${entry.code}: FAILED — ${(err as Error).message}`);
        throw err;
      }
      const resetIn = msUntilQuotaReset();
      const resumeAt = new Date(Date.now() + resetIn + 10 * 60_000);
      log(`Stopped at ${entry.code}: ${err.message}. Quota resets at midnight Pacific (${resumeAt.toLocaleString("sk-SK")} local incl. 10 min margin).`);
      if (!flag("wait")) {
        console.log("Run the same command again after that — finished tracks are skipped.");
        process.exit(75);
      }
      log(`Waiting until ${resumeAt.toLocaleString("sk-SK")}…`);
      await sleep(resetIn + 10 * 60_000);
    }
  }
  const done = Object.keys(state.tracks).length;
  log(`Upload run finished. Tracks recorded as uploaded: ${done}. Quota used today ${quotaUsed()}/${DAILY_QUOTA}.`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  switch (COMMAND) {
    case "auth": return auth();
    case "match": return match();
    case "confirm": {
      const m = readJson<Matches | undefined>(MATCHES_FILE, undefined);
      if (!m) throw new Error("No match table yet — run `match` first.");
      writeJson(MATCHES_FILE, { ...m, confirmed: true, confirmedAt: new Date().toISOString() });
      console.log(`Confirmed: ${m.entries.filter((e) => e.videoId).length} matched episodes (${m.entries.filter((e) => !e.videoId).map((e) => e.code).join(", ") || "none"} skipped).`);
      return;
    }
    case "plan": return plan();
    case "upload": return upload();
    default:
      console.log("Usage: upload-captions.ts auth | match | confirm | plan [--only E01] | upload --only E01 | upload --all [--wait]");
      process.exit(COMMAND ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof QuotaStop ? "Stopped" : "Error"}: ${err.message}`);
  process.exit(err instanceof QuotaStop ? 75 : 1);
});
