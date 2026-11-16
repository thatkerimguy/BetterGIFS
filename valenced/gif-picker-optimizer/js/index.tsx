/*
 * GifPickerOptimizer for Valenced
 *
 * - Loads GIF picker results one at a time, in reading order (left to right,
 *   top to bottom), waiting for each one to finish before starting the next.
 * - Shows a loading / progress indicator on tiles that are still empty.
 * - Shows a lower resolution preview in the picker (XS / S / SD) while still
 *   sending and favouriting the original, full resolution GIF.
 * - Unloads GIFs that scrolled far off screen and shows them again from cache
 *   when they come back, so big favourite libraries stay smooth.
 * - Optionally shows still (not animated) previews in the favourites tab.
 */

import { onFluxEventDispatched, Stores } from "@valenced/discord/flux";
import { getJsonStorage, pluginStoragePathFor } from "@valenced/json-storage";
import { getModuleWithImportedPath } from "@valenced/discord/utils/modules/finders";
import { getModules } from "@valenced/modules/finders";
import { withProps } from "@valenced/modules/finders/filters";
import { instead } from "@valenced/patcher";
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import type { DiscordModules } from "@valenced/discord/types";
import type { ReactNode } from "react";

import { LoadedCache, LruCache } from "./cache";
import { KlipyResolver, wait } from "./klipy";
import { BoundedSet, isKlipyUrl, isTenorMediaUrl, isTenorPageGif, isVideoUrl, klipyFavoriteFormats, lowResMediaFormat, normalizeUrl, rewriteUrl, stillUrl } from "./lowres";
import { LoadQueue, type Ticket } from "./queue";
import SettingsComponent from "./settings";
import { DefaultSettings, getSettings, setStorage, type Settings, useSettings } from "./shared";

const PLUGIN_ID = "thatkerimguy.gif-picker-optimizer";
const ITEM_VIEW_PATH = "modules/gif_picker/native/GIFPickerItemView.tsx";
const RESULTS_LIST_PATH = "modules/gif_picker/native/GIFPickerResultsList.tsx";

let logger: DiscordModules.Logger | undefined;

const queue = new LoadQueue();
/** URLs that finished loading. Scrolled-back tiles with a cached URL skip the queue. */
const loaded = new LoadedCache(DefaultSettings.cacheSize);
/** Preview URLs that failed, never tried again */
const failed = new BoundedSet<string>(600);
/** `${quality}:${id|url}` -> low resolution URL from Discord's GIF API */
const apiPreviews = new Map<string, string>();
/** Looks up small versions of Klipy favourites (created on start) */
let klipy: KlipyResolver | undefined;

/** Tickets that were cancelled; a lookup that finishes later must not start them */
const dropped = new WeakSet<Ticket>();
function drop(t: Ticket | null) {
    if (!t) return;
    dropped.add(t);
    queue.cancel(t);
}

interface GifItem {
    id?: string;
    url?: string;
    src: string;
    width?: number;
    height?: number;
    /** only favourites have this (their position in the favourites list) */
    order?: number;
}

/** Favourites come from the frecency settings: they have an `order` and no `id` */
function isFavoriteItem(item: GifItem) {
    return typeof item.order === "number" && item.id == null;
}

interface HttpModule {
    HTTP: {
        get(options: { url: string; query?: Record<string, unknown>; oldFormErrors?: boolean; }): Promise<{ body: unknown; }>;
    };
    get: unknown;
    post: unknown;
    put: unknown;
    patch: unknown;
    del: unknown;
}

let http: HttpModule["HTTP"] | undefined;

/* -------------------------------------------------------------------------- */
/*                         Low resolution URL lookup                          */
/* -------------------------------------------------------------------------- */

