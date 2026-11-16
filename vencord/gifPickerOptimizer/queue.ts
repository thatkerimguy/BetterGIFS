/*
 * GifPickerOptimizer — sequential load queue.
 * Shared between the Vencord and Valenced builds (keep both copies in sync).
 *
 * Tiles register a ticket when they mount. The queue starts the waiting ticket
 * that comes first in reading order and only starts the next one once the running
 * one reports that it finished loading.
 *
 * Reading order is the item index: Discord's masonry grid places item 0, 1, 2...
 * into columns left to right, row by row, so the index is exactly "left to right,
 * top to bottom" even though the rows of a masonry grid don't line up in pixels.
 */

export interface Ticket {
    /** Position in reading order (the item index). Lower loads first. */
    order(): number;
    /** Whether the tile is on screen right now */
    visible: boolean;
    /** Called when it is this ticket's turn to load */
    start(): void;
    /** insertion order, tie breaker */
    seq?: number;
}

export class LoadQueue {
    concurrency = 1;
    prioritizeVisible = true;

    private waiting = new Set<Ticket>();
    private active = new Set<Ticket>();
    private blockers = new Set<symbol>();
    private scheduled = false;
    private seq = 0;

    enqueue(t: Ticket) {
        t.seq = this.seq++;
        this.waiting.add(t);
        this.kick();
    }

    /** Ticket unmounted or no longer interested */
    cancel(t: Ticket) {
        this.waiting.delete(t);
        if (this.active.delete(t)) this.kick();
    }

    /** Ticket finished (loaded, errored or timed out) */
    finish(t: Ticket) {
        if (this.active.delete(t)) this.kick();
    }

    /**
     * Holds the queue (nothing new starts) until the returned function is called
     * or the timeout passes. Used while low resolution URLs are being looked up,
     * so we don't start downloading full resolution files in the meantime.
     */
    block(timeoutMs: number) {
        const key = Symbol("block");
        this.blockers.add(key);
        const release = () => {
            if (this.blockers.delete(key)) this.kick();
        };
        setTimeout(release, timeoutMs);
        return release;
    }

    get isBlocked() {
        return this.blockers.size > 0;
    }

    /** Something about the ordering changed (visibility/position) */
    kick() {
        if (this.scheduled) return;
        this.scheduled = true;
        // Deferred so that every tile mounted in the same render registers first
        setTimeout(() => {
            this.scheduled = false;
            this.pump();
        }, 0);
    }

    private compare = (a: Ticket, b: Ticket) => {
        if (this.prioritizeVisible && a.visible !== b.visible) return a.visible ? -1 : 1;
        const d = a.order() - b.order();
        return d !== 0 ? d : (a.seq ?? 0) - (b.seq ?? 0);
    };

    private pump() {
        if (this.blockers.size) return;
        const limit = Math.max(1, this.concurrency | 0);
        while (this.active.size < limit && this.waiting.size) {
            let best: Ticket | null = null;
            for (const t of this.waiting)
                if (best == null || this.compare(t, best) < 0) best = t;

            this.waiting.delete(best!);
            this.active.add(best!);
            try {
                best!.start();
            } catch (e) {
                console.error("[GifPickerOptimizer] ticket start failed", e);
                this.active.delete(best!);
            }
        }
    }
}
