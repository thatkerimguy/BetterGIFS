/*
 * GifPickerOptimizer for Vencord
 *
 * - Loads GIF picker results one at a time, in reading order (left to right,
 *   top to bottom), waiting for each one to finish before starting the next.
 * - Shows a loading / progress indicator on tiles that are still empty.
 * - Shows a lower resolution preview in the picker (XS / S / SD) while still
 *   sending and favouriting the original, full resolution GIF.
 * - Unloads GIFs that scrolled far off screen and shows them again from cache
 *   when they come back, so big favourite libraries stay smooth.
 * - Optionally shows still (not animated) previews in the favourites tab.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { GIFPickerViewStore, LocaleStore, RestAPI, useCallback, useEffect, useRef, useState } from "@webpack/common";
import type { ComponentType, MouseEvent, ReactNode } from "react";

import { LoadedCache, LruCache } from "./cache";
import { KlipyResolver } from "./klipy";
import { BoundedSet, isKlipyUrl, isVideoUrl, klipyFavoriteFormats, lowResMediaFormat, normalizeUrl, Quality, rewriteUrl, stillUrl } from "./lowres";
import { LoadQueue, Ticket } from "./queue";
import managedStyle from "./styles.css?managed";

const logger = new Logger("GifPickerOptimizer");
const cl = classNameFactory("vc-gpo-");

const settings = definePluginSettings({
    quality: {
        type: OptionType.SELECT,
        description: "Resolution of the previews shown in the GIF picker. The GIF you send is always full resolution.",
        options: [
            { label: "XS (smallest, fastest)", value: "xs" },
            { label: "S", value: "s", default: true },
            { label: "SD", value: "sd" },
            { label: "Original (don't downscale)", value: "original" },
        ],
    },
    sequential: {
        type: OptionType.BOOLEAN,
        description: "Load GIFs one after another (left to right, top to bottom) instead of all at once",
        default: true,
    },
    concurrency: {
        type: OptionType.SLIDER,
        description: "How many GIFs may load at the same time when sequential loading is on",
        markers: makeRange(1, 6, 1),
        default: 3,
        stickToMarkers: true,
    },
    prioritizeVisible: {
        type: OptionType.BOOLEAN,
        description: "Load GIFs that are on screen before ones you scrolled past",
        default: true,
    },
    loadTimeout: {
        type: OptionType.SLIDER,
        description: "Seconds to wait for a slow GIF before moving on to the next one (it keeps loading in the background)",
        markers: [3, 5, 8, 10, 15, 20, 30],
        default: 10,
        stickToMarkers: true,
    },
    showProgress: {
        type: OptionType.BOOLEAN,
        description: "Show a loading / progress indicator on GIFs that haven't loaded yet",
        default: true,
    },
    klipyLookup: {
        type: OptionType.BOOLEAN,
        description: "Ask Discord's GIF API for the small Klipy renditions (one extra request per search page). Needed for XS/S on Klipy results.",
        default: true,
    },
    unloadOffscreen: {
        type: OptionType.BOOLEAN,
        description: "Unload GIFs you scrolled far away from to free memory. They come back from cache when you scroll back.",
        default: true,
    },
    offscreenMargin: {
        type: OptionType.SLIDER,
        description: "How far (px) above and below the visible area GIFs stay loaded",
        markers: [200, 400, 800, 1200, 2000],
        default: 800,
        stickToMarkers: true,
    },
    cacheSize: {
        type: OptionType.SLIDER,
        description: "How many loaded GIFs to remember, so they show instantly when you scroll back to them",
        markers: [300, 1000, 3000],
        default: 1000,
        stickToMarkers: true,
    },
    stillFavorites: {
        type: OptionType.BOOLEAN,
        description: "Show still images instead of playing GIFs in the favourites tab. Sent GIFs still animate.",
        default: false,
    },
    favoritesOnly: {
        type: OptionType.BOOLEAN,
        description: "Hide Trending GIFs and the other featured categories. The picker's main page keeps search and the Favorites category.",
        default: false,
    },
});

/* -------------------------------------------------------------------------- */
/*                         Low resolution URL lookup                          */
/* -------------------------------------------------------------------------- */

