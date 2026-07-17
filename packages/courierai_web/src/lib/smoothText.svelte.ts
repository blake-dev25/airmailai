export type SmoothMode = 'smooth' | 'raw';

const DRAIN_MIN_CHARS_PER_SEC_STREAMING = 30;
const DRAIN_MIN_CHARS_PER_SEC_COMPLETE = 300;
const DRAIN_GAP_MULTIPLIER = 2;
const MAX_TICK_ELAPSED_MS = 1000;

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
                const gap = target.length - display.length;
                const rate = Math.max(
                    gap * DRAIN_GAP_MULTIPLIER,
                    opts.streaming()
                        ? DRAIN_MIN_CHARS_PER_SEC_STREAMING
                        : DRAIN_MIN_CHARS_PER_SEC_COMPLETE
                );
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
        snapToDisplay() {
            cancelRaf();
            resetTiming();
            target = display;
        },
        cancel: cancelRaf,
    };
}