async function lookupLowRes(event: { query?: string; items?: GifItem[]; }) {
    const { quality: q, klipyLookup } = getSettings();
    if (!klipyLookup || q === "original" || !http) return;

    const items = event.items ?? [];
    if (!items.some(i => i?.src && isKlipyUrl(i.src) && !apiPreviews.has(`${q}:${i.id ?? i.url}`))) return;

    const format = lowResMediaFormat(selectedFormat(), q);
    if (!format) return;

    // Hold the queue so tiles don't start loading the full resolution file meanwhile
    const release = queue.block(3000);
    try {
        const isSearch = typeof event.query === "string";
        const locale = (Stores.LocaleStore as unknown as { locale?: string; } | undefined)?.locale;
        const res = await http.get({
            url: isSearch ? "/gifs/search" : "/gifs/trending-gifs",
            query: {
                ...(isSearch ? { q: event.query } : {}),
                media_format: format,
                ...(locale ? { locale } : {}),
                limit: items.length,
            },
            oldFormErrors: true,
        });

        if (apiPreviews.size > 3000) apiPreviews.clear();
        for (const r of (Array.isArray(res?.body) ? res.body : []) as GifItem[]) {
            if (!r?.src) continue;
            const low = normalizeUrl(r.src);
            if (r.id != null) apiPreviews.set(`${q}:${r.id}`, low);
            if (r.url != null) apiPreviews.set(`${q}:${r.url}`, low);
        }
    } catch (e) {
        logger?.warn?.(`Couldn't fetch low resolution Klipy previews (media_format=${format})`, e);
    } finally {
        release();
    }
}

function selectedFormat() {
    return (Stores.GIFPickerViewStore as unknown as { getSelectedFormat?(): string; } | undefined)?.getSelectedFormat?.() ?? "tinywebp";
}

/** media_formats to look a Klipy favourite up with, or null when it doesn't need a lookup */
function klipyFormats(item: GifItem): string[] | null {
    const { quality: q, klipyLookup } = getSettings();
    if (!klipy || !klipyLookup || q === "original") return null;
    if (apiPreviews.has(`${q}:${item.id}`) || apiPreviews.has(`${q}:${item.url}`)) return null;
    if (!isKlipyUrl(item.src) || !klipy.canResolve(item.url)) return null;
    // Mobile tiles are always images, even when the favourite is a proxied video
    const formats = klipyFavoriteFormats(false, selectedFormat(), q);
    return formats.length ? formats : null;
}

/* -------------------------------------------------------------------------- */
/*                        Tenor favourites on mobile                          */
/* -------------------------------------------------------------------------- */

/**
 * Discord mobile shows Tenor favourites as `<tenor page URL>.gif`, which redirects
 * to the full size GIF. Following the redirect once (HEAD, cached and saved) gives
 * the media URL, and from that Tenor's small renditions.
 */
class TenorPageResolver {
    /** page URL -> media URL, or "" when the redirect didn't lead to a Tenor media URL */
    private cache = new LruCache<string, string>(5000);
    private pending = new Map<string, Promise<void>>();
    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private store?: { load(): Promise<Record<string, string> | undefined>; save(e: Record<string, string>): void; }) {
        store?.load().then(entries => {
            for (const [k, v] of Object.entries(entries ?? {})) if (typeof v === "string" && !this.cache.has(k)) this.cache.set(k, v);
        }, () => { });
    }

    /** media URL, "" when unknown for good, undefined when not resolved yet */
    peek(pageUrl: string) {
        return this.cache.get(pageUrl);
    }

    resolve(pageUrl: string): Promise<void> {
        if (this.cache.has(pageUrl)) return Promise.resolve();
        const existing = this.pending.get(pageUrl);
        if (existing) return existing;

        const run = (async () => {
            try {
                const res = await Promise.race([
                    fetch(pageUrl, { method: "HEAD" }),
                    wait(8000).then(() => null),
                ]);
                if (!res) return; // timed out: try again next time
                const media = normalizeUrl(res.url ?? "");
                this.cache.set(pageUrl, isTenorMediaUrl(media) ? media : "");
                this.scheduleSave();
            } catch (e) {
                logger?.warn?.("Couldn't resolve Tenor favourite", e);
            }
        })().finally(() => this.pending.delete(pageUrl));
        this.pending.set(pageUrl, run);
        return run;
    }

    private scheduleSave() {
        if (!this.store || this.saveTimer) return;
        this.saveTimer = setTimeout(() => this.flush(), 2000);
    }

    flush() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        if (!this.store) return;
        const out: Record<string, string> = {};
        for (const [k, v] of this.cache.entries()) out[k] = v;
        try { this.store.save(out); } catch { }
    }
}

let tenorPages: TenorPageResolver | undefined;