const queue = new LoadQueue();
/** URLs that finished loading. Scrolled-back tiles with a cached URL skip the queue. */
const loaded = new LoadedCache(1000);
/** Preview URLs that failed, never tried again */
const failed = new BoundedSet<string>(600);
/** `${quality}:${id|url}` -> low resolution URL from Discord's GIF API */
// Only the current results page needs these: 1200 entries is about 12 pages (id + url keys)
const apiPreviews = new LruCache<string, string>(1200);
/** Stable empty list, so memoized category data doesn't change on every render */
const NO_CATEGORIES: never[] = [];
/** Looks up small versions of Klipy favourites */
const KLIPY_STORE_KEY = "GifPickerOptimizer_klipyPreviews";
let klipy: KlipyResolver | undefined;

/** Tickets that were cancelled; a lookup that finishes later must not start them */
const dropped = new WeakSet<Ticket>();
function drop(t: Ticket | null) {
    if (!t) return;
    dropped.add(t);
    queue.cancel(t);
}

/**
 * First frames captured for still favourites, by URL. Frames are decoded
 * bitmaps (4 bytes per pixel), so they're captured at tile size and limited by
 * bytes: 24 MB is about 150 tiles at 1x, or 40 at 2x.
 */
const FRAME_BUDGET_BYTES = 24 * 1024 * 1024;
const frames = new LruCache<string, ImageBitmap | HTMLCanvasElement>(
    FRAME_BUDGET_BYTES,
    (_, frame) => {
        if ("close" in frame) frame.close();
        else frame.width = frame.height = 0;
    },
    frame => frame.width * frame.height * 4,
);

interface GifItem {
    id?: string;
    url?: string;
    src: string;
    gif_src?: string;
    width?: number;
    height?: number;
    /** only favourites have this (their position in the favourites list) */
    order?: number;
}

function quality() {
    return settings.store.quality as Quality;
}

async function lookupLowRes(event: { query?: string; items?: GifItem[]; }) {
    const q = quality();
    if (!settings.store.klipyLookup || q === "original") return;

    const items = event.items ?? [];
    const missing = items.some(i => i?.src && isKlipyUrl(i.src) && !apiPreviews.has(`${q}:${i.id ?? i.url}`));
    if (!missing) return;

    const format = lowResMediaFormat(GIFPickerViewStore.getSelectedFormat(), q);
    if (!format) return;

    // Hold the queue so tiles don't start loading the full resolution file meanwhile
    const release = queue.block(3000);
    try {
        const isSearch = typeof event.query === "string";
        const res = await RestAPI.get({
            url: isSearch ? "/gifs/search" : "/gifs/trending-gifs",
            query: {
                ...(isSearch ? { q: event.query } : {}),
                media_format: format,
                locale: LocaleStore.locale,
                limit: items.length,
            },
            oldFormErrors: true,
        });

        for (const r of (res?.body ?? []) as GifItem[]) {
            if (!r?.src) continue;
            const low = normalizeUrl(r.src);
            if (r.id != null) apiPreviews.set(`${q}:${r.id}`, low);
            if (r.url != null) apiPreviews.set(`${q}:${r.url}`, low);
        }
    } catch (e) {
        logger.warn(`Couldn't fetch low resolution Klipy previews (media_format=${format})`, e);
    } finally {
        release();
    }
}

/** media_formats to look a Klipy favourite up with, or null when it doesn't need a lookup */
function klipyFormats(item: GifItem, src: string): string[] | null {
    const q = quality();
    if (!klipy || !settings.store.klipyLookup || q === "original") return null;
    if (apiPreviews.has(`${q}:${item.id}`) || apiPreviews.has(`${q}:${item.url}`)) return null;
    if (!isKlipyUrl(src) || !klipy.canResolve(item.url)) return null;
    const formats = klipyFavoriteFormats(isVideoUrl(src), GIFPickerViewStore.getSelectedFormat(), q);
    return formats.length ? formats : null;
}

