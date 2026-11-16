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
 * once. The other results a search returns are kept in a small in-memory cache
 * (they sometimes cover another favourite) and only saved once a favourite uses
 * one, so the saved cache grows with your Klipy favourites, not with every
 * search result. Lookups run one at a time, spaced out.
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
/** Other results of recent searches, not saved */
const MAX_EXTRA_ENTRIES = 500;
const SEARCH_LIMIT = 50;
const SPACING_MS = 300;
const SAVE_DELAY_MS = 2000;
/** Don't wait longer than this for the saved cache, or for one search */
const LOAD_TIMEOUT_MS = 2000;
const SEARCH_TIMEOUT_MS = 8000;
/**
 * A media_format whose searches failed this many times in a row (and never
 * worked) is skipped for the rest of the session: the API probably rejects it.
 */
const MAX_FORMAT_FAILURES = 2;

export class KlipyResolver {
    /** `${format}|${pageKey}` -> low resolution URL, or "" when the search didn't find it */
    private cache = new LruCache<string, string>(MAX_ENTRIES);
    /** Same keys as `cache`, for results of searches made for other favourites */
    private extra = new LruCache<string, string>(MAX_EXTRA_ENTRIES);
    private pending = new Map<string, Promise<string | null>>();
    private chain: Promise<unknown> = Promise.resolve();
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private loaded: Promise<void>;
    /** Whether the saved cache finished loading (saving replaces it, so not before) */
    private loadDone = false;
    /** media_format -> searches that failed in a row; formats that worked are deleted */
    private formatFailures = new Map<string, number>();
    private workingFormats = new Set<string>();
    /** Bumped by `clear()`, so a load that finishes afterwards doesn't bring old entries back */
    private generation = 0;

    constructor(private opts: KlipyResolverOptions) {
        this.loaded = (async () => {
            const generation = this.generation;
            try {
                const entries = await opts.load?.();
                if (generation !== this.generation) return;
                for (const [k, v] of Object.entries(entries ?? {})) {
                    if (typeof v === "string" && !this.cache.has(k)) this.cache.set(k, v);
                }
            } catch (e) {
                opts.onError?.(e);
            } finally {
                this.loadDone = true;
            }
        })();
    }

    /** Whether searches with `format` are worth making (it isn't rejected by the API) */
    private usable(format: string) {
        return this.workingFormats.has(format) || (this.formatFailures.get(format) ?? 0) < MAX_FORMAT_FAILURES;
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
        for (const f of formats) {
            const v = this.lookup(this.key(f, pageUrl));
            if (v) return v;
            // A miss, or a format the API rejects: try the next one
            if (v === "" || !this.usable(f)) continue;
            return undefined;
        }
        // Every format missed or is skipped: nothing to look up
        return formats.length ? null : undefined;
    }

    /** Looks `pageUrl` up, trying `formats` in order. Never rejects. */
    resolve(pageUrl: string, formats: string[]): Promise<string | null> {
        const known = this.peek(pageUrl, formats);
        if (known !== undefined) return Promise.resolve(known);

        const id = `${formats.join(",")}|${pageKey(pageUrl)}`;
        const existing = this.pending.get(id);
        if (existing) return existing;

        const run = this.chain.then(async () => {
            await Promise.race([this.loaded, wait(LOAD_TIMEOUT_MS)]);
            for (const format of formats) {
                const cached = this.lookup(this.key(format, pageUrl));
                if (cached) return cached;
                if (cached === "" || !this.usable(format)) continue;
                try {
                    const hit = await this.search(pageUrl, format);
                    this.workingFormats.add(format);
                    this.formatFailures.delete(format);
                    if (hit) return hit;
                } catch (e) {
                    // e.g. the API doesn't accept this media_format: try the next one
                    if (!this.workingFormats.has(format)) {
                        this.formatFailures.set(format, (this.formatFailures.get(format) ?? 0) + 1);
                    }
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

        const results = await Promise.race([
            this.opts.search(q, format, SEARCH_LIMIT),
            wait(SEARCH_TIMEOUT_MS).then(() => {
                throw new Error(`Klipy lookup timed out (media_format=${format})`);
            }),
        ]);
        const want = pageKey(pageUrl);
        let hit: string | null = null;
        for (const r of results ?? []) {
            if (!r?.url || !r.src) continue;
            const low = normalizeUrl(r.src);
            if (pageKey(r.url) === want) {
                hit = low;
                continue;
            }
            const key = this.key(format, r.url);
            if (!this.cache.has(key)) this.extra.set(key, low);
            // Saved as "no small version" by an earlier search: this one found it
            else if (this.cache.get(key) === "") this.cache.set(key, low);
        }
        this.cache.set(this.key(format, pageUrl), hit ?? "");
        this.scheduleSave();
        return hit;
    }

    /** Cached answer for `key`. One found among other searches' results is moved into the saved cache. */
    private lookup(key: string): string | undefined {
        const saved = this.cache.get(key);
        if (saved !== undefined) return saved;
        const other = this.extra.get(key);
        if (other === undefined) return undefined;
        this.extra.delete(key);
        this.cache.set(key, other);
        this.scheduleSave();
        return other;
    }

    private scheduleSave() {
        if (!this.opts.save || this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            // Saving replaces the saved cache: wait until it's loaded, or its entries would be lost
            if (!this.loadDone) {
                this.loaded.then(() => this.scheduleSave());
                return;
            }
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

    /** Lookups saved, recent search results kept in memory, and roughly how much memory they use */
    stats() {
        return {
            saved: this.cache.size,
            recent: this.extra.size,
            bytes: this.cache.approxBytes() + this.extra.approxBytes(),
        };
    }

    /** Forgets every lookup, also the saved ones */
    clear() {
        this.generation++;
        this.loadDone = true;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        this.cache.clear();
        this.extra.clear();
        this.formatFailures.clear();
        this.workingFormats.clear();
        try {
            this.opts.save?.({});
        } catch (e) {
            this.opts.onError?.(e);
        }
    }

    /** Saves anything pending right away (call when the plugin stops) */
    flush() {
        if (!this.saveTimer || !this.loadDone) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        try {
            this.opts.save?.(this.entries());
        } catch (e) {
            this.opts.onError?.(e);
        }
    }
}

export function wait(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}
