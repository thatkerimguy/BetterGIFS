/*
 * GifPickerOptimizer — low resolution preview URL helpers.
 * Shared between the Vencord and Raincord builds (keep both copies in sync).
 *
 * Only the URL that the picker *displays* is changed. The item objects that
 * Discord sends/favourites are never modified, so the full resolution GIF is
 * what ends up in chat and in your favourites.
 */

export type Quality = "xs" | "s" | "sd" | "original";

/** Longest side (px) a downscaled image is asked for, per quality. */
export const QUALITY_CAP: Record<Exclude<Quality, "original">, number> = {
    xs: 128,
    s: 240,
    sd: 360,
};

// Tenor encodes the rendition in the last two characters of the media id.
//   image: A2 = nanowebp, A1 = tinywebp, A5 = ~360px webp
//   video: P2 = nanomp4,  P3 = tinymp4
const TENOR_CODES = {
    xs: { image: "A2", video: "P2" },
    s: { image: "A1", video: "P3" },
    sd: { image: "A5", video: "P3" },
} as const;

// Giphy rendition names
const GIPHY_CODES = {
    xs: { image: "100w", video: "100w" },
    s: { image: "200w", video: "200w" },
    sd: { image: "480w", video: "200w" },
} as const;

// Twitter / X (pbs.twimg.com) — used by vx/fx/twitter embeds
const TWITTER_NAMES = {
    xs: "240x240",
    s: "360x360",
    sd: "small",
} as const;

const TENOR_RE = /^https:\/\/(?:media\d?|c)\.tenor\.com(?:\/m)?\/([^/]+?)([A-Za-z0-9]{2})\/([^/?#]+)\.(gif|webp|mp4|webm)(?:[?#].*)?$/i;
const GIPHY_RE = /^https:\/\/(?:media\d?|i)\.giphy\.com\/(?:media\/(?:v\d\.[^/]+\/)?)?([A-Za-z0-9]+)\/?(?:[^/?#]*)\.(gif|webp|mp4)(?:[?#].*)?$/i;
const IMAGES_EXT_RE = /^images-ext-\d+\.discordapp\.net$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;

export function normalizeUrl(url: string): string {
    return url.startsWith("//") ? "https:" + url : url;
}

function safeUrl(url: string): URL | null {
    try {
        return new URL(normalizeUrl(url));
    } catch {
        return null;
    }
}

/** Path of the underlying media, also for images-ext proxied external URLs */
function mediaPath(u: URL) {
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { }
    return path.toLowerCase();
}

export function isVideoUrl(url: string): boolean {
    const u = safeUrl(url);
    return u != null && VIDEO_EXT_RE.test(mediaPath(u));
}

export function isKlipyUrl(url: string): boolean {
    const u = safeUrl(url);
    return u != null && /(^|\.)klipy\.com$/i.test(u.hostname);
}

/**
 * Returns a lower resolution URL for `src` that can be derived from the URL alone,
 * or null if none is known. Always keeps the media category (video stays video,
 * image stays image) so the picker renders it with the same element type.
 */
export function rewriteUrl(src: string, quality: Quality, dims?: { width?: number; height?: number; }): string | null {
    if (quality === "original" || !src) return null;
    const url = normalizeUrl(src);

    // Tenor
    const tenor = url.match(TENOR_RE);
    if (tenor) {
        const [, id, , name, ext] = tenor;
        const video = ext === "mp4" || ext === "webm";
        const code = TENOR_CODES[quality][video ? "video" : "image"];
        return `https://media.tenor.com/${id}${code}/${name}.${video ? "mp4" : "webp"}`;
    }

    // Giphy
    const giphy = url.match(GIPHY_RE);
    if (giphy) {
        const [, id, ext] = giphy;
        const video = ext === "mp4";
        const code = GIPHY_CODES[quality][video ? "video" : "image"];
        return `https://media.giphy.com/media/${id}/${code}.${video ? "mp4" : "webp"}`;
    }

    const u = safeUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase();

    // Twitter / X images (vx/fx/twitter embeds)
    if (host === "pbs.twimg.com" && /^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(u.pathname)) {
        if (u.pathname.startsWith("/media/")) {
            u.searchParams.set("name", TWITTER_NAMES[quality]);
            return u.toString();
        }
        return null;
    }

    // Discord CDN, media proxy and external media proxy (images-ext, used for vx/fx/twitter and every other embed)
    const isCdnAttachment = host === "cdn.discordapp.com" && /^\/(ephemeral-)?attachments\//.test(u.pathname);
    if (isCdnAttachment || host === "media.discordapp.net" || IMAGES_EXT_RE.test(host)) {
        const path = mediaPath(u);
        // The media proxy cannot shrink videos while keeping them animated
        if (VIDEO_EXT_RE.test(path)) return null;

        if (isCdnAttachment) u.hostname = "media.discordapp.net";

        const cap = QUALITY_CAP[quality];
        const w = dims?.width ?? 0;
        const h = dims?.height ?? 0;
        if (w > 0 && h > 0) {
            // Don't ask for something bigger than the original
            const scale = Math.min(1, cap / Math.max(w, h));
            if (scale >= 1 && !path.endsWith(".gif")) return null;
            u.searchParams.set("width", String(Math.max(1, Math.round(w * scale))));
            u.searchParams.set("height", String(Math.max(1, Math.round(h * scale))));
        } else {
            u.searchParams.set("width", String(cap));
        }

        if (path.endsWith(".gif") || path.endsWith(".webp") || path.endsWith(".avif") || !/\.(png|jpe?g)$/.test(path)) {
            u.searchParams.set("format", "webp");
            u.searchParams.set("animated", "true");
        }
        return u.toString();
    }

    return null;
}

/**
 * media_format to ask Discord's /gifs API for, to get a lower resolution rendition
 * of Klipy results (Klipy uses a different random file name per rendition, so they
 * cannot be derived from the full resolution URL). Returns null when Discord's
 * default is already as small as or smaller than the wanted quality.
 */
export function lowResMediaFormat(selectedFormat: string, quality: Quality): string | null {
    if (quality === "original" || quality === "sd") return null;
    const fmt = selectedFormat.toLowerCase();
    const isWebp = fmt.includes("webp");
    const isMp4 = fmt.includes("mp4");
    const family = isWebp ? "webp" : isMp4 ? "mp4" : "webm";
    const wanted = quality === "xs" ? "nano" : "tiny";

    if (fmt.startsWith("nano")) return null;
    if (fmt.startsWith("tiny") && wanted === "tiny") return null;
    return wanted + family;
}

/** Simple bounded set (drops oldest entries) */
export class BoundedSet<T> {
    private set = new Set<T>();
    constructor(private max: number) { }
    has(v: T) { return this.set.has(v); }
    add(v: T) {
        this.set.delete(v);
        this.set.add(v);
        if (this.set.size > this.max) {
            const first = this.set.values().next().value as T;
            this.set.delete(first);
        }
    }
    clear() { this.set.clear(); }
}