/** A pending lookup for `item`, or null when its preview URL is already known */
function klipyLookupFor(item: GifItem, src: string): Promise<unknown> | null {
    const formats = klipyFormats(item, src);
    if (!formats || klipy!.peek(item.url, formats) !== undefined) return null;
    return klipy!.resolve(item.url!, formats);
}

/** The URL a tile should display. Never changes what gets sent. */
function pickSrc(item: GifItem, src: string): string {
    const original = normalizeUrl(src);
    const q = quality();
    if (q === "original") return original;

    const formats = klipyFormats(item, src);
    const low = apiPreviews.get(`${q}:${item.id}`)
        ?? apiPreviews.get(`${q}:${item.url}`)
        ?? (formats && klipy!.peek(item.url, formats))
        ?? rewriteUrl(original, q, item);

    if (!low || low === original || failed.has(low)) return original;
    // Must stay the same media type or the picker would render it with the wrong element
    if (isVideoUrl(low) !== isVideoUrl(original)) return original;
    return low;
}

interface StillSource {
    url: string;
    /** true when `url` is animated and the first frame has to be captured locally */
    capture: boolean;
}

/** What a still favourite shows: a still rendition if the source has one, else a frame of the preview */
function pickStill(item: GifItem, src: string): StillSource {
    const frame = stillUrl(normalizeUrl(src), quality(), item);
    if (frame && !failed.has(frame)) return { url: frame, capture: false };
    return { url: pickSrc(item, src), capture: true };
}

function isFavorites(resultType: unknown, item: GifItem) {
    if (typeof resultType === "string" && /favou?rite/i.test(resultType)) return true;
    // Favourites come from the frecency settings: they have an `order` and no `id`
    return typeof item.order === "number" && item.id == null;
}

/* -------------------------------------------------------------------------- */
/*                               Visibility                                   */
/* -------------------------------------------------------------------------- */

/** element -> its scrolling ancestor (or null for the window). Every node on the way is cached too. */
const scrollerOf = new WeakMap<Element, Element | null>();

function findScroller(el: Element): Element | null {
    const path: Element[] = [];
    let found: Element | null = null;
    for (let n = el.parentElement; n; n = n.parentElement) {
        if (scrollerOf.has(n)) {
            found = scrollerOf.get(n)!;
            break;
        }
        path.push(n);
        const { overflowY } = getComputedStyle(n);
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
            found = n;
            break;
        }
    }
    for (const n of path) scrollerOf.set(n, found);
    return found;
}

/**
 * IntersectionObservers rooted on the picker's own scroller. Rooted on the window,
 * `rootMargin` would do nothing, because the scroller clips the tiles first.
 */
class ViewportWatcher {
    private observers = new Map<string, { root: Element | null; io: IntersectionObserver; }>();
    private callbacks = new Map<Element, (isIntersecting: boolean) => void>();
    private observerOf = new Map<Element, IntersectionObserver>();
    private rootIds = new WeakMap<Element, number>();
    private nextRootId = 1;

    constructor(private margin: () => number) { }

    observe(el: Element, cb: (isIntersecting: boolean) => void) {
        const root = findScroller(el);
        const margin = this.margin();
        let rootId = 0;
        if (root) {
            rootId = this.rootIds.get(root) ?? this.nextRootId++;
            this.rootIds.set(root, rootId);
        }
        const key = `${rootId}:${margin}`;

        let entry = this.observers.get(key);
        if (!entry) {
            const io = new IntersectionObserver(entries => {
                for (const e of entries) this.callbacks.get(e.target)?.(e.isIntersecting);
            }, { root, rootMargin: `${margin}px 0px` });
            entry = { root, io };
            this.observers.set(key, entry);
        }

        this.callbacks.set(el, cb);
        this.observerOf.set(el, entry.io);
        entry.io.observe(el);
    }

