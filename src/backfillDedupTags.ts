// One-time backfill: tags existing Google Photos album items (uploaded before
// dedup tagging existed) with their originating Discord message ID, so future
// /upload range|until runs don't re-upload them.
//
// Photos are matched by decoded content hash (ffmpeg's md5 muxer): it hashes
// the actual decoded pixel raster, unaffected by our EXIF injection
// (metadata-only). Videos CANNOT be matched this way — Google Photos
// transcodes every video on upload (re-encodes video, resamples audio,
// normalizes rotation), so the decoded stream never matches the Discord
// original even though the content is the same. Videos are instead matched
// by filename (Google Photos preserves the original filename we uploaded
// with) plus a duration sanity check when a filename is ambiguous.
//
// Matching happens per attachment (not per message), since a message with
// multiple attachments becomes multiple independent Google Photos items.
//
// Usage:
//   tsx src/backfillDedupTags.ts                          # dry run, prints the match plan
//   tsx src/backfillDedupTags.ts --report out.html         # dry run + writes a local review page
//   tsx src/backfillDedupTags.ts --apply                   # writes the tags

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	type Attachment,
	Client,
	GatewayIntentBits,
	type Message,
	type TextBasedChannel,
} from "discord.js";
import "dotenv/config";
import { oauth2Client } from "./googleClient.js";
import {
	getMessageAttachments,
	getValidatedAlbum,
	hasUploadableAttachments,
	MESSAGE_ID_TAG_PATTERN,
	OPERATING_CHANNEL_ID,
	OPERATING_GUILD_ID,
	requestWithRetry,
	type SearchMediaItemsResponse,
} from "./utils.js";

const execFileAsync = promisify(execFile);
const APPLY = process.argv.includes("--apply");
const reportFlagIndex = process.argv.indexOf("--report");
const REPORT_PATH =
	reportFlagIndex !== -1 ? process.argv[reportFlagIndex + 1] : undefined;

type MediaItem = NonNullable<SearchMediaItemsResponse["mediaItems"]>[number];
type MatchMethod = "content" | "filename";

interface DiscordAttachmentRef {
	messageId: string;
	url: string;
	mimeType?: string | undefined;
	name: string;
}

interface MatchedItemRef {
	itemId: string;
	itemThumbUrl: string;
	itemMimeType?: string | undefined;
	itemProductUrl?: string | undefined;
	itemDurationMs?: number | undefined;
	discordUrl: string;
	discordMimeType?: string | undefined;
	matchMethod: MatchMethod;
	ambiguous: boolean;
	collisionMessageIds?: string[] | undefined;
}

interface MissingAttachment {
	url: string;
	mimeType?: string | undefined;
	name: string;
}

interface MessageGroupData {
	messageId: string;
	messageLink: string;
	author: string;
	timestamp: number;
	totalAttachments: number;
	items: MatchedItemRef[];
	missingAttachments: MissingAttachment[];
}

interface UnmatchedEntry {
	itemId: string;
	itemThumbUrl: string;
	itemMimeType?: string | undefined;
	itemProductUrl?: string | undefined;
	filename?: string | undefined;
	description?: string | undefined;
}

function isVideoAttachment(attachment: {
	contentType?: string | null;
	name: string;
}): boolean {
	if (attachment.contentType?.startsWith("video/")) return true;
	return /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(attachment.name);
}

function unmatchedEntryFrom(
	item: MediaItem,
	itemThumbUrl: string,
): UnmatchedEntry {
	return {
		itemId: item.id,
		itemThumbUrl,
		itemMimeType: item.mimeType,
		itemProductUrl: item.productUrl,
		filename: item.filename,
		description: item.description,
	};
}

async function downloadToTemp(url: string, name: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Download failed (${response.status}): ${url}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	const tempPath = path.join(
		os.tmpdir(),
		`backfill_${Date.now()}_${Math.random().toString(36).slice(2)}_${name}`,
	);
	await fs.writeFile(tempPath, buffer);
	return tempPath;
}

