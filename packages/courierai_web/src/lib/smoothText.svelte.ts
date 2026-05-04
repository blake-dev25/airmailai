// State machine that drains streaming text into `display` at a controlled rate,
// so the UI doesn't render giant chunks instantly. Owns its own RAF loop.

export type SmoothMode =
    | 'smooth'
    | 'boost-on-complete'
    | 'dump-on-complete'
    | 'raw';

const DRAIN_CHARS_PER_SEC = 60;
const DRAIN_CHARS_PER_SEC_BOOST = 300;

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
        lastTime = 0;
        accum = 0;
    }

    function tick(now: DOMHighResTimeStamp) {
        if (display.length > target.length) {
            display = target;
            cancelRaf();
            return;
        }
        if (display.length < target.length) {
            if (lastTime > 0) {
                const rate =
                    opts.mode() === 'boost-on-complete' && !opts.streaming()
                        ? DRAIN_CHARS_PER_SEC_BOOST
                        : DRAIN_CHARS_PER_SEC;
                accum += ((now - lastTime) / 1000) * rate;
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
        }
    }

    return {
        get display() {
            return display;
        },
        setRaw(raw: string) {
            const mode = opts.mode();
            if (mode === 'raw') {
                cancelRaf();
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
                display = raw;
                target = raw;
                opts.onReset?.();
            }
        },
        flushIfComplete() {
            if (opts.streaming()) return;
            if (display.length >= target.length) return;
            cancelRaf();
            display = target;
        },
        cancel: cancelRaf,
    };
}