    unobserve(el: Element) {
        this.callbacks.delete(el);
        this.observerOf.get(el)?.unobserve(el);
        this.observerOf.delete(el);
    }

    disconnect() {
        for (const { io } of this.observers.values()) io.disconnect();
        this.observers.clear();
        this.callbacks.clear();
        this.observerOf.clear();
    }
}

/** "On screen" for the load queue's priority */
const visibleWatcher = new ViewportWatcher(() => 50);
/** "Near the screen": tiles outside of this are unloaded */
const nearWatcher = new ViewportWatcher(() => settings.store.offscreenMargin);

/**
 * Watches whichever element the ref is attached to (the placeholder, the still
 * tile, or a sentinel inside Discord's tile) and reports whether it's near the screen.
 */
function useViewport(onVisible: (visible: boolean) => void) {
    const [near, setNear] = useState(true);
    const elRef = useRef<Element | null>(null);
    const cb = useRef(onVisible);
    cb.current = onVisible;

    const ref = useCallback((el: Element | null) => {
        if (elRef.current === el) return;
        if (elRef.current) {
            visibleWatcher.unobserve(elRef.current);
            nearWatcher.unobserve(elRef.current);
        }
        elRef.current = el;
        if (el) {
            visibleWatcher.observe(el, v => cb.current(v));
            nearWatcher.observe(el, setNear);
        }
    }, []);

    return [ref, near] as const;
}

/* -------------------------------------------------------------------------- */
/*                                  UI                                        */
/* -------------------------------------------------------------------------- */

const RING_R = 11;
const RING_C = 2 * Math.PI * RING_R;

function Indicator({ state, progress }: { state: "queued" | "loading"; progress?: number | null; }) {
    const determinate = state === "loading" && progress != null;
    return (
        <div className={cl("indicator", `indicator-${state}`)} aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" className={cl("ring", { "ring-spin": state === "loading" && !determinate })}>
                <circle className={cl("track")} cx="14" cy="14" r={RING_R} />
                {state === "loading" && (
                    <circle
                        className={cl("bar")}
                        cx="14"
                        cy="14"
                        r={RING_R}
                        strokeDasharray={RING_C}
                        strokeDashoffset={determinate ? RING_C * (1 - Math.min(1, Math.max(0, progress!))) : RING_C * 0.72}
                    />
                )}
            </svg>
            {determinate && <span className={cl("pct")}>{Math.round(progress! * 100)}%</span>}
        </div>
    );
}

interface WatcherProps {
    src: string;
    video: boolean;
    showProgress: boolean;
    onDone(): void;
    onError(): void;
}

/**
 * Rendered inside Discord's GIF tile (through renderExtras). Watches the tile's
 * <video>/<img> for load events and draws the progress overlay.
 */