// Hashes the decoded pixel raster rather than the file's raw bytes, so EXIF
// metadata differences between the Discord original and the Google Photos
// copy don't break the match. Only meaningful for photos — see file header.
async function contentHash(filePath: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("ffmpeg", [
			"-i",
			filePath,
			"-f",
			"md5",
			"-",
		]);
		return stdout.match(/MD5=([0-9a-f]+)/i)?.[1]?.toLowerCase() ?? null;
	} catch (error) {
		console.error(`Failed to hash ${filePath}:`, error);
		return null;
	}
}

async function fetchAllChannelMessages(
	channel: TextBasedChannel,
): Promise<Message[]> {
	const messages: Message[] = [];
	let before: string | undefined;

	while (true) {
		const batch = await channel.messages.fetch(
			before ? { limit: 100, before } : { limit: 100 },
		);
		if (batch.size === 0) break;
		messages.push(...batch.values());
		before = batch.last()?.id;
		if (batch.size < 100) break;
	}

	return messages;
}

// Builds two independent indices from the channel's attachments:
// - hashToRefs: photo content hash -> attachments (downloads + decodes each)
// - videoByFilename: video filename -> attachments (no download; Google
//   Photos preserves the original filename, so this needs no network call)
async function buildDiscordIndices(messages: Message[]): Promise<{
	hashToRefs: Map<string, DiscordAttachmentRef[]>;
	videoByFilename: Map<string, DiscordAttachmentRef[]>;
}> {
	const hashToRefs = new Map<string, DiscordAttachmentRef[]>();
	const videoByFilename = new Map<string, DiscordAttachmentRef[]>();
	const candidates = messages.filter(hasUploadableAttachments);
	let processed = 0;

	for (const message of candidates) {
		for (const attachment of getMessageAttachments(message)) {
			const ref: DiscordAttachmentRef = {
				messageId: message.id,
				url: attachment.url,
				mimeType: attachment.contentType ?? undefined,
				name: attachment.name,
			};

			if (isVideoAttachment(attachment)) {
				const refs = videoByFilename.get(attachment.name) ?? [];
				refs.push(ref);
				videoByFilename.set(attachment.name, refs);
				continue;
			}

			let tempPath: string | undefined;
			try {
				tempPath = await downloadToTemp(attachment.url, attachment.name);
				const hash = await contentHash(tempPath);
				if (!hash) continue;

				const refs = hashToRefs.get(hash) ?? [];
				refs.push(ref);
				hashToRefs.set(hash, refs);
			} catch (error) {
				console.error(
					`Failed to process attachment on message ${message.id}:`,
					error,
				);
			} finally {
				if (tempPath) await fs.unlink(tempPath).catch(() => {});
			}
		}

		processed++;
		if (processed % 25 === 0) {
			console.log(
				`  indexed attachments from ${processed}/${candidates.length} messages...`,
			);
		}
	}

	return { hashToRefs, videoByFilename };
}

async function fetchAllAlbumItems(albumId: string): Promise<MediaItem[]> {
	const items: MediaItem[] = [];
	let nextPageToken: string | undefined;

	do {
		// eslint-disable-next-line no-await-in-loop
		const response = await requestWithRetry(
			() =>
				oauth2Client.request<SearchMediaItemsResponse>({
					url: "https://photoslibrary.googleapis.com/v1/mediaItems:search",
					method: "POST",
					data: { albumId, pageSize: "100", pageToken: nextPageToken },
				}),
			"Search Media Items (backfill)",
		);

		items.push(...(response.data.mediaItems ?? []));
		nextPageToken = response.data.nextPageToken;
	} while (nextPageToken);

	return items;
}