/** A pending lookup for `item`, or null when its preview URL is already known */
function lookupFor(item: GifItem): Promise<unknown> | null {
    const { quality: q } = getSettings();
    if (q !== "original" && tenorPages && isTenorPageGif(item.src)) {
        const page = normalizeUrl(item.src);
        return tenorPages.peek(page) === undefined ? tenorPages.resolve(page) : null;
    }
    const formats = klipyFormats(item);
    if (!formats || klipy!.peek(item.url, formats) !== undefined) return null;
    return klipy!.resolve(item.url!, formats);
}

/**
 * The URL a tile should display. Never changes what gets sent.
 * With `still`, a non-animated image is preferred when the source has one.
 */
function pickSrc(item: GifItem, still = false): string {
    const original = normalizeUrl(item.src);
    try {
        const q = getSettings().quality;
        if (still) {
            const frame = stillUrl(original, q, item);
            if (frame && !failed.has(frame)) return frame;
        }
        if (q === "original") return original;

        // Tenor favourite shown as its page URL: work from the media URL it redirects to
        const tenorMedia = isTenorPageGif(original) ? tenorPages?.peek(original) : undefined;

        const formats = klipyFormats(item);
        const low = apiPreviews.get(`${q}:${item.id}`)
            ?? apiPreviews.get(`${q}:${item.url}`)
            ?? (formats && klipy!.peek(item.url, formats))
            ?? rewriteUrl(tenorMedia || original, q, item, { imagesOnly: true });

        if (!low || low === original || failed.has(low)) return original;
        // Mobile tiles are images: an mp4/webm URL would never load
        if (isVideoUrl(low)) return original;
        return low;
    } catch {
        return original;
    }
}

/* -------------------------------------------------------------------------- */
/*                         Visible range of the list                          */
/* -------------------------------------------------------------------------- */

interface ViewToken {
    index?: number | null;
    isViewable?: boolean;
}

/**
 * Which item indexes the GIF list shows right now. Discord's own list only
 * remembers indexes that were *ever* viewed and keeps those tiles loaded
 * forever, which is what makes big favourite libraries slow. This tracks the
 * range that's on screen now, so tiles far outside of it can unload.
 */
class ViewportStore {
    first = -1;
    last = -1;
    private listeners = new Set<() => void>();

    get known() {
        return this.first !== -1;
    }

    update(viewable: ViewToken[] | undefined) {
        let first = Infinity;
        let last = -Infinity;
        for (const t of viewable ?? []) {
            if (!t?.isViewable || t.index == null) continue;
            if (t.index < first) first = t.index;
            if (t.index > last) last = t.index;
        }
        // Nothing viewable (list hidden or empty): keep the last known range
        if (first === Infinity) return;
        if (first === this.first && last === this.last) return;
        this.first = first;
        this.last = last;
        for (const l of this.listeners) l();
    }

    isVisible(index: number) {
        return !this.known || (index >= this.first && index <= this.last);
    }

    isNear(index: number, buffer: number) {
        return !this.known || (index >= this.first - buffer && index <= this.last + buffer);
    }

    subscribe(fn: () => void) {
        this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
    }
}

const ViewportContext = createContext<ViewportStore | null>(null);

interface ResultsListProps {
    [k: string]: unknown;
}

const isFlashList = (n: any) =>
    isValidElement(n)
    && typeof (n.props as any)?.onViewableItemsChanged === "function"
    && typeof (n.props as any)?.renderItem === "function";

/** Wraps Discord's GIF results list to track which items are on screen */
function OptimizedResultsList({ props, render }: { props: ResultsListProps; render: (p: ResultsListProps) => ReactNode; }) {
    const store = useMemo(() => new ViewportStore(), []);
    const tree = render(props);

    const originalCb = useRef<((info: any) => void) | null>(null);
    // Stable, because lists don't support changing onViewableItemsChanged on the fly
    const onViewableItemsChanged = useCallback((info: any) => {
        originalCb.current?.(info);
        store.update(info?.viewableItems);
    }, [store]);

    const [result, hit] = replaceInTree(tree, isFlashList, (list: any) => {
        originalCb.current = list.props.onViewableItemsChanged;
        return cloneElement(list, { onViewableItemsChanged });
    });

    return (
        <ViewportContext.Provider value={hit ? store : null}>
            {hit ? result : tree}
        </ViewportContext.Provider>
    );
}

