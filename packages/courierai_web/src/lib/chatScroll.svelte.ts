// Chat scroll controller. Three modes, selected via Settings -> UI:
//
//   pin-user-message - on submit, scrolls so the last user message sits at
//     the top of the viewport, with a dynamic bottom spacer that gives the
//     scroll container enough room to make that always possible (even on
//     the very first message, when nothing else has filled the chat). As
//     the assistant response streams in, the spacer shrinks 1:1 with the
//     response growth, so the user message stays anchored at the top until
//     the response is tall enough to push it up on its own.
//
//   pin-bottom - classic sticky-to-bottom. Pins to the bottom as content
//     grows; releases when the user explicitly scrolls up; re-engages when
//     they reach the bottom again. Distinguishes user-initiated scroll
//     from browser-driven scroll (scroll-anchor adjustments, sub-pixel
//     rounding, mid-stream Shiki re-highlights) by gating sticky
//     transitions on real input events.
//
//   off - no programmatic scrolling at all. The scroll-to-bottom button
//     still works as a one-shot.
//
// ResizeObserver fires between layout and paint, so re-pinning never
// paints an intermediate frame where new content has rendered but the
// scroll position hasn't caught up - kills the streaming flash.

const BOTTOM_THRESHOLD_PX = 8;
const INTERACTION_TIMEOUT_MS = 200;
const PIN_USER_TOP_PADDING_PX = 16;

export type AutoscrollMode = 'pin-user-message' | 'pin-bottom' | 'off';

export function createChatScroll() {
    // Tracks "is the user currently at the bottom" for both the scroll-to-
    // bottom button (visible when false) and pin-bottom mode's auto-pin.
    let atBottom = $state(true);
    let spacerHeight = $state(0);

    let containerEl: HTMLElement | null = null;
    let getMode: () => AutoscrollMode = () => 'pin-user-message';
    let getLastUserMessageEl: () => HTMLElement | null = () => null;

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

    // Offset from the scroll container's content origin to the top of the
    // last user message. Measured via getBoundingClientRect so it's
    // independent of offsetParent quirks.
    function userMsgOffsetFromScroll(): number | null {
        if (!containerEl) return null;
        const userMsg = getLastUserMessageEl();
        if (!userMsg) return null;
        const userMsgTop = userMsg.getBoundingClientRect().top;
        const containerTop = containerEl.getBoundingClientRect().top;
        return userMsgTop - containerTop + containerEl.scrollTop;
    }

    // Spacer sizing: we want the user message to always be able to scroll
    // to the top of the viewport. That requires the height of everything
    // below (and including) the user message to be at least the container
    // height (minus a small top padding). The spacer makes up any shortfall.
    // Subtracting the current spacer cancels its own contribution to
    // scrollHeight so this reads as a pure measurement of the natural
    // content size.
    function recomputeSpacer() {
        if (!containerEl) return;
        if (getMode() !== 'pin-user-message') {
            spacerHeight = 0;
            return;
        }
        const offset = userMsgOffsetFromScroll();
        if (offset === null) {
            spacerHeight = 0;
            return;
        }
        const naturalScrollHeight = containerEl.scrollHeight - spacerHeight;
        const naturalHeightBelow = naturalScrollHeight - offset;
        const needed =
            containerEl.clientHeight -
            PIN_USER_TOP_PADDING_PX -
            naturalHeightBelow;
        spacerHeight = Math.max(0, needed);
    }

    function pinUserMessageToTop() {
        if (!containerEl) return;
        recomputeSpacer();
        // The spacer write above queues a DOM update; wait one frame so the
        // container's scrollHeight has actually grown before we scroll, or
        // the target may be clamped to the pre-update max.
        requestAnimationFrame(() => {
            if (!containerEl) return;
            const offset = userMsgOffsetFromScroll();
            if (offset === null) return;
            containerEl.scrollTop = Math.max(
                0,
                offset - PIN_USER_TOP_PADDING_PX
            );
            lastScrollTop = containerEl.scrollTop;
            atBottom = false;
        });
    }

    return {
        get atBottom() {
            return atBottom;
        },
        get spacerHeight() {
            return spacerHeight;
        },

        // Re-engage pin-bottom stickiness without forcing a scroll now -
        // the next content-size change (ResizeObserver) repaints at the
        // bottom. Cheap; safe to call from reactive callbacks. Only
        // meaningful in pin-bottom mode.
        markAtBottom() {
            atBottom = true;
        },

        // Re-engage stickiness AND scroll right now. Used by the scroll-
        // to-bottom button and pin-bottom mode's submit handler.
        scrollToBottom() {
            if (!containerEl) return;
            atBottom = true;
            containerEl.scrollTop = containerEl.scrollHeight;
            lastScrollTop = containerEl.scrollTop;
        },

        // Called from ChatPanel.submit() - dispatches based on mode. The
        // user message DOM node may not exist yet at call time (state was
        // just mutated), so we defer pin-user-message to the next frame.
        onSubmit() {
            const mode = getMode();
            if (mode === 'pin-bottom') {
                this.scrollToBottom();
            } else if (mode === 'pin-user-message') {
                requestAnimationFrame(() => pinUserMessageToTop());
            }
        },

        // Called from ChatPanel whenever the mode changes, so the spacer
        // resets when leaving pin-user-message mode and recomputes when
        // entering it.
        onModeChange() {
            recomputeSpacer();
        },

        // Wire up listeners + ResizeObservers. Caller invokes inside
        // $effect and returns the cleanup.
        attach(
            container: HTMLElement,
            content: HTMLElement,
            mode: () => AutoscrollMode,
            lastUserMessageEl: () => HTMLElement | null
        ) {
            containerEl = container;
            getMode = mode;
            getLastUserMessageEl = lastUserMessageEl;

            const onContentResize = () => {
                const m = getMode();
                if (m === 'pin-bottom' && atBottom) {
                    container.scrollTop = container.scrollHeight;
                    lastScrollTop = container.scrollTop;
                } else if (m === 'pin-user-message') {
                    recomputeSpacer();
                }
            };

            // True only when there's actually room to scroll - a chat
            // shorter than the viewport can't be "scrolled away from".
            const isScrollable = () =>
                container.scrollHeight > container.clientHeight;

            const handleScroll = () => {
                const { scrollTop, scrollHeight, clientHeight } = container;
                const distance = scrollHeight - scrollTop - clientHeight;
                if (userInteracting) {
                    if (scrollTop < lastScrollTop && isScrollable()) {
                        // Any upward delta during a user gesture detaches -
                        // matches the existing snappy behavior under fast
                        // streams (no threshold fight). isScrollable guards
                        // against layout-driven scrollTop clamps (e.g.
                        // collapsing an expando) being read as user intent.
                        atBottom = false;
                    } else if (distance < BOTTOM_THRESHOLD_PX) {
                        atBottom = true;
                    }
                }
                lastScrollTop = scrollTop;
            };

            // Pre-emptively detach on upward wheel so a chunk arriving in
            // the gap between wheel and scroll events can't re-pin and
            // steal the gesture.
            const onWheel = (e: WheelEvent) => {
                markInteracting();
                if (e.deltaY < 0 && isScrollable()) atBottom = false;
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
                    atBottom = false;
                }
            };

            const contentRo = new ResizeObserver(onContentResize);
            contentRo.observe(content);
            // Window/sidebar resize changes clientHeight, which feeds into
            // both the pin-bottom auto-pin and the spacer math.
            const containerRo = new ResizeObserver(onContentResize);
            containerRo.observe(container);

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
            onContentResize();

            return () => {
                contentRo.disconnect();
                containerRo.disconnect();
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
