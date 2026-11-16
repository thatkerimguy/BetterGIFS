/*
 * GifPickerOptimizer for Raincord (rain)
 *
 * - Loads GIF picker results one at a time, in reading order (left to right,
 *   top to bottom), waiting for each one to finish before starting the next.
 * - Shows a loading / progress indicator on tiles that are still empty.
 * - Shows a lower resolution preview in the picker (XS / S / SD) while still
 *   sending and favouriting the original, full resolution GIF.
 */

import { intercept } from "@api/flux";
import { instead } from "@api/patcher";
import { waitForHydration } from "@api/storage";
import { logger } from "@lib/utils/logger";
import { findByProps, findByStoreName } from "@metro";
import { findByFilePathLazy } from "@metro/wrappers";
import { definePlugin } from "@plugins";
import { isValidElement, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { BoundedSet, isKlipyUrl, isVideoUrl, lowResMediaFormat, normalizeUrl, Quality, rewriteUrl } from "./lowres";
import { LoadQueue, Ticket } from "./queue";
import GifPickerOptimizerSettings from "./settings";
import { gpoSettings, useGifPickerOptimizerSettings } from "./storage";

const TAG = "[GifPickerOptimizer]";

const GIFPickerItemView = findByFilePathLazy("modules/gif_picker/native/GIFPickerItemView.tsx");

const queue = new LoadQueue();
const loaded = new BoundedSet<string>(600);
const failed = new BoundedSet<string>(600);
const apiPreviews = new Map<string, string>();
const patches: (() => unknown)[] = [];

interface GifItem {
    id?: string;
    url?: string;
    src: string;
    width?: number;
    height?: number;
}

/* -------------------------------------------------------------------------- */
/*                         Low resolution URL lookup                          */
/* -------------------------------------------------------------------------- */

async function lookupLowRes(event: { query?: string; items?: GifItem[]; }) {
    const q = gpoSettings.quality;
    if (!gpoSettings.klipyLookup || q === "original") return;

    const items = event.items ?? [];
    if (!items.some(i => i?.src && isKlipyUrl(i.src) && !apiPreviews.has(`${q}:${i.id ?? i.url}`))) return;

    const PickerStore = findByStoreName("GIFPickerViewStore");
    const format = lowResMediaFormat(PickerStore?.getSelectedFormat?.() ?? "tinywebp", q);
    if (!format) return;

    const http = findByProps("HTTP", "get", "post", "put", "patch", "del")?.HTTP;
    if (!http) return;

    const release = queue.block(3000);
    try {
        const isSearch = typeof event.query === "string";
        const locale = findByStoreName("LocaleStore")?.locale;
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
        for (const r of (res?.body ?? []) as GifItem[]) {
            if (!r?.src) continue;
            const low = normalizeUrl(r.src);
            if (r.id != null) apiPreviews.set(`${q}:${r.id}`, low);
            if (r.url != null) apiPreviews.set(`${q}:${r.url}`, low);
        }
    } catch (e) {
        logger.warn(`${TAG} couldn't fetch low resolution Klipy previews (media_format=${format})`, e);
    } finally {
        release();
    }
}

function pickSrc(item: GifItem): string {
    const original = normalizeUrl(item.src);
    const q = gpoSettings.quality as Quality;
    if (q === "original") return original;

    const low = apiPreviews.get(`${q}:${item.id}`)
        ?? apiPreviews.get(`${q}:${item.url}`)
        ?? rewriteUrl(original, q, item);

    if (!low || low === original || failed.has(low)) return original;
    if (isVideoUrl(low) !== isVideoUrl(original)) return original;
    return low;
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

type Phase = "queued" | "loading" | "done";

interface ItemProps {
    item: GifItem;
    index: number;
    height: number;
    selected?: boolean;
    onPressGIF(item: GifItem, index: number): void;
}

function OptimizedItem({ props, render }: { props: ItemProps; render: (p: ItemProps) => any; }) {
    // Discord's own tile. Always rendered (it uses hooks) and with the original item,
    // so tapping sends and long-press favourites the full resolution GIF.
    const tree = render(props);

    const { item, index } = props;
    const { sequential, concurrency, loadTimeout, showProgress } = useGifPickerOptimizerSettings();

    const [chosen, setChosen] = useState<string | null>(() => {
        const p = pickSrc(item);
        return loaded.has(p) ? p : null;
    });
    const [phase, setPhase] = useState<Phase>(() => chosen ? "done" : "queued");
    const [progress, setProgress] = useState<number | null>(null);

    const ticketRef = useRef<Ticket | null>(null);
    const indexRef = useRef(index);
    indexRef.current = index;

    useEffect(() => {
        if (phase !== "queued") return;
        queue.concurrency = sequential ? concurrency : 64;
        // Discord only mounts tiles that have been on screen
        queue.prioritizeVisible = false;

        const ticket: Ticket = {
            visible: true,
            order: () => indexRef.current ?? 0,
            start: () => {
                const p = pickSrc(item);
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
        queue.enqueue(ticket);
        return () => queue.cancel(ticket);
    }, []);

    useEffect(() => {
        if (phase !== "loading") return;
        const t = setTimeout(() => ticketRef.current && queue.finish(ticketRef.current), loadTimeout * 1000);
        return () => clearTimeout(t);
    }, [phase, chosen]);

    const original = normalizeUrl(item.src);

    const done = () => {
        if (chosen) loaded.add(chosen);
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    const error = () => {
        if (chosen && chosen !== original) {
            failed.add(chosen);
            setProgress(null);
            setChosen(original);
            return;
        }
        if (ticketRef.current) queue.finish(ticketRef.current);
        setPhase("done");
    };

    const isImage = (n: any) => isValidElement(n) && normalizeUrl((n.props as any)?.source?.uri ?? "") === original;

    const [result, hit] = replaceInTree(tree, isImage, (img: any) => {
        const imgProps = img.props;

        if (phase === "queued") {
            return (
                <View style={[imgProps.style, styles.frame]}>
                    {showProgress && <Indicator state="queued" progress={null} />}
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
                },
                onError: (...a: any[]) => {
                    imgProps.onError?.(...a);
                    if (phase === "loading") error();
                },
                onProgress: (e: any) => {
                    imgProps.onProgress?.(e);
                    const ev = e?.nativeEvent ?? e;
                    if (ev?.total > 0) setProgress(ev.loaded / ev.total);
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
        if (!hit && ticketRef.current) queue.cancel(ticketRef.current);
    }, [hit]);

    return hit ? result : tree;
}

export default definePlugin({
    name: "GifPickerOptimizer",
    description: "Loads GIFs in the picker one by one with a progress indicator, using low resolution previews while still sending the full resolution GIF",
    author: [{ name: "GifPickerOptimizer", id: 0n }],
    id: "gifpickeroptimizer",
    version: "1.0.0",

    settings: GifPickerOptimizerSettings,

    async start() {
        await waitForHydration(useGifPickerOptimizerSettings);

        patches.push(intercept(payload => {
            if (payload.type === "GIF_PICKER_QUERY_SUCCESS") {
                lookupLowRes(payload as any).catch(() => { });
            }
            return undefined;
        }));

        try {
            patches.push(instead("default", GIFPickerItemView, (args: any[], orig: Function) => {
                const props = args[0] as ItemProps;
                if (!props?.item?.src) return orig(...args);
                return <OptimizedItem key={props.item.src} props={props} render={orig as (p: ItemProps) => any} />;
            }));
        } catch (e) {
            logger.error(`${TAG} failed to patch GIFPickerItemView`, e);
        }
    },

    stop() {
        for (const unpatch of patches) {
            try { unpatch(); } catch { }
        }
        patches.length = 0;
    },
});