// Among refs sharing a hash or filename (duplicate posts of the same file),
// tag against whichever message was posted first.
function pickPrimaryRef(
	refs: DiscordAttachmentRef[],
	messageById: Map<string, Message>,
): DiscordAttachmentRef {
	return refs.reduce((earliest, ref) => {
		const a = messageById.get(earliest.messageId)?.createdTimestamp ?? Infinity;
		const b = messageById.get(ref.messageId)?.createdTimestamp ?? Infinity;
		return b < a ? ref : earliest;
	});
}

function escapeForInlineScript(json: string): string {
	return json.replace(/<\/script/gi, "<\\/script");
}

function buildReportHtml(report: {
	generatedAt: string;
	albumTitle: string;
	stats: {
		totalMessages: number;
		messagesWithAttachments: number;
		totalAlbumItems: number;
		matched: number;
		alreadyTagged: number;
		unmatched: number;
		ambiguous: number;
		messagesWithMissingAttachments: number;
	};
	messageGroups: MessageGroupData[];
	unmatched: UnmatchedEntry[];
}): string {
	const dataJson = escapeForInlineScript(JSON.stringify(report));

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dedup backfill review — ${report.albumTitle}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f5f2;
    --surface: #ffffff;
    --border: #e2ddd3;
    --ink: #24211c;
    --ink-dim: #6b6558;
    --accent: #b5622c;
    --ok: #3f7a4f;
    --warn: #b5862c;
    --danger: #a4402f;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17150f;
      --surface: #211e17;
      --border: #37332a;
      --ink: #efe9dc;
      --ink-dim: #a8a08e;
      --accent: #e08a4f;
      --ok: #6db97f;
      --warn: #dcb15a;
      --danger: #e0715a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--ink);
  }
  header {
    padding: 28px clamp(16px, 4vw, 40px) 20px;
    border-bottom: 1px solid var(--border);
  }
  h1 { font-size: 1.4rem; margin: 0 0 4px; text-wrap: balance; }
  .meta { color: var(--ink-dim); font-size: 0.85rem; }
  .legend { margin-top: 14px; font-size: 0.8rem; color: var(--ink-dim); max-width: 68ch; line-height: 1.5; }
  .legend b { color: var(--ink); }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 16px;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 14px;
    min-width: 92px;
  }
  .stat .n { font-size: 1.3rem; font-weight: 600; font-variant-numeric: tabular-nums; display: block; }
  .stat .l { font-size: 0.72rem; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 16px clamp(16px, 4vw, 40px);
    position: sticky;
    top: 0;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    z-index: 5;
  }
  #search {
    flex: 1;
    min-width: 180px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--ink);
    font-size: 0.9rem;
  }
  .filter-btn {
    padding: 7px 13px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--ink-dim);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .filter-btn.active { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  main { padding: 20px clamp(16px, 4vw, 40px) 60px; }
  h2 { font-size: 1rem; margin: 24px 0 4px; color: var(--ink-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .section-note { font-size: 0.8rem; color: var(--ink-dim); margin: 0 0 12px; max-width: 68ch; }
  .groups { display: flex; flex-direction: column; gap: 10px; }
  .group-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .group-card.has-issue { border-color: var(--warn); }
  .group-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 0.85rem; }
  .group-author { font-weight: 600; }
  .group-time { color: var(--ink-dim); font-size: 0.78rem; }
  .group-count { color: var(--ink-dim); font-size: 0.78rem; }
  .group-links { margin-left: auto; display: flex; gap: 10px; }
  .group-links a { font-size: 0.78rem; color: var(--accent); text-decoration: none; }
  .group-links a:hover { text-decoration: underline; }
  .pairs { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
  .pair-wrap { display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .pair {
    display: flex;
    gap: 4px;
    padding: 6px;
    border-radius: 10px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .pair.ambiguous { border-color: var(--warn); }
  .thumb-box {
    width: 84px;
    height: 84px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--surface);
    position: relative;
    flex: 0 0 auto;
  }
  .thumb-box.missing { border: 2px dashed var(--danger); }
  .thumb-box img, .thumb-box video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-label {
    position: absolute;
    bottom: 3px;
    left: 3px;
    font-size: 0.58rem;
    background: rgba(0,0,0,0.55);
    color: #fff;
    padding: 1px 5px;
    border-radius: 999px;
  }
  .thumb-label.danger { background: var(--danger); }
  .arrow { align-self: center; color: var(--ink-dim); font-size: 0.85rem; padding: 0 2px; }
  .pair-meta { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; }
  .badge {
    font-size: 0.64rem;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--warn);
    color: var(--bg);
    white-space: nowrap;
  }
  .badge.danger { background: var(--danger); }
  .badge.neutral { background: var(--border); color: var(--ink-dim); }
  .pair-link { font-size: 0.66rem; color: var(--accent); text-decoration: none; }
  .pair-link:hover { text-decoration: underline; }
  .missing-note { font-size: 0.68rem; color: var(--danger); max-width: 84px; text-align: center; }
  .unmatched-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .unmatched-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .unmatched-card .thumb-box { flex: 0 0 72px; width: 72px; height: 72px; }
  .card-info { display: flex; flex-direction: column; gap: 2px; font-size: 0.8rem; }
  .card-info a { font-size: 0.78rem; color: var(--accent); text-decoration: none; }
  .card-info a:hover { text-decoration: underline; }
  .empty { color: var(--ink-dim); padding: 20px 0; font-size: 0.9rem; }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<header>
  <h1>Dedup backfill review</h1>
  <div class="meta" id="meta"></div>
  <div class="legend">
    <b>Photos</b> are matched by exact decoded content (pixel-perfect, no false positives). <b>Videos</b> are matched by filename + duration instead, since Google Photos re-encodes every video on upload (different codec settings, resampled audio, normalized rotation) so its copy never byte-matches the Discord original. <b>Ambiguous</b> means the same file was posted in more than one message; all of them are tagged, so any of the duplicate posts will now be recognized as already-uploaded. <b>Missing from Photos</b> means this specific Discord attachment has no matching Photos item anywhere in the album — it may have failed to upload originally.
  </div>
  <div class="stats" id="stats"></div>
</header>
<div class="controls">
  <input id="search" type="text" placeholder="Search by filename, author, or message ID..." />
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="ambiguous">Ambiguous only</button>
  <button class="filter-btn" data-filter="missing">Missing attachments only</button>
  <button class="filter-btn" data-filter="unmatched">Unmatched Photos items only</button>
</div>
<main>
  <section id="groups-section">
    <h2 id="groups-heading">Messages</h2>
    <div class="groups" id="groups-list"></div>
    <div class="empty" id="groups-empty" style="display:none;">No messages for this filter/search.</div>
  </section>
  <section id="unmatched-section">
    <h2>Photos items with no Discord match</h2>
    <p class="section-note">No Discord attachment produced a matching hash or filename for these. Could mean the source message was deleted, or (for older items) something the matcher genuinely can't resolve — check "Open in Photos" to judge for yourself.</p>
    <div class="unmatched-grid" id="unmatched-grid"></div>
    <div class="empty" id="unmatched-empty" style="display:none;">No unmatched items for this search.</div>
  </section>
</main>
<script type="application/json" id="report-data">${dataJson}</script>
<script>
(function () {
  var report = JSON.parse(document.getElementById("report-data").textContent);

  document.getElementById("meta").textContent =
    "Album \\"" + report.albumTitle + "\\" — generated " + new Date(report.generatedAt).toLocaleString();

  var statDefs = [
    ["Album items", report.stats.totalAlbumItems],
    ["Matched", report.stats.matched],
    ["Ambiguous", report.stats.ambiguous],
    ["Messages missing attachments", report.stats.messagesWithMissingAttachments],
    ["Unmatched Photos items", report.stats.unmatched],
    ["Already tagged", report.stats.alreadyTagged],
  ];
  var statsEl = document.getElementById("stats");
  statDefs.forEach(function (pair) {
    var el = document.createElement("div");
    el.className = "stat";
    var n = document.createElement("span");
    n.className = "n";
    n.textContent = pair[1];
    var l = document.createElement("span");
    l.className = "l";
    l.textContent = pair[0];
    el.appendChild(n);
    el.appendChild(l);
    statsEl.appendChild(el);
  });

  function fmtTime(ms) {
    return new Date(ms).toLocaleString();
  }

  function fmtDuration(ms) {
    var totalSec = Math.round(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function mediaEl(url, mime) {
    if (mime && mime.indexOf("video/") === 0) {
      var v = document.createElement("video");
      v.src = url;
      v.controls = true;
      v.muted = true;
      v.preload = "metadata";
      return v;
    }
    var img = document.createElement("img");
    img.src = url;
    img.loading = "lazy";
    img.alt = "";
    return img;
  }

  function thumbBox(url, mime, label, opts) {
    opts = opts || {};
    var box = document.createElement("div");
    box.className = "thumb-box" + (opts.missing ? " missing" : "");
    box.appendChild(mediaEl(url, mime));
    var l = document.createElement("span");
    l.className = "thumb-label" + (opts.missing ? " danger" : "");
    l.textContent = label;
    box.appendChild(l);
    return box;
  }

  function pairEl(item) {
    var wrap = document.createElement("div");
    wrap.className = "pair-wrap";

    var pair = document.createElement("div");
    pair.className = "pair" + (item.ambiguous ? " ambiguous" : "");
    pair.appendChild(thumbBox(item.discordUrl, item.discordMimeType, "Discord"));
    var arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "\\u2192";
    pair.appendChild(arrow);
    pair.appendChild(thumbBox(item.itemThumbUrl, item.itemMimeType, "Photos"));
    wrap.appendChild(pair);

    var meta = document.createElement("div");
    meta.className = "pair-meta";
    var methodBadge = document.createElement("span");
    methodBadge.className = "badge neutral";
    methodBadge.textContent = item.matchMethod === "filename" ? "filename match" : "exact match";
    meta.appendChild(methodBadge);
    if (item.itemDurationMs) {
      var durBadge = document.createElement("span");
      durBadge.className = "badge neutral";
      durBadge.textContent = fmtDuration(item.itemDurationMs);
      meta.appendChild(durBadge);
    }
    if (item.ambiguous) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "same file also in " + item.collisionMessageIds.length + " post(s)";
      meta.appendChild(badge);
    }
    if (item.itemProductUrl) {
      var pl = document.createElement("a");
      pl.className = "pair-link";
      pl.href = item.itemProductUrl;
      pl.target = "_blank";
      pl.rel = "noopener";
      pl.textContent = "Photos \\u2197";
      meta.appendChild(pl);
    }
    wrap.appendChild(meta);

    return wrap;
  }

  function missingEl(missing) {
    var wrap = document.createElement("div");
    wrap.className = "pair-wrap";
    wrap.appendChild(thumbBox(missing.url, missing.mimeType, "Discord", { missing: true }));
    var note = document.createElement("div");
    note.className = "missing-note";
    note.textContent = "No Photos match found";
    wrap.appendChild(note);
    return wrap;
  }

  function groupCard(g) {
    var card = document.createElement("div");
    var hasIssue = g.missingAttachments.length > 0 || g.items.some(function (i) { return i.ambiguous; });
    card.className = "group-card" + (hasIssue ? " has-issue" : "");

    var head = document.createElement("div");
    head.className = "group-head";
    var author = document.createElement("span");
    author.className = "group-author";
    author.textContent = g.author;
    head.appendChild(author);
    var time = document.createElement("span");
    time.className = "group-time";
    time.textContent = fmtTime(g.timestamp);
    head.appendChild(time);
    var count = document.createElement("span");
    count.className = "group-count";
    count.textContent = g.totalAttachments + " attachment" + (g.totalAttachments === 1 ? "" : "s");
    head.appendChild(count);
    if (g.missingAttachments.length > 0) {
      var missingBadge = document.createElement("span");
      missingBadge.className = "badge danger";
      missingBadge.textContent = g.missingAttachments.length + " missing from Photos";
      head.appendChild(missingBadge);
    }
    var links = document.createElement("div");
    links.className = "group-links";
    var discordLink = document.createElement("a");
    discordLink.href = g.messageLink;
    discordLink.target = "_blank";
    discordLink.rel = "noopener";
    discordLink.textContent = "Open in Discord";
    links.appendChild(discordLink);
    head.appendChild(links);
    card.appendChild(head);

    var pairs = document.createElement("div");
    pairs.className = "pairs";
    g.items.forEach(function (item) {
      pairs.appendChild(pairEl(item));
    });
    g.missingAttachments.forEach(function (missing) {
      pairs.appendChild(missingEl(missing));
    });
    card.appendChild(pairs);

    return card;
  }

  function unmatchedCard(u) {
    var card = document.createElement("div");
    card.className = "unmatched-card";
    card.appendChild(thumbBox(u.itemThumbUrl, u.itemMimeType, "Photos"));
    var info = document.createElement("div");
    info.className = "card-info";
    var name = document.createElement("div");
    name.textContent = u.filename || u.itemId;
    info.appendChild(name);
    if (u.itemProductUrl) {
      var link = document.createElement("a");
      link.href = u.itemProductUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open in Photos";
      info.appendChild(link);
    }
    card.appendChild(info);
    return card;
  }

  var groupsList = document.getElementById("groups-list");
  var unmatchedGrid = document.getElementById("unmatched-grid");
  var groupsHeading = document.getElementById("groups-heading");
  var groupsSection = document.getElementById("groups-section");
  var unmatchedSection = document.getElementById("unmatched-section");
  var groupsEmpty = document.getElementById("groups-empty");
  var unmatchedEmpty = document.getElementById("unmatched-empty");

  var activeFilter = "all";

  function render() {
    var q = document.getElementById("search").value.trim().toLowerCase();

    var groups = report.messageGroups.filter(function (g) {
      if (activeFilter === "unmatched") return false;
      if (activeFilter === "ambiguous" && !g.items.some(function (i) { return i.ambiguous; })) return false;
      if (activeFilter === "missing" && g.missingAttachments.length === 0) return false;
      if (!q) return true;
      return (
        g.author.toLowerCase().indexOf(q) !== -1 ||
        g.messageId.indexOf(q) !== -1
      );
    });

    var unmatched = report.unmatched.filter(function (u) {
      if (activeFilter === "ambiguous" || activeFilter === "missing") return false;
      if (!q) return true;
      return (
        (u.filename || "").toLowerCase().indexOf(q) !== -1 ||
        u.itemId.toLowerCase().indexOf(q) !== -1
      );
    });

    groupsSection.style.display = activeFilter === "unmatched" ? "none" : "";
    unmatchedSection.style.display =
      activeFilter === "ambiguous" || activeFilter === "missing" ? "none" : "";
    groupsHeading.textContent =
      activeFilter === "ambiguous" ? "Messages with ambiguous matches" :
      activeFilter === "missing" ? "Messages with attachments missing from Photos" :
      "Messages";

    groupsList.textContent = "";
    groups.forEach(function (g) { groupsList.appendChild(groupCard(g)); });
    groupsEmpty.style.display = groups.length === 0 ? "" : "none";

    unmatchedGrid.textContent = "";
    unmatched.forEach(function (u) { unmatchedGrid.appendChild(unmatchedCard(u)); });
    unmatchedEmpty.style.display = unmatched.length === 0 ? "" : "none";
  }

  document.getElementById("search").addEventListener("input", render);
  Array.prototype.forEach.call(document.querySelectorAll(".filter-btn"), function (btn) {
    btn.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".filter-btn"), function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      activeFilter = btn.getAttribute("data-filter");
      render();
    });
  });

  render();
})();
</script>
</body>
</html>
`;
}

async function main() {
	const album = await getValidatedAlbum();
	console.log(
		`Backfilling dedup tags for album "${album.title}" (${APPLY ? "APPLY" : "DRY RUN"})\n`,
	);

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
		],
	});
	await client.login(process.env.DISCORD_TOKEN);

	const channel = await client.channels.fetch(OPERATING_CHANNEL_ID);
	if (!channel || !channel.isTextBased()) {
		throw new Error("Could not access the omoide channel.");
	}

	console.log("Fetching channel history...");
	const messages = await fetchAllChannelMessages(channel);
	const messageById = new Map(messages.map((m) => [m.id, m]));
	console.log(`Fetched ${messages.length} messages. Indexing attachments...`);

	const { hashToRefs, videoByFilename } = await buildDiscordIndices(messages);
	console.log(
		`Indexed ${hashToRefs.size} unique photo hashes, ${videoByFilename.size} unique video filenames.\n`,
	);

	console.log("Fetching album items...");
	const items = await fetchAllAlbumItems(album.id);
	console.log(`Fetched ${items.length} items. Matching...`);

	const plan: { itemId: string; messageId: string; description: string }[] = [];
	const unmatchedEntries: UnmatchedEntry[] = [];
	const messageGroups = new Map<string, MessageGroupData>();
	const matchedAttachmentUrls = new Set<string>();
	let alreadyTagged = 0;
	let ambiguousCount = 0;
	let processed = 0;

	function getOrCreateGroup(messageId: string): MessageGroupData {
		let group = messageGroups.get(messageId);
		if (!group) {
			const sourceMessage = messageById.get(messageId);
			group = {
				messageId,
				messageLink: `https://discord.com/channels/${OPERATING_GUILD_ID}/${OPERATING_CHANNEL_ID}/${messageId}`,
				author: sourceMessage?.author.username ?? "unknown",
				timestamp: sourceMessage?.createdTimestamp ?? 0,
				totalAttachments: sourceMessage
					? getMessageAttachments(sourceMessage).length
					: 1,
				items: [],
				missingAttachments: [],
			};
			messageGroups.set(messageId, group);
		}
		return group;
	}

	for (const item of items) {
		const isVideo = item.mimeType?.startsWith("video/");
		const itemThumbUrl = item.baseUrl ? `${item.baseUrl}=w300-h300-c` : "";

		if (item.description && MESSAGE_ID_TAG_PATTERN.test(item.description)) {
			alreadyTagged++;
			continue;
		}
		if (!item.baseUrl) {
			unmatchedEntries.push(unmatchedEntryFrom(item, itemThumbUrl));
			continue;
		}

		let refs: DiscordAttachmentRef[] | undefined;
		let matchMethod: MatchMethod;

		if (isVideo) {
			matchMethod = "filename";
			refs = item.filename ? videoByFilename.get(item.filename) : undefined;
		} else {
			matchMethod = "content";
			let tempPath: string | undefined;
			let hash: string | null = null;
			try {
				tempPath = await downloadToTemp(
					`${item.baseUrl}=d`,
					item.filename ?? item.id,
				);
				hash = await contentHash(tempPath);
			} catch (error) {
				console.error(`Failed to process album item ${item.id}:`, error);
			} finally {
				if (tempPath) await fs.unlink(tempPath).catch(() => {});
			}
			refs = hash ? hashToRefs.get(hash) : undefined;
		}

		if (!refs || refs.length === 0) {
			unmatchedEntries.push(unmatchedEntryFrom(item, itemThumbUrl));
			continue;
		}

		const distinctMessageIds = [...new Set(refs.map((r) => r.messageId))];
		const ambiguous = distinctMessageIds.length > 1;
		if (ambiguous) ambiguousCount++;

		const primaryRef = pickPrimaryRef(refs, messageById);
		// Every colliding attachment is accounted for by this one item's tag,
		// not just the primary's — otherwise the non-primary duplicate post(s)
		// would wrongly show up as "missing from Photos" below.
		for (const ref of refs) matchedAttachmentUrls.add(ref.url);

		plan.push({
			itemId: item.id,
			messageId: primaryRef.messageId,
			description:
				`${item.description ?? ""} | msg:${distinctMessageIds.join(",")}`.trim(),
		});

		if (REPORT_PATH) {
			const group = getOrCreateGroup(primaryRef.messageId);
			group.items.push({
				itemId: item.id,
				itemThumbUrl,
				itemMimeType: item.mimeType,
				itemProductUrl: item.productUrl,
				itemDurationMs: item.mediaMetadata?.video?.durationMillis
					? Number(item.mediaMetadata.video.durationMillis)
					: undefined,
				discordUrl: primaryRef.url,
				discordMimeType: primaryRef.mimeType,
				matchMethod,
				ambiguous,
				collisionMessageIds: ambiguous ? distinctMessageIds : undefined,
			});
		}

		processed++;
		if (processed % 25 === 0) {
			console.log(`  matched ${processed} items so far...`);
		}
	}

	let messagesWithMissingAttachments = 0;
	if (REPORT_PATH) {
		for (const message of messages.filter(hasUploadableAttachments)) {
			const attachments = getMessageAttachments(message);
			const missing = attachments.filter(
				(a: Attachment) => !matchedAttachmentUrls.has(a.url),
			);
			if (missing.length === 0) continue;

			const group = getOrCreateGroup(message.id);
			group.missingAttachments = missing.map((a: Attachment) => ({
				url: a.url,
				mimeType: a.contentType ?? undefined,
				name: a.name,
			}));
			messagesWithMissingAttachments++;
		}
	}

	console.log(
		`\nMatched ${plan.length} items to tag (${ambiguousCount} ambiguous). Already tagged: ${alreadyTagged}. Unmatched: ${unmatchedEntries.length}.`,
	);

	if (REPORT_PATH) {
		const html = buildReportHtml({
			generatedAt: new Date().toISOString(),
			albumTitle: album.title,
			stats: {
				totalMessages: messages.length,
				messagesWithAttachments: messages.filter(hasUploadableAttachments)
					.length,
				totalAlbumItems: items.length,
				matched: plan.length,
				alreadyTagged,
				unmatched: unmatchedEntries.length,
				ambiguous: ambiguousCount,
				messagesWithMissingAttachments,
			},
			messageGroups: Array.from(messageGroups.values()).sort(
				(a, b) => b.timestamp - a.timestamp,
			),
			unmatched: unmatchedEntries,
		});
		const resolvedPath = path.resolve(REPORT_PATH);
		await fs.writeFile(resolvedPath, html);
		console.log(`\nReview page written to ${resolvedPath}`);
	}

	if (!APPLY) {
		console.log(
			"\nDRY RUN — no changes written. Re-run with --apply to write tags.",
		);
	} else {
		console.log("\nApplying tags...");
		let done = 0;
		for (const p of plan) {
			// eslint-disable-next-line no-await-in-loop
			await requestWithRetry(
				() =>
					oauth2Client.request({
						url: `https://photoslibrary.googleapis.com/v1/mediaItems/${p.itemId}?updateMask=description`,
						method: "PATCH",
						data: { description: p.description },
					}),
				"Patch Media Item Description",
			);
			done++;
			if (done % 25 === 0) console.log(`  tagged ${done}/${plan.length}...`);
		}
		console.log(`Done. Tagged ${done} items.`);
	}

	client.destroy();
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
