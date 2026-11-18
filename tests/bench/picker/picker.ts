/*
 * GIF picker simulation, run in a real browser (desktop or a phone's Chrome).
 * One run = one picker opening: a masonry grid of real GIFs in a scroll box.
 *
 *   discord:  every mounted tile starts its full src at once (what Discord does)
 *   gifs-s / gifs-xs: the plugin's own LoadQueue (visible first, n at a time)
 *             with previews from its own rewriteUrl
 *
 * Desktop tiles are <video> (mp4, done on canplay, like Discord's tile); mobile
 * tiles are animated webp <img> (done on load). Every URL gets a per-run query
 * so each run starts with a cold browser cache, like a first opening.
 */

import { LoadQueue, type Ticket } from "../../../vencord/gifPickerOptimizer/queue";
import { type Quality, rewriteUrl } from "../../../vencord/gifPickerOptimizer/lowres";

interface Item { source: string; desktop: string; mobile: string; }
export interface RunOptions {
    mode: "desktop" | "mobile";
    strategy: "discord" | "gifs-s" | "gifs-xs";
    count: number;
    seed: number;
    nonce: string;
    concurrency: number;
    timeoutMs: number;
    capMs: number;
}

/** Same rule as loadConcurrency() in settings.tsx (Auto) */
export function autoConcurrency(): number {
    const c = (navigator as any).connection;
    if (!c) return 3;
    if (c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType)) return 2;
    if (c.effectiveType === "4g" && c.downlink >= 5) return 6;
    if (c.downlink >= 2) return 4;
    return 3;
}

function rng(seed: number) {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
}

