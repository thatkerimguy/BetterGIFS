/*
 * GifPickerOptimizer — caches.
 * Shared between the Vencord and Valenced builds (keep both copies in sync).
 *
 * Tiles that scroll far off screen are unloaded to free memory and decoders.
 * When they scroll back, these caches let them show again at once: a URL that
 * finished loading before skips the load queue and is served from the HTTP /
 * native image cache instead of downloading again.
 */

/** Least recently used map. `get` and `set` both count as a use. */
export class LruCache<K, V> {
    private map = new Map<K, V>();

    constructor(public max: number, private onEvict?: (key: K, value: V) => void) { }

    get size() {
        return this.map.size;
    }

    has(key: K) {
        return this.map.has(key);
    }

    get(key: K): V | undefined {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key)!;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key: K, value: V) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        this.trim();
    }

    delete(key: K) {
        if (!this.map.has(key)) return false;
        const value = this.map.get(key)!;
        this.map.delete(key);
        this.onEvict?.(key, value);
        return true;
    }

    /** Entries from oldest to newest use. Doesn't count as a use. */
    entries() {
        return this.map.entries();
    }

    /** Changes the capacity, evicting the oldest entries if needed */
    resize(max: number) {
        this.max = max;
        this.trim();
    }

    clear() {
        for (const [k, v] of this.map) this.onEvict?.(k, v);
        this.map.clear();
    }

    private trim() {
        const max = Math.max(0, this.max | 0);
        while (this.map.size > max) {
            const [key, value] = this.map.entries().next().value as [K, V];
            this.map.delete(key);
            this.onEvict?.(key, value);
        }
    }
}

/** What we remember about a URL that finished loading */
export interface LoadedEntry {
    /** when it finished loading (ms) */
    at: number;
}

/**
 * URLs that finished loading. Remembering them lets a tile that comes back on
 * screen skip the queue. Bounded, so huge favourite libraries don't grow it forever.
 */
export class LoadedCache extends LruCache<string, LoadedEntry> {
    mark(url: string) {
        this.set(url, { at: Date.now() });
    }

    /** Whether `url` loaded before. Counts as a use, keeping it cached longer. */
    hit(url: string | null | undefined) {
        return url != null && this.get(url) != null;
    }
}
