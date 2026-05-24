// State machine that drains streaming text into `display` at a controlled rate,
// so the UI doesn't render giant chunks instantly. Owns its own RAF loop.

export type SmoothMode =
    | 'smooth'
    | 'boost-on-complete'
    | 'dump-on-complete'
    | 'raw';

const DRAIN_CHARS_PER_SEC = 300;
const DRAIN_CHARS_PER_SEC_BOOST = 600;
// Clamp per-tick elapsed time so a long gap (page hidden, RAF paused, stream
// idled) doesn't drain a huge backlog in one frame. Anything beyond this is
// treated as a fresh start.
const MAX_TICK_ELAPSED_MS = 1000;
// If a firstChunk arrival reveals more accumulated text than this, snap
// display forward instead of draining at 300 char/sec for many seconds.
// Catches the "joined a remote stream mid-flight" case where the user
// would otherwise watch a 2000+ char backlog scroll in slowly.
const SNAP_GAP_CHARS = 2000;

export interface SmoothTextOpts {
    mode: () => SmoothMode;
    streaming: () => boolean;
    onReset?: () => void;
}

export function createSmoothText(opts: SmoothTextOpts) {
    let display = $state('');
    let target = '';
    let rafId: number | null = null;
    let lastTime = 0;
    let accum = 0;

    // Stop the RAF but PRESERVE lastTime/accum. The ChatPanel $effect calls
    // this on every chunk's cleanup before re-running setRaw — if we reset
    // timing here, each cancel→setRaw cycle would force the next tick into a
    // warm-up no-op and the drain would never make progress under fast chunk
    // bursts (e.g. remote broadcast). Use resetTiming() at the points where
    // a fresh start is actually intended.
    function cancelRaf() {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
    }

    function resetTiming() {
        lastTime = 0;
        accum = 0;
    }

    function tick(now: DOMHighResTimeStamp) {
        if (display.length > target.length) {
            display = target;
            cancelRaf();
            resetTiming();
            return;
        }
        if (display.length < target.length) {
            const elapsed = now - lastTime;
            if (lastTime > 0 && elapsed < MAX_TICK_ELAPSED_MS) {
                const rate =
                    opts.mode() === 'boost-on-complete' && !opts.streaming()
                        ? DRAIN_CHARS_PER_SEC_BOOST
                        : DRAIN_CHARS_PER_SEC;
                accum += (elapsed / 1000) * rate;
                const step = Math.floor(accum);
                accum -= step;
                if (step > 0) {
                    display = target.slice(
                        0,
                        Math.min(target.length, display.length + step)
                    );
                }
            }
            lastTime = now;
            rafId = requestAnimationFrame(tick);
        } else {
            cancelRaf();
            resetTiming();
        }
    }

    return {
        get display() {
            return display;
        },
        // The string we're animating display toward. Exposed so consumers
        // can disambiguate "smooth is animating this message" from "smooth
        // holds stale content from a different message" (e.g. right after
        // a chat switch, before the next setRaw arrives).
        get target() {
            return target;
        },
        setRaw(raw: string) {
            const mode = opts.mode();
            if (mode === 'raw') {
                cancelRaf();
                resetTiming();
                display = raw;
                target = raw;
                return;
            }
            const grew =
                raw.length >= target.length &&
                raw.startsWith(target) &&
                target.length > 0;
            const firstChunk = target.length === 0 && opts.streaming();
            if (grew || firstChunk) {
                target = raw;
                // Mid-stream join: the first reveal has already accumulated
                // way more than we'd want the user to wait through. Skip
                // the smooth ramp-up; live chunks resume normally after.
                if (firstChunk && target.length > SNAP_GAP_CHARS) {
                    cancelRaf();
                    resetTiming();
                    display = target;
                    return;
                }
                if (rafId === null && display.length < target.length) {
                    rafId = requestAnimationFrame(tick);
                }
            } else {
                cancelRaf();
                resetTiming();
                display = raw;
                target = raw;
                opts.onReset?.();
            }
        },
        flushIfComplete() {
            if (opts.streaming()) return;
            if (display.length >= target.length) return;
            cancelRaf();
            resetTiming();
            display = target;
        },
        // Freeze the drain at the currently-visible character count. Used by
        // the stop button: the user clicked "stop", so anything past `display`
        // in `target` is content we no longer want to reveal. Caller is
        // expected to also truncate the underlying message so the next setRaw
        // doesn't reintroduce the trimmed tail.
        snapToDisplay() {
            cancelRaf();
            resetTiming();
            target = display;
        },
        cancel: cancelRaf,
    };
}