function LoadOverlay({ src, video, showProgress, onDone, onError }: WatcherProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const cbs = useRef({ onDone, onError });
    cbs.current = { onDone, onError };

    useEffect(() => {
        const root = ref.current?.parentElement;
        if (!root) return;

        let finished = false;
        const finish = (ok: boolean) => {
            if (finished) return;
            finished = true;
            ok ? cbs.current.onDone() : cbs.current.onError();
        };

        const reportBuffered = (v: HTMLVideoElement) => {
            if (!(v.duration > 0) || !v.buffered.length) return;
            const p = v.buffered.end(v.buffered.length - 1) / v.duration;
            setProgress(p);
            if (p >= 0.999) finish(true);
        };

        const onMedia = (e: Event) => {
            const v = e.target;
            if (!(v instanceof HTMLVideoElement)) return;
            // Discord clears src when returning the element to its pool
            if (!v.getAttribute("src")) return;
            switch (e.type) {
                case "progress":
                case "loadedmetadata":
                case "durationchange":
                    reportBuffered(v);
                    break;
                case "canplaythrough":
                    setProgress(1);
                    finish(true);
                    break;
                case "error":
                    finish(false);
                    break;
            }
        };

        const events = ["progress", "loadedmetadata", "durationchange", "canplaythrough", "error"];
        let probe: HTMLImageElement | null = null;
        let check: ReturnType<typeof setTimeout> | undefined;

        if (video) {
            for (const ev of events) root.addEventListener(ev, onMedia, true);
            // The video may already be ready (cache) before we started listening
            check = setTimeout(() => {
                const v = root.querySelector("video");
                if (v?.getAttribute("src") && v.readyState >= 4) finish(true);
            }, 50);
        } else {
            // Discord preloads images on a detached <img>, so watch the same URL.
            // The browser shares the request, it isn't downloaded twice.
            probe = new Image();
            probe.onload = () => finish(true);
            probe.onerror = () => finish(false);
            probe.src = src;
        }

        return () => {
            finished = true;
            clearTimeout(check);
            for (const ev of events) root.removeEventListener(ev, onMedia, true);
            if (probe) probe.onload = probe.onerror = null;
        };
    }, [src, video]);

    return (
        <div ref={ref} className={cl("overlay")}>
            {showProgress && <Indicator state="loading" progress={progress} />}
        </div>
    );
}

/** Draws `frame` into `canvas` like `object-fit: cover` */
function drawCover(canvas: HTMLCanvasElement, frame: CanvasImageSource & { width: number; height: number; }) {
    const ctx = canvas.getContext("2d");
    if (!ctx || !frame.width || !frame.height) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round((rect.width || frame.width) * dpr));
    const ch = Math.max(1, Math.round((rect.height || frame.height) * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const scale = Math.max(cw / frame.width, ch / frame.height);
    const w = frame.width * scale;
    const h = frame.height * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(frame, (cw - w) / 2, (ch - h) / 2, w, h);
}

/**
 * Size to keep a `w`×`h` frame at so it still covers a `target` sized tile
 * (object-fit: cover) without upscaling. Null keeps the natural size.
 */
function coverSize(w: number, h: number, target?: { width: number; height: number; }) {
    if (!w || !h || !target?.width || !target?.height) return null;
    const scale = Math.min(1, Math.max(target.width / w, target.height / h));
    if (scale >= 1) return null;
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Loads `url` (image or video) and returns its first frame at about `target` size (device pixels), cached */
function captureFrame(url: string, video: boolean, signal: { cancelled: boolean; }, target?: { width: number; height: number; }): Promise<ImageBitmap | HTMLCanvasElement> {
    const cached = frames.get(url);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve, reject) => {
        const el = video ? document.createElement("video") : new Image();
        const cleanup = () => {
            el.onerror = null;
            if (el instanceof HTMLVideoElement) {
                el.onloadeddata = null;
                // Free the decoder right away
                el.removeAttribute("src");
                el.load();
            } else {
                el.onload = null;
            }
        };
        const ready = async () => {
            try {
                if (signal.cancelled) throw new Error("cancelled");
                const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
                const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
                const size = coverSize(w, h, target);
                let frame: ImageBitmap | HTMLCanvasElement;
                try {
                    frame = await createImageBitmap(el, size
                        ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "medium" }
                        : undefined);
                } catch {
                    // Fall back to copying the frame onto a canvas
                    frame = document.createElement("canvas");
                    frame.width = size?.width ?? w;
                    frame.height = size?.height ?? h;
                    frame.getContext("2d")!.drawImage(el, 0, 0, frame.width, frame.height);
                }
                frames.set(url, frame);
                resolve(frame);
            } catch (e) {
                reject(e);
            } finally {
                cleanup();
            }
        };

        el.onerror = () => {
            cleanup();
            reject(new Error(`Couldn't load ${url}`));
        };
        if (el instanceof HTMLVideoElement) {
            el.muted = true;
            el.preload = "auto";
            el.onloadeddata = ready;
        } else {
            el.decoding = "async";
            el.onload = ready;
        }
        el.src = url;
    });
}