/* -------------------------------------------------------------------------- */
/*                                  UI                                        */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
    frame: {
        overflow: "hidden",
    },
    fill: {
        ...StyleSheet.absoluteFillObject,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: "center",
        justifyContent: "center",
    },
    queuedDot: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 3,
        borderColor: "rgba(255, 255, 255, 0.25)",
    },
    track: {
        marginTop: 6,
        width: "55%",
        maxWidth: 80,
        height: 3,
        borderRadius: 2,
        backgroundColor: "rgba(255, 255, 255, 0.25)",
        overflow: "hidden",
    },
    bar: {
        height: "100%",
        backgroundColor: "#5865F2",
    },
    pct: {
        marginTop: 3,
        fontSize: 10,
        fontWeight: "600",
        color: "white",
        textShadowColor: "rgba(0, 0, 0, 0.8)",
        textShadowRadius: 3,
    },
});

function Indicator({ state, progress }: { state: "queued" | "loading"; progress: number | null; }) {
    if (state === "queued") {
        return (
            <View style={styles.overlay} pointerEvents="none">
                <View style={styles.queuedDot} />
            </View>
        );
    }
    const p = progress == null ? null : Math.min(1, Math.max(0, progress));
    return (
        <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator size="small" color="white" />
            {p != null && (
                <>
                    <View style={styles.track}>
                        <View style={[styles.bar, { width: `${Math.round(p * 100)}%` }]} />
                    </View>
                    <Text style={styles.pct}>{Math.round(p * 100)}%</Text>
                </>
            )}
        </View>
    );
}

/** Replaces the first node matching `pred` anywhere in a React element tree */
function replaceInTree(node: any, pred: (n: any) => boolean, replace: (n: any) => any): [any, boolean] {
    if (pred(node)) return [replace(node), true];
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            const [res, hit] = replaceInTree(node[i], pred, replace);
            if (hit) {
                const copy = node.slice();
                copy[i] = res;
                return [copy, true];
            }
        }
        return [node, false];
    }
    if (isValidElement(node) && (node.props as any)?.children != null) {
        const [children, hit] = replaceInTree((node.props as any).children, pred, replace);
        if (hit) return [{ ...node, props: { ...(node.props as any), children } }, true];
    }
    return [node, false];
}

/** resolving: looking up the small Klipy URL before loading */
type Phase = "queued" | "resolving" | "loading" | "done";

interface ItemProps {
    item: GifItem;
    index: number;
    height: number;
    selected?: boolean;
    onPressGIF(item: GifItem, index: number): void;
}

/** Whether the tile at `index` is near the visible range, plus the queue's "on screen" flag */
function useNearViewport(index: number, buffer: number, onVisible: (visible: boolean) => void) {
    const store = useContext(ViewportContext);
    const [near, setNear] = useState(() => store?.isNear(index, buffer) ?? true);

    const latest = useRef({ index, buffer, onVisible });
    latest.current = { index, buffer, onVisible };

    useEffect(() => {
        if (!store) return;
        const check = () => {
            const { index, buffer, onVisible } = latest.current;
            setNear(store.isNear(index, buffer));
            onVisible(store.isVisible(index));
        };
        check();
        return store.subscribe(check);
    }, [store, index, buffer]);

    return near;
}

