/*
 * GIFs+ in-Discord probe (desktop). Paste into Discord's DevTools console
 * (Ctrl+Shift+I), then open the GIF picker and use it normally. Run it once with
 * GIFs+ on and once with it off (same steps, a search term you haven't used, so
 * the cache is cold), then compare.
 *
 *   gpBench.stop()   -> prints the summary and copies the JSON to the clipboard
 *
 * What it measures, with no knowledge of the plugin's internals:
 *   - time from the picker opening until the first GIF shows, and until every
 *     tile on screen shows ("screen full"), also after each scroll
 *   - GIF requests and bytes (bytes only where the host sends Timing-Allow-Origin)
 *   - frame pacing (frames over 50 ms) and long tasks while the picker is open
 */
(() => {
    window.gpBench?.stop?.(true);
    const GIF_HOST = /(tenor\.com|giphy\.com|klipy\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net|cdn\.discordapp\.com|twimg\.com)/;
    const T = () => performance.now();
    const st = {
        start: T(), open: null, first: null, screens: [], pending: null,
        frames: [], longTasks: [], requests: [], samples: [],
    };

    // Requests (entries arrive when a request ends)
    performance.setResourceTimingBufferSize(10000);
    const ro = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
            if (!GIF_HOST.test(e.name) || e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") continue;
            st.requests.push({ url: e.name, start: e.startTime, end: e.responseEnd, bytes: e.transferSize || e.encodedBodySize || 0 });
        }
    });
    ro.observe({ type: "resource", buffered: false });
    let lto;
    try { lto = new PerformanceObserver(l => { for (const e of l.getEntries()) if (st.open) st.longTasks.push(e.duration); }); lto.observe({ type: "longtask" }); } catch { }

    // Frames
    let last = T(), on = true;
    const raf = now => { if (st.open) st.frames.push(now - last); last = now; if (on) requestAnimationFrame(raf); };
    requestAnimationFrame(raf);

    // The picker: the scroll box that holds GIF media
    function scroller() {
        // A GIF tile (GIFs+ placeholder, or GIF media) inside something called a picker
        const m = document.querySelector(".vc-gpo-tile")
            ?? [...document.querySelectorAll("video, img")].find(e => GIF_HOST.test(e.currentSrc || e.src) && e.closest("[id*=picker i], [class*=picker i]"));
        let el = m?.parentElement;
        while (el && el !== document.body) {
            const s = getComputedStyle(el);
            if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return null;
    }
    function tiles(box) {
        // Masonry items: absolutely positioned boxes inside the list
        return [...box.querySelectorAll("[style*='top'][style*='left'][style*='height']")]
            .filter(el => getComputedStyle(el).position === "absolute" && el.offsetHeight > 30 && el.offsetWidth > 30);
    }
    function ready(tile) {
        const v = tile.querySelector("video");
        if (v && v.currentSrc && v.readyState >= 3) return true;
        const i = [...tile.querySelectorAll("img")].find(i => GIF_HOST.test(i.currentSrc || i.src));
        if (i && i.complete && i.naturalWidth > 0) return true;
        return !!tile.querySelector("canvas"); // GIFs+ still tile
    }

    // Typing in the picker's search: time the results from the last keystroke
    const onInput = e => {
        if (e.target?.closest?.("[id*=picker i], [class*=picker i]")) st.pending = { kind: "search", t: T() };
    };
    document.addEventListener("input", onInput, true);

    let lastScroll = -1;
    const sampler = setInterval(() => {
        const box = scroller();
        const now = T();
        if (!box) { if (st.open) { st.open = null; st.pending = null; } return; }
        if (!st.open) { st.open = now; st.pending = { kind: "open", t: now }; lastScroll = box.scrollTop; }
        // A search shows the top of new results: not a scroll
        if (st.pending?.kind === "search") lastScroll = box.scrollTop;
        if (box.scrollTop !== lastScroll) {
            lastScroll = box.scrollTop;
            st.pending = { kind: "scroll", t: now };
        }
        const r = box.getBoundingClientRect();
        const vis = tiles(box).filter(t => { const b = t.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; });
        const ok = vis.filter(ready).length;
        if (ok && st.first == null) st.first = now - st.open;
        st.samples.push([Math.round(now - st.open), vis.length, ok]);
        // A search waits for Discord's debounce and the new results first
        // (until the first GIF of the new results is requested)
        const settling = st.pending?.kind === "search" && !st.requests.some(q => q.start > st.pending.t)
            && !performance.getEntriesByType("resource").some(e => e.startTime > st.pending.t && GIF_HOST.test(e.name) && e.initiatorType !== "xmlhttprequest" && e.initiatorType !== "fetch");
        if (st.pending && !settling && vis.length && ok === vis.length) {
            st.screens.push({ kind: st.pending.kind, ms: Math.round(now - st.pending.t), tiles: vis.length });
            console.log(`[gpBench] ${st.pending.kind}: screen full after ${Math.round(now - st.pending.t)} ms (${vis.length} tiles)`);
            st.pending = null;
        }
    }, 100);

    function stop(quiet) {
        on = false;
        clearInterval(sampler);
        document.removeEventListener("input", onInput, true);
        ro.disconnect();
        lto?.disconnect();
        if (quiet) return;
        const f = [...st.frames].sort((a, b) => a - b);
        const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
        const opens = st.screens.filter(s => s.kind === "open").map(s => s.ms);
        const scrolls = st.screens.filter(s => s.kind === "scroll").map(s => s.ms);
        const searches = st.screens.filter(s => s.kind === "search").map(s => s.ms);
        const gifsPlus = !!document.querySelector(".vc-gpo-tile, .vc-gpo-sentinel") || st.requests.some(r => /AAA[A-Z][12]\/|\/(100w|200w)\./.test(r.url));
        const summary = {
            gifsPlus,
            firstGifMs: st.first && Math.round(st.first),
            screenFullAfterOpenMs: med(opens),
            screenFullAfterSearchMs: med(searches),
            screenFullAfterScrollMs: med(scrolls),
            scrolls: scrolls.length,
            screenNeverFilled: st.pending ? st.pending.kind : null,
            gifRequests: st.requests.length,
            gifMB: +(st.requests.reduce((a, r) => a + r.bytes, 0) / 1048576).toFixed(2),
            bytesVisibleFor: `${st.requests.filter(r => r.bytes).length}/${st.requests.length} requests`,
            frames: f.length,
            jankFrames: f.filter(x => x > 50).length,
            p95FrameMs: f.length ? Math.round(f[Math.floor(f.length * 0.95)]) : null,
            longTasks: st.longTasks.length,
            longTaskMs: Math.round(st.longTasks.reduce((a, b) => a + b, 0)),
        };
        console.table(summary);
        const json = JSON.stringify({ summary, screens: st.screens, requests: st.requests, samples: st.samples });
        try {
            if (window.DiscordNative?.clipboard?.copy) DiscordNative.clipboard.copy(json); else copy(json);
            console.log("[gpBench] JSON copied to the clipboard");
        } catch { console.log(json); }
        return summary;
    }

    window.gpBench = { stop, state: st };
    console.log("[gpBench] recording. Open the GIF picker, search, scroll. Then run gpBench.stop()");
})();