interface StillTileProps {
    viewRef(el: Element | null): void;
    source: StillSource;
    video: boolean;
    loading: boolean;
    showProgress: boolean;
    coords: ResultProps["coords"];
    onClick(e: MouseEvent): void;
    onContextMenu(e: MouseEvent): void;
    extras: ReactNode;
    onDone(): void;
    onError(): void;
}

/** A favourite shown as a still image instead of Discord's (animated) tile */
function StillTile({ viewRef, source, video, loading, showProgress, coords, onClick, onContextMenu, extras, onDone, onError }: StillTileProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cbs = useRef({ onDone, onError });
    cbs.current = { onDone, onError };

    useEffect(() => {
        if (!source.capture) return;
        const signal = { cancelled: false };
        const rect = canvasRef.current?.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const target = rect && rect.width > 0 && rect.height > 0
            ? { width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) }
            : undefined;
        captureFrame(source.url, video, signal, target).then(
            frame => {
                if (signal.cancelled) return;
                if (canvasRef.current) drawCover(canvasRef.current, frame);
                cbs.current.onDone();
            },
            () => !signal.cancelled && cbs.current.onError(),
        );
        return () => void (signal.cancelled = true);
    }, [source.url, source.capture, video]);

    return (
        <div
            ref={viewRef}
            className={cl("tile", "tile-still")}
            style={coords}
            onClick={onClick}
            onContextMenu={onContextMenu}
        >
            {source.capture
                ? <canvas ref={canvasRef} className={cl("still-media")} />
                : (
                    <img
                        className={cl("still-media")}
                        src={source.url}
                        alt=""
                        draggable={false}
                        decoding="async"
                        onLoad={() => cbs.current.onDone()}
                        onError={() => cbs.current.onError()}
                    />
                )}
            {loading && showProgress && <Indicator state="loading" />}
            {extras}
        </div>
    );
}

/** resolving: looking up the small Klipy URL before loading */
type Phase = "queued" | "resolving" | "loading" | "done";

interface ResultProps {
    Result: ComponentType<any>;
    resultType?: unknown;
    item: GifItem;
    index: number;
    src: string;
    format?: number;
    coords: { top?: number; left?: number; width: number; height: number; [k: string]: any; };
    onClick?(item: GifItem, index: number, opts: { shiftKey: boolean; }): void;
    onContextMenu?(e: MouseEvent, item: GifItem): void;
    renderExtras?(item: GifItem): ReactNode;
    [k: string]: any;
}

// GIFType.VIDEO in Discord's frecency protobuf
const GIF_TYPE_VIDEO = 2;

