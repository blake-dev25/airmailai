export type SmoothMode =
    'smooth' | 'boost-on-complete' | 'dump-on-complete' | 'raw';

const DRAIN_CHARS_PER_SEC = 300;
const DRAIN_CHARS_PER_SEC_BOOST = 600;
const MAX_TICK_ELAPSED_MS = 1000;
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
        snapToDisplay() {
            cancelRaf();
            resetTiming();
            target = display;
        },
        cancel: cancelRaf,
    };
}
