/*
 * GifPickerOptimizer — low resolution previews for Klipy favourites.
 * Shared between the Vencord and Valenced builds (keep both copies in sync).
 *
 * Klipy gives every rendition a random file name, and Discord stores Klipy
 * favourites as the full size .gif, so a small version can't be derived from the
 * URL. Favourites do keep their Klipy page URL (`https://klipy.com/gifs/<slug>`),
 * so this searches Discord's own GIF API for the slug, asking for a small format,
 * and picks the result with the same page URL.
 *
 * Results (also misses) are cached and persisted, so each favourite is looked up
 * once. Every search also caches the other results it returned, which often
 * covers more favourites. Lookups run one at a time, spaced out.
 */

import { LruCache } from "./cache";
import { klipyPageQuery, normalizeUrl, pageKey } from "./lowres";

export interface KlipySearchResult {
    url?: string;
    src?: string;
}

export interface KlipyResolverOptions {
    /** Discord's /gifs/search with the given query, media_format and limit */
    search(q: string, format: string, limit: number): Promise<KlipySearchResult[]>;
    load?(): Promise<Record<string, string> | undefined>;
    save?(entries: Record<string, string>): void;
    onError?(e: unknown): void;
}

const MAX_ENTRIES = 5000;
const SEARCH_LIMIT = 50;
const SPACING_MS = 300;
const SAVE_DELAY_MS = 2000;

export class KlipyResolver {
    /** `${format}|${pageKey}` -> low resolution URL, or "" when the search didn't find it */
    private cache = new LruCache<string, string>(MAX_ENTRIES);
    private pending = new Map<string, Promise<string | null>>();
    private chain: Promise<unknown> = Promise.resolve();
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private loaded: Promise<void>;

    constructor(private opts: KlipyResolverOptions) {
        this.loaded = (async () => {
            try {
                const entries = await opts.load?.();
                for (const [k, v] of Object.entries(entries ?? {})) {
                    if (typeof v === "string" && !this.cache.has(k)) this.cache.set(k, v);
                }
            } catch (e) {
                opts.onError?.(e);
            }
        })();
    }

    private key(format: string, pageUrl: string) {
        return `${format}|${pageKey(pageUrl)}`;
    }

    /** Whether `pageUrl` can be looked up at all */
    canResolve(pageUrl: string | undefined) {
        return klipyPageQuery(pageUrl) != null;
    }

    /**
     * Cached answer for the first format that has one:
     * a URL, null when no small version exists, or undefined when not looked up yet.
     */
    peek(pageUrl: string | undefined, formats: string[]): string | null | undefined {
        if (!pageUrl) return null;
        let missed = false;
        for (const f of formats) {
            const v = this.cache.get(this.key(f, pageUrl));
            if (v) return v;
            if (v === "") missed = true;
            else return undefined;
        }
        return missed ? null : undefined;
    }

    /** Looks `pageUrl` up, trying `formats` in order. Never rejects. */
    resolve(pageUrl: string, formats: string[]): Promise<string | null> {
        const known = this.peek(pageUrl, formats);
        if (known !== undefined) return Promise.resolve(known);

        const id = `${formats.join(",")}|${pageKey(pageUrl)}`;
        const existing = this.pending.get(id);
        if (existing) return existing;

        const run = this.chain.then(async () => {
            await this.loaded;
            for (const format of formats) {
                const cached = this.cache.get(this.key(format, pageUrl));
                if (cached) return cached;
                if (cached === "") continue;
                try {
                    const hit = await this.search(pageUrl, format);
                    if (hit) return hit;
                } catch (e) {
                    // e.g. the API doesn't accept this media_format: try the next one
                    this.opts.onError?.(e);
                }
                await wait(SPACING_MS);
            }
            return null;
        }).finally(() => this.pending.delete(id));

        this.chain = run.then(() => wait(SPACING_MS));
        this.pending.set(id, run);
        return run;
    }

    private async search(pageUrl: string, format: string): Promise<string | null> {
        const q = klipyPageQuery(pageUrl);
        if (!q) return null;

        const results = await this.opts.search(q, format, SEARCH_LIMIT);
        const want = pageKey(pageUrl);
        let hit: string | null = null;
        for (const r of results ?? []) {
            if (!r?.url || !r.src) continue;
            const low = normalizeUrl(r.src);
            this.cache.set(this.key(format, r.url), low);
            if (pageKey(r.url) === want) hit = low;
        }
        if (!hit) this.cache.set(this.key(format, pageUrl), "");
        this.scheduleSave();
        return hit;
    }

    private scheduleSave() {
        if (!this.opts.save || this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            try {
                this.opts.save!(this.entries());
            } catch (e) {
                this.opts.onError?.(e);
            }
        }, SAVE_DELAY_MS);
    }

    private entries() {
        const out: Record<string, string> = {};
        for (const [k, v] of this.cache.entries()) out[k] = v;
        return out;
    }

    /** Saves anything pending right away (call when the plugin stops) */
    flush() {
        if (!this.saveTimer) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        try {
            this.opts.save?.(this.entries());
        } catch (e) {
            this.opts.onError?.(e);
        }
    }
}

function wait(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}
