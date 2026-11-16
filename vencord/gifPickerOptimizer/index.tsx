/*
 * GifPickerOptimizer for Vencord
 *
 * - Loads GIF picker results one at a time, in reading order (left to right,
 *   top to bottom), waiting for each one to finish before starting the next.
 * - Shows a loading / progress indicator on tiles that are still empty.
 * - Shows a lower resolution preview in the picker (XS / S / SD) while still
 *   sending and favouriting the original, full resolution GIF.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@utils/css";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { GIFPickerViewStore, LocaleStore, RestAPI, useEffect, useRef, useState } from "@webpack/common";
import type { ComponentType, MouseEvent, ReactNode } from "react";

import { BoundedSet, isKlipyUrl, isVideoUrl, lowResMediaFormat, normalizeUrl, Quality, rewriteUrl } from "./lowres";
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
        default: 1,
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
});

/* -------------------------------------------------------------------------- */
/*                         Low resolution URL lookup                          */
/* -------------------------------------------------------------------------- */

const queue = new LoadQueue();
/** URLs that finished loading this session, shown instantly next time */
const loaded = new BoundedSet<string>(600);
/** Preview URLs that failed, never tried again */
const failed = new BoundedSet<string>(600);
/** `${quality}:${id|url}` -> low resolution URL from Discord's GIF API */
const apiPreviews = new Map<string, string>();

interface GifItem {
    id?: string;
    url?: string;
    src: string;
    gif_src?: string;
    width?: number;
    height?: number;
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

        if (apiPreviews.size > 3000) apiPreviews.clear();
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

/** The URL a tile should display. Never changes what gets sent. */
function pickSrc(item: GifItem, src: string): string {
    const original = normalizeUrl(src);
    const q = quality();
    if (q === "original") return original;

    const low = apiPreviews.get(`${q}:${item.id}`)
        ?? apiPreviews.get(`${q}:${item.url}`)
        ?? rewriteUrl(original, q, item);

    if (!low || low === original || failed.has(low)) return original;
    // Must stay the same media type or the picker would render it with the wrong element
    if (isVideoUrl(low) !== isVideoUrl(original)) return original;
    return low;
}

/* -------------------------------------------------------------------------- */
/*                               Visibility                                   */
/* -------------------------------------------------------------------------- */

const observed = new Map<Element, Ticket>();
let observer: IntersectionObserver | null = null;

function observe(el: Element, t: Ticket) {
    observer ??= new IntersectionObserver(entries => {
        let changed = false;
        for (const entry of entries) {
            const ticket = observed.get(entry.target);
            if (ticket && ticket.visible !== entry.isIntersecting) {
                ticket.visible = entry.isIntersecting;
                changed = true;
            }
        }
        if (changed) queue.kick();
    }, { rootMargin: "100px 0px" });

    observed.set(el, t);
    observer.observe(el);
}

function unobserve(el: Element | null) {
    if (!el) return;
    observed.delete(el);
    observer?.unobserve(el);
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

type Phase = "queued" | "loading" | "done";

interface ResultProps {
    Result: ComponentType<any>;
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
    const { Result, ...rest } = props;
    const { item, src, coords } = rest;
    const { sequential, concurrency, prioritizeVisible, loadTimeout, showProgress } = settings.use([
        "sequential", "concurrency", "prioritizeVisible", "loadTimeout", "showProgress", "quality",
    ]);

    const indexRef = useRef(rest.index);
    indexRef.current = rest.index;
    const elRef = useRef<HTMLDivElement>(null);
    const ticketRef = useRef<Ticket | null>(null);

    const [chosen, setChosen] = useState<string | null>(() => {
        const p = pickSrc(item, src);
        return loaded.has(p) ? p : null;
    });
    const [phase, setPhase] = useState<Phase>(() => chosen ? "done" : "queued");

    // Register in the load queue
    useEffect(() => {
        if (phase !== "queued") return;

        queue.concurrency = sequential ? concurrency : 64;
        queue.prioritizeVisible = prioritizeVisible;

        const el = elRef.current;
        const ticket: Ticket = {
            visible: false,
            order: () => indexRef.current ?? 0,
            start: () => {
                unobserve(el);
                const p = pickSrc(item, src);
                setChosen(p);
                if (loaded.has(p)) {
                    queue.finish(ticket);
                    setPhase("done");
                } else {
                    setPhase("loading");
                }
            },
        };
        ticketRef.current = ticket;
        if (el) observe(el, ticket);
        queue.enqueue(ticket);

        return () => {
            unobserve(el);
            queue.cancel(ticket);
        };
    }, []);

    // Release the slot after the timeout so one slow GIF doesn't hold everything up
    useEffect(() => {
        if (phase !== "loading") return;
        const t = setTimeout(() => ticketRef.current && queue.finish(ticketRef.current), loadTimeout * 1000);
        return () => clearTimeout(t);
    }, [phase, chosen]);

    // Unmounted while loading: free the slot
    useEffect(() => () => {
        if (ticketRef.current) queue.cancel(ticketRef.current);
    }, []);

    const original = normalizeUrl(src);

    const onDone = () => {
        if (chosen) loaded.add(chosen);
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    const onError = () => {
        if (chosen && chosen !== original) {
            // Preview not available, fall back to the original
            failed.add(chosen);
            setChosen(original);
            return;
        }
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    if (phase === "queued") {
        return (
            <div
                ref={elRef}
                className={cl("tile")}
                style={coords}
                onClick={e => rest.onClick?.(item, rest.index, { shiftKey: e.shiftKey })}
                onContextMenu={e => rest.onContextMenu?.(e, item)}
            >
                {showProgress && <Indicator state="queued" />}
                {rest.renderExtras?.(item)}
            </div>
        );
    }

    const shown = chosen ?? original;
    const video = rest.format === GIF_TYPE_VIDEO || isVideoUrl(shown);

    return (
        <Result
            key={shown}
            {...rest}
            src={shown}
            renderExtras={(it: GifItem) => (
                <>
                    {rest.renderExtras?.(it)}
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
    fallback: ({ wrappedProps: { Result, ...props } }) => <Result {...props} />,
    displayName: "GifPickerOptimizerResult",
});

export default definePlugin({
    name: "GifPickerOptimizer",
    description: "Loads GIF picker results one by one with a progress indicator, using low resolution previews while still sending the full resolution GIF",
    authors: [{ name: "GifPickerOptimizer", id: 0n }],
    settings,
    managedStyle,

    patches: [
        {
            // GIF picker results list (masonry of GIF tiles)
            find: "renderEmptyFavorite",
            replacement: {
                match: /(\(0,\i\.jsx\)\()(\i),\{(?=item:(\i),index:\i,format:\3\.format,src:\3\.src)/,
                replace: "$1$self.SequentialResult,{Result:$2,",
            },
        },
    ],

    flux: {
        GIF_PICKER_QUERY_SUCCESS(event: { query?: string; items?: GifItem[]; }) {
            lookupLowRes(event);
        },
    },

    SequentialResult,

    stop() {
        observer?.disconnect();
        observer = null;
        observed.clear();
    },
});