function OptimizedItem({ props, render }: { props: ItemProps; render: (p: ItemProps) => any; }) {
    // Discord's own tile. Always rendered (it uses hooks) and with the original item,
    // so tapping sends and long-press favourites the full resolution GIF.
    const tree = render(props);

    const { item, index } = props;
    const { sequential, concurrency, loadTimeout, showProgress, unloadOffscreen, offscreenBuffer, cacheSize, stillFavorites } = useSettings();
    if (loaded.max !== cacheSize) loaded.resize(cacheSize);
    const still = stillFavorites && isFavoriteItem(item);

    const [chosen, setChosen] = useState<string | null>(() => {
        const p = pickSrc(item, still);
        return loaded.hit(p) ? p : null;
    });
    const [phase, setPhase] = useState<Phase>(() => chosen ? "done" : "queued");
    const [progress, setProgress] = useState<number | null>(null);

    const ticketRef = useRef<Ticket | null>(null);
    const indexRef = useRef(index);
    indexRef.current = index;
    const visibleRef = useRef(true);

    const near = useNearViewport(index, offscreenBuffer, visible => {
        visibleRef.current = visible;
        const t = ticketRef.current;
        if (t && t.visible !== visible) {
            t.visible = visible;
            queue.kick();
        }
    });
    const parked = unloadOffscreen && !near;

    // Wait for a turn in the load queue (only while near the screen)
    useEffect(() => {
        if (phase !== "queued" || parked) return;

        // Came back on screen and was loaded before: show it from cache right away
        const cached = pickSrc(item, still);
        if (loaded.hit(cached)) {
            setChosen(cached);
            setPhase("done");
            return;
        }

        queue.concurrency = sequential ? concurrency : 64;
        queue.prioritizeVisible = true;

        let started = false;
        const begin = () => {
            const p = pickSrc(item, still);
            setChosen(p);
            setProgress(null);
            if (loaded.hit(p)) {
                queue.finish(ticket);
                setPhase("done");
            } else {
                setPhase("loading");
            }
        };
        const ticket: Ticket = {
            visible: visibleRef.current,
            order: () => indexRef.current ?? 0,
            start: () => {
                started = true;
                const lookup = lookupFor(item);
                if (!lookup) return begin();
                setPhase("resolving");
                // A lookup never holds a tile longer than the load timeout
                Promise.race([lookup, wait(loadTimeout * 1000)])
                    .catch(() => { })
                    .then(() => !dropped.has(ticket) && begin());
            },
        };
        ticketRef.current = ticket;
        queue.enqueue(ticket);
        // Once started, the slot is freed by finishing, parking or unmounting instead
        return () => {
            if (!started) drop(ticket);
        };
    }, [phase, parked, still]);

    // The still previews setting changed: pick the URL again
    const stillRef = useRef(still);
    useEffect(() => {
        if (stillRef.current === still) return;
        stillRef.current = still;
        drop(ticketRef.current);
        setChosen(null);
        setProgress(null);
        setPhase("queued");
    }, [still]);

    // Scrolled far away while loading: stop, free the slot, and queue again when it comes back
    useEffect(() => {
        if (!parked || (phase !== "loading" && phase !== "resolving")) return;
        drop(ticketRef.current);
        setProgress(null);
        setPhase("queued");
    }, [parked, phase]);

    // Release the slot after the timeout so one slow GIF doesn't hold everything up
    useEffect(() => {
        if (phase !== "loading" && phase !== "resolving") return;
        const t = setTimeout(() => ticketRef.current && queue.finish(ticketRef.current), loadTimeout * 1000);
        return () => clearTimeout(t);
    }, [phase, chosen]);

    // Unmounted while loading: free the slot
    useEffect(() => () => drop(ticketRef.current), []);

    const original = normalizeUrl(item.src);

    const done = () => {
        if (chosen) loaded.mark(chosen);
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    const error = () => {
        if (chosen && chosen !== original) {
            // Still / preview not available: try the next best one, then the original
            failed.add(chosen);
            setProgress(null);
            const next = pickSrc(item, still);
            setChosen(next !== chosen ? next : original);
            return;
        }
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    // A preview that neither loads nor fails (some image views never report either)
    // falls back to the next option instead of spinning forever
    const errorRef = useRef(error);
    errorRef.current = error;
    useEffect(() => {
        if (phase !== "loading" || !chosen || chosen === original) return;
        const t = setTimeout(() => errorRef.current(), loadTimeout * 2000);
        return () => clearTimeout(t);
    }, [phase, chosen]);

    const isImage = (n: any) => isValidElement(n) && normalizeUrl((n.props as any)?.source?.uri ?? "") === original;

    const [result, hit] = replaceInTree(tree, isImage, (img: any) => {
        const imgProps = img.props;

        // Off screen (unloaded), waiting for its turn or being looked up: an empty frame, no image in memory
        if (parked || phase === "queued" || phase === "resolving") {
            return (
                <View style={[imgProps.style, styles.frame]}>
                    {showProgress && !parked && <Indicator state={phase === "resolving" ? "loading" : "queued"} progress={null} />}
                </View>
            );
        }

        const shown = chosen ?? original;
        const image = {
            ...img,
            key: shown,
            props: {
                ...imgProps,
                source: { ...imgProps.source, uri: shown },
                style: [imgProps.style, styles.fill],
                onLoad: (...a: any[]) => {
                    imgProps.onLoad?.(...a);
                    if (phase === "loading") done();
                    else if (chosen) loaded.mark(chosen);
                },
                onError: (...a: any[]) => {
                    imgProps.onError?.(...a);
                    if (phase === "loading") error();
                },
                onProgress: (e: any) => {
                    imgProps.onProgress?.(e);
                    const ev = e?.nativeEvent ?? e;
                    if (phase === "loading" && ev?.total > 0) setProgress(ev.loaded / ev.total);
                },
            },
        };

        return (
            <View style={[imgProps.style, styles.frame]}>
                {image}
                {phase === "loading" && showProgress && <Indicator state="loading" progress={progress} />}
            </View>
        );
    });

    // Unknown tree shape: leave Discord's tile alone and don't hold up the queue
    useEffect(() => {
        if (!hit) drop(ticketRef.current);
    }, [hit]);

    return hit ? result : tree;
}

export default plugin<{ jsonStorage: Settings; }>({
    jsonStorage: {
        load: true,
        default: DefaultSettings,
    },

    start({ cleanup, jsonStorage, logger: pluginLogger }) {
        setStorage(jsonStorage);
        logger = pluginLogger;
        loaded.resize(getSettings().cacheSize);

        const klipyStore = getJsonStorage<{ entries: Record<string, string>; }>(
            pluginStoragePathFor(PLUGIN_ID, "klipy-previews.json"),
            { default: { entries: {} } },
        );
        const tenorStore = getJsonStorage<{ entries: Record<string, string>; }>(
            pluginStoragePathFor(PLUGIN_ID, "tenor-pages.json"),
            { default: { entries: {} } },
        );
        tenorPages = new TenorPageResolver({
            load: async () => (await tenorStore.get())?.entries,
            save: entries => void tenorStore.set({ entries }, true),
        });

        klipy = new KlipyResolver({
            async search(q, format, limit) {
                if (!http) throw new Error("HTTP module not found yet");
                const locale = (Stores.LocaleStore as unknown as { locale?: string; } | undefined)?.locale;
                const res = await http.get({
                    url: "/gifs/search",
                    query: { q, media_format: format, ...(locale ? { locale } : {}), limit },
                    oldFormErrors: true,
                });
                return Array.isArray(res?.body) ? res.body : [];
            },
            load: async () => (await klipyStore.get())?.entries,
            save: entries => void klipyStore.set({ entries }, true),
            onError: e => logger?.warn?.("Klipy favourite lookup failed", e),
        });

        cleanup(
            () => {
                klipy?.flush();
                tenorPages?.flush();
                tenorPages = undefined;
                klipy = undefined;
                setStorage(undefined);
                http = undefined;
                loaded.clear();
                apiPreviews.clear();
            },

            getModules(
                withProps<HttpModule>("HTTP", "get", "post", "put", "patch", "del"),
                mod => {
                    http = mod.HTTP;
                },
                { max: 1 },
            ),

            onFluxEventDispatched<{ query?: string; items?: GifItem[]; }>("GIF_PICKER_QUERY_SUCCESS", payload => {
                lookupLowRes(payload).catch(() => { });
                // Returning the payload lets the event through unchanged
                return payload;
            }),

            getModuleWithImportedPath<{ default: (props: ItemProps) => ReactNode; }>(ITEM_VIEW_PATH, mod => {
                cleanup(
                    instead(mod, "default", function (this: unknown, args, orig) {
                        const props = args[0];
                        if (!props?.item?.src) return Reflect.apply(orig, this, args);
                        return (
                            <OptimizedItem
                                key={props.item.src}
                                props={props}
                                render={p => Reflect.apply(orig, this, [p])}
                            />
                        );
                    }),
                );
            }),

            getModuleWithImportedPath<{ default: (props: ResultsListProps) => ReactNode; }>(RESULTS_LIST_PATH, mod => {
                cleanup(
                    instead(mod, "default", function (this: unknown, args, orig) {
                        return (
                            <OptimizedResultsList
                                props={args[0]}
                                render={p => Reflect.apply(orig, this, [p])}
                            />
                        );
                    }),
                );
            }),
        );
    },

    SettingsComponent,
});