function SequentialResultInner(props: ResultProps) {
    const { Result, resultType, ...rest } = props;
    const { item, src, coords } = rest;
    const {
        sequential, concurrency, prioritizeVisible, loadTimeout, showProgress,
        unloadOffscreen, cacheSize, stillFavorites,
    } = settings.use([
        "sequential", "concurrency", "prioritizeVisible", "loadTimeout", "showProgress", "quality",
        "unloadOffscreen", "offscreenMargin", "cacheSize", "stillFavorites",
    ]);
    if (loaded.max !== cacheSize) loaded.resize(cacheSize);

    const still = stillFavorites && isFavorites(resultType, item);
    /** The URL this tile shows, for the current mode */
    const pick = () => still ? pickStill(item, src).url : pickSrc(item, src);

    const indexRef = useRef(rest.index);
    indexRef.current = rest.index;
    const ticketRef = useRef<Ticket | null>(null);
    const visibleRef = useRef(false);

    const [chosen, setChosen] = useState<string | null>(() => {
        const p = pick();
        return loaded.hit(p) ? p : null;
    });
    const [phase, setPhase] = useState<Phase>(() => chosen ? "done" : "queued");

    const [viewRef, near] = useViewport(visible => {
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
        const cached = pick();
        if (loaded.hit(cached)) {
            setChosen(cached);
            setPhase("done");
            return;
        }

        queue.concurrency = sequential ? concurrency : 64;
        queue.prioritizeVisible = prioritizeVisible;

        let started = false;
        const begin = () => {
            const p = pick();
            setChosen(p);
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
                const lookup = klipyLookupFor(item, src);
                if (!lookup) return begin();
                setPhase("resolving");
                lookup.then(() => !dropped.has(ticket) && begin());
            },
        };
        ticketRef.current = ticket;
        queue.enqueue(ticket);

        // Once started, the slot is freed by finishing, parking or unmounting instead
        return () => {
            if (!started) drop(ticket);
        };
    }, [phase, parked, still]);

    // Scrolled far away while loading: stop, free the slot, and queue again when it comes back
    useEffect(() => {
        if (!parked || (phase !== "loading" && phase !== "resolving")) return;
        drop(ticketRef.current);
        setPhase("queued");
    }, [parked, phase]);

    // The still favourites setting changed: pick the URL again
    const stillRef = useRef(still);
    useEffect(() => {
        if (stillRef.current === still) return;
        stillRef.current = still;
        drop(ticketRef.current);
        setChosen(null);
        setPhase("queued");
    }, [still]);

    // Release the slot after the timeout so one slow GIF doesn't hold everything up
    useEffect(() => {
        if (phase !== "loading" && phase !== "resolving") return;
        const t = setTimeout(() => ticketRef.current && queue.finish(ticketRef.current), loadTimeout * 1000);
        return () => clearTimeout(t);
    }, [phase, chosen]);

    // Unmounted while loading: free the slot
    useEffect(() => () => drop(ticketRef.current), []);

    const original = normalizeUrl(src);

    const onDone = () => {
        if (chosen) loaded.mark(chosen);
        if (phase !== "loading") return;
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    const onError = () => {
        if (chosen && chosen !== original) {
            // Still / preview not available: try the next best one, then the original
            failed.add(chosen);
            const next = pick();
            setChosen(next !== chosen ? next : original);
            return;
        }
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    const click = (e: MouseEvent) => rest.onClick?.(item, rest.index, { shiftKey: e.shiftKey });
    const contextMenu = (e: MouseEvent) => rest.onContextMenu?.(e, item);

    // Waiting for its turn, being looked up, or unloaded because it's far off screen
    if (phase === "queued" || phase === "resolving" || parked) {
        return (
            <div
                ref={viewRef}
                className={cl("tile", { "tile-parked": parked })}
                style={coords}
                onClick={click}
                onContextMenu={contextMenu}
            >
                {showProgress && !parked && <Indicator state={phase === "resolving" ? "loading" : "queued"} />}
                {rest.renderExtras?.(item)}
            </div>
        );
    }

    const shown = chosen ?? original;

    if (still) {
        // A ready-made still image is shown as is. Anything else is animated: capture its first frame.
        const source: StillSource = { url: shown, capture: stillUrl(original, quality(), item) !== shown };
        return (
            <StillTile
                key={shown}
                viewRef={viewRef}
                source={source}
                video={source.capture && (rest.format === GIF_TYPE_VIDEO || isVideoUrl(shown))}
                loading={phase === "loading"}
                showProgress={showProgress}
                coords={coords}
                onClick={click}
                onContextMenu={contextMenu}
                extras={rest.renderExtras?.(item)}
                onDone={onDone}
                onError={onError}
            />
        );
    }

    const video = rest.format === GIF_TYPE_VIDEO || isVideoUrl(shown);

    return (
        <Result
            key={shown}
            {...rest}
            src={shown}
            renderExtras={(it: GifItem) => (
                <>
                    {rest.renderExtras?.(it)}
                    {/* Fills the tile, so the viewport watcher can see Discord's tile */}
                    <div ref={viewRef} className={cl("sentinel")} aria-hidden="true" />
                    {phase === "loading" && (
                        <LoadOverlay
                            src={shown}
                            video={video}
                            showProgress={showProgress}
                            onDone={onDone}
                            onError={onError}
                        />
                    )}
                </>
            )}
        />
    );
}

const SequentialResult = ErrorBoundary.wrap(SequentialResultInner, {
    // If anything goes wrong, render Discord's own tile untouched
    fallback: ({ wrappedProps: { Result, resultType, ...props } }) => <Result {...props} />,
    displayName: "GifPickerOptimizerResult",
});

export default definePlugin({
    name: "GifPickerOptimizer",
    description: "Loads GIF picker results one by one with a progress indicator, using low resolution previews while still sending the full resolution GIF. Unloads off-screen GIFs and can show favourites as still images.",
    authors: [{ name: "thatkerimguy", id: 0n }],
    settings,
    managedStyle,

    patches: [
        {
            // GIF picker results list (masonry of GIF tiles)
            find: "renderEmptyFavorite",
            replacement: {
                match: /(\(0,\i\.jsx\)\()(\i),\{(?=item:(\i),index:\i,format:\3\.format,src:\3\.src)/,
                replace: "$1$self.SequentialResult,{Result:$2,resultType:this?.props?.resultType,",
            },
        },
        {
            // GIF picker main page (categories grid): the Favorites tile plus Trending
            // GIFs and the featured categories. "Favourites only" keeps just the
            // Favorites tile, and skips fetching the others.
            find: "hideFavoritesTile:",
            replacement: [
                {
                    // Don't fetch trending categories on mount
                    match: /0===this\.props\.trendingCategories\.length&&/,
                    replace: "$self.needsCategories(this.props.trendingCategories)&&",
                },
                {
                    // The tiles: [favorites, ...trendingCategories]
                    match: /(this\.memoizedData\(this\.state\.favoritesTile,)this\.props\.trendingCategories/,
                    replace: "$1$self.featured(this.props.trendingCategories)",
                },
                {
                    // Shows a loading skeleton while there are no trending categories
                    match: /(trendingCategories:(\i)\}=this\.props;return )0===\2\.length/,
                    replace: "$1$self.needsCategories($2)",
                },
            ],
        },
    ],

    flux: {
        GIF_PICKER_QUERY_SUCCESS(event: { query?: string; items?: GifItem[]; }) {
            lookupLowRes(event);
        },
    },

    SequentialResult,

    /** Featured categories shown on the picker's main page (none with "Favourites only") */
    featured<T>(categories: T[]): T[] {
        return settings.store.favoritesOnly ? NO_CATEGORIES : categories;
    },

    /** Whether the main page still has to fetch (and wait for) featured categories */
    needsCategories(categories: unknown[] | undefined): boolean {
        return !settings.store.favoritesOnly && (categories?.length ?? 0) === 0;
    },

    start() {
        loaded.resize(settings.store.cacheSize);
        klipy = new KlipyResolver({
            async search(q, format, limit) {
                const res = await RestAPI.get({
                    url: "/gifs/search",
                    query: { q, media_format: format, locale: LocaleStore.locale, limit },
                    oldFormErrors: true,
                });
                return Array.isArray(res?.body) ? res.body : [];
            },
            load: () => DataStore.get<Record<string, string>>(KLIPY_STORE_KEY),
            save: entries => void DataStore.set(KLIPY_STORE_KEY, entries),
            onError: e => logger.warn("Klipy favourite lookup failed", e),
        });
    },

    stop() {
        klipy?.flush();
        klipy = undefined;
        visibleWatcher.disconnect();
        nearWatcher.disconnect();
        loaded.clear();
        frames.clear();
    },
});