export async function run(items: Item[], o: RunOptions, host: HTMLElement) {
    const rand = rng(o.seed);
    const picked = [...items].sort(() => rand() - 0.5).slice(0, o.count);

    const desktop = o.mode === "desktop";
    const width = desktop ? 424 : Math.min(host.clientWidth, 480);
    const height = desktop ? 440 : Math.round(Math.min(window.innerHeight * 0.55, 520));
    const cols = desktop ? 3 : 2;
    const gap = 4;
    const colW = (width - gap * (cols + 1)) / cols;

    const box = document.createElement("div");
    box.style.cssText = `position:relative;overflow-y:auto;width:${width}px;height:${height}px;background:#2b2d31`;
    const inner = document.createElement("div");
    inner.style.position = "relative";
    box.append(inner);
    host.replaceChildren(box);

    // Masonry: each item goes into the shortest column, in index order
    const colH = new Array(cols).fill(gap);
    const tiles = picked.map((item, index) => {
        const aspect = 0.6 + rand();
        const c = colH.indexOf(Math.min(...colH));
        const top = colH[c];
        const h = Math.round(colW / aspect);
        colH[c] += h + gap;
        const el = document.createElement("div");
        el.style.cssText = `position:absolute;left:${gap + c * (colW + gap)}px;top:${top}px;width:${colW}px;height:${h}px;background:#383a40;overflow:hidden`;
        inner.append(el);
        const original = desktop ? item.desktop : item.mobile;
        return { index, el, original, top, h, visible: top < height + 50, start: 0, done: 0, url: "", ok: false };
    });
    inner.style.height = `${Math.max(...colH)}px`;

    const t0 = performance.now();
    const visibleAtOpen = tiles.filter(t => t.visible);

    // Frame pacing while loading
    const frames: number[] = [];
    let last = t0, rafOn = true;
    const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const longTasks: number[] = [];
    let lto: PerformanceObserver | undefined;
    try {
        lto = new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push(e.duration); });
        lto.observe({ type: "longtask", buffered: false } as any);
    } catch { }

    const quality: Quality | null = o.strategy === "gifs-s" ? "s" : o.strategy === "gifs-xs" ? "xs" : null;
    const queue = new LoadQueue();
    queue.concurrency = o.concurrency;
    queue.prioritizeVisible = true;

    let remaining = tiles.length;
    let finishAll!: () => void;
    const allDone = new Promise<void>(r => (finishAll = r));

    function load(tile: (typeof tiles)[number], ticket?: Ticket) {
        const preview = quality ? rewriteUrl(tile.original, quality, undefined, { imagesOnly: !desktop }) : null;
        const url = (preview ?? tile.original) + (/\?/.test(preview ?? tile.original) ? "&" : "?") + "b=" + o.nonce;
        tile.url = url;
        tile.start = performance.now() - t0;
        let settled = false;
        const timer = ticket && setTimeout(() => queue.release(ticket), o.timeoutMs);
        const end = (ok: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            tile.ok = ok;
            tile.done = performance.now() - t0;
            if (ticket) queue.finish(ticket, tile.done - tile.start);
            if (--remaining === 0) finishAll();
        };
        if (desktop) {
            const v = document.createElement("video");
            v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.preload = "auto";
            v.style.cssText = "width:100%;height:100%;object-fit:cover";
            v.oncanplay = () => end(true);
            v.onerror = () => end(false);
            v.src = url;
            tile.el.append(v);
        } else {
            const img = new Image();
            img.style.cssText = "width:100%;height:100%;object-fit:cover";
            img.onload = () => end(true);
            img.onerror = () => end(false);
            img.src = url;
            tile.el.append(img);
        }
    }

    if (!quality) {
        for (const t of tiles) load(t);
    } else {
        const io = new IntersectionObserver(entries => {
            for (const e of entries) {
                const t = tiles.find(x => x.el === e.target)!;
                if (t.visible !== e.isIntersecting) {
                    t.visible = e.isIntersecting;
                    queue.kick();
                }
            }
        }, { root: box, rootMargin: "50px" });
        for (const t of tiles) {
            io.observe(t.el);
            const ticket: Ticket = {
                order: () => t.index,
                get visible() { return t.visible; },
                start: () => load(t, ticket),
            };
            queue.enqueue(ticket);
        }
    }

    await Promise.race([allDone, new Promise(r => setTimeout(r, o.capMs))]);
    rafOn = false;
    lto?.disconnect();

    const at = (ts: typeof tiles) => ts.filter(t => t.ok).map(t => t.done);
    const sizes: Record<string, number> = (window as any).BENCH_SIZES ?? {};
    const bytesOf = (t: (typeof tiles)[number]) => {
        const e = performance.getEntriesByName(t.url)[0] as PerformanceResourceTiming | undefined;
        return e?.encodedBodySize || sizes[t.url.replace(/[?&]b=[^&]*$/, "")] || 0;
    };
    const sorted = [...frames].sort((a, b) => a - b);
    const result = {
        ...o,
        ua: navigator.userAgent,
        connection: (() => { const c = (navigator as any).connection; return c ? { type: c.effectiveType, downlink: c.downlink, rtt: c.rtt } : null; })(),
        tiles: tiles.length,
        visibleAtOpen: visibleAtOpen.length,
        failed: tiles.filter(t => t.done && !t.ok).length,
        unfinished: tiles.filter(t => !t.done).length,
        firstVisibleMs: Math.round(Math.min(...at(visibleAtOpen))),
        allVisibleMs: visibleAtOpen.every(t => t.ok) ? Math.round(Math.max(...at(visibleAtOpen))) : null,
        /** Mean time until each visible tile showed: lower = the screen fills sooner */
        meanVisibleMs: Math.round(at(visibleAtOpen).reduce((a, b) => a + b, 0) / Math.max(1, at(visibleAtOpen).length)),
        allMs: remaining === 0 ? Math.round(Math.max(...at(tiles))) : null,
        visibleBytes: visibleAtOpen.reduce((a, t) => a + bytesOf(t), 0),
        totalBytes: tiles.reduce((a, t) => a + bytesOf(t), 0),
        frames: frames.length,
        jankFrames: frames.filter(f => f > 50).length,
        p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        longTasks: longTasks.length,
        longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
        perTile: tiles.map(t => ({ i: t.index, v: t.top < height + 50, s: Math.round(t.start), d: Math.round(t.done), ok: t.ok })),
    };
    host.replaceChildren();
    return result;
}
