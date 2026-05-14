// Sticky-to-bottom scroll controller. Pins the scroll container to its
// content's bottom as content grows; releases when the user explicitly
// scrolls up; re-engages when they reach the bottom again.
//
// Distinguishes user-initiated scroll from browser-driven scroll
// (scroll-anchor adjustment, sub-pixel rounding, mid-stream layout shifts
// from Shiki re-highlighting, etc.) by gating sticky transitions on real
// input events — so spurious scrollTop drifts don't pop the scroll-to-bottom
// button while the user is still effectively pinned.
//
// ResizeObserver fires between layout and paint, so re-pinning never paints
// an intermediate frame where new content has rendered but the scroll
// position hasn't caught up — kills the streaming flash.

const BOTTOM_THRESHOLD_PX = 8;
const INTERACTION_TIMEOUT_MS = 200;

export function createStickToBottom() {
    let sticky = $state(true);
    let containerEl: HTMLElement | null = null;
    let lastScrollTop = 0;
    let userInteracting = false;
    let interactionTimer: ReturnType<typeof setTimeout> | null = null;

    function markInteracting() {
        userInteracting = true;
        if (interactionTimer !== null) clearTimeout(interactionTimer);
        interactionTimer = setTimeout(() => {
            userInteracting = false;
            interactionTimer = null;
        }, INTERACTION_TIMEOUT_MS);
    }

    return {
        get sticky() {
            return sticky;
        },

        // Re-engage stickiness without forcing a scroll now — caller relies
        // on the next content-size change (ResizeObserver) to repaint at the
        // bottom. Cheap; safe to call from reactive callbacks.
        reSticky() {
            sticky = true;
        },

        // Re-engage stickiness AND scroll right now. Use when we want a
        // guaranteed visible jump (button click, message submit).
        scrollToBottom() {
            if (!containerEl) return;
            sticky = true;
            containerEl.scrollTop = containerEl.scrollHeight;
            lastScrollTop = containerEl.scrollTop;
        },

        // Wire up listeners + ResizeObserver. Caller invokes inside $effect
        // and returns the cleanup. `enabled` gates programmatic pinning —
        // when autoscroll is off, sticky tracking still runs (so the button
        // works), but content growth never overrides the user's position.
        attach(
            container: HTMLElement,
            content: HTMLElement,
            enabled: () => boolean
        ) {
            containerEl = container;

            const pinIfSticky = () => {
                if (!sticky || !enabled()) return;
                container.scrollTop = container.scrollHeight;
                lastScrollTop = container.scrollTop;
            };

            const handleScroll = () => {
                const { scrollTop, scrollHeight, clientHeight } = container;
                const distance = scrollHeight - scrollTop - clientHeight;
                if (userInteracting) {
                    if (scrollTop < lastScrollTop) {
                        // Any upward delta during a user gesture detaches —
                        // matches the existing snappy behavior under fast
                        // streams (no threshold fight).
                        sticky = false;
                    } else if (distance < BOTTOM_THRESHOLD_PX) {
                        sticky = true;
                    }
                }
                lastScrollTop = scrollTop;
            };

            // True only when there's actually room to scroll — a chat
            // shorter than the viewport can't be "scrolled away from".
            const isScrollable = () =>
                container.scrollHeight > container.clientHeight;

            // Pre-emptively detach on upward wheel so a chunk arriving in
            // the gap between wheel and scroll events can't re-pin and
            // steal the gesture.
            const onWheel = (e: WheelEvent) => {
                markInteracting();
                if (e.deltaY < 0 && isScrollable()) sticky = false;
            };

            const onTouchStart = () => markInteracting();
            const onTouchMove = () => markInteracting();
            const onPointerDown = () => markInteracting();

            const onKeyDown = (e: KeyboardEvent) => {
                const scrollKey =
                    e.key === 'ArrowUp' ||
                    e.key === 'ArrowDown' ||
                    e.key === 'PageUp' ||
                    e.key === 'PageDown' ||
                    e.key === 'Home' ||
                    e.key === 'End' ||
                    e.key === ' ';
                if (!scrollKey) return;
                markInteracting();
                if (
                    (e.key === 'ArrowUp' ||
                        e.key === 'PageUp' ||
                        e.key === 'Home') &&
                    isScrollable()
                ) {
                    sticky = false;
                }
            };

            const ro = new ResizeObserver(pinIfSticky);
            ro.observe(content);

            container.addEventListener('scroll', handleScroll, {
                passive: true,
            });
            container.addEventListener('wheel', onWheel, { passive: true });
            container.addEventListener('touchstart', onTouchStart, {
                passive: true,
            });
            container.addEventListener('touchmove', onTouchMove, {
                passive: true,
            });
            container.addEventListener('pointerdown', onPointerDown);
            container.addEventListener('keydown', onKeyDown);

            lastScrollTop = container.scrollTop;
            pinIfSticky();

            return () => {
                ro.disconnect();
                container.removeEventListener('scroll', handleScroll);
                container.removeEventListener('wheel', onWheel);
                container.removeEventListener('touchstart', onTouchStart);
                container.removeEventListener('touchmove', onTouchMove);
                container.removeEventListener('pointerdown', onPointerDown);
                container.removeEventListener('keydown', onKeyDown);
                if (interactionTimer !== null) {
                    clearTimeout(interactionTimer);
                    interactionTimer = null;
                }
                if (containerEl === container) containerEl = null;
            };
        },
    };
}
