import { untrack } from 'svelte';

const BOTTOM_THRESHOLD_PX = 8;
const INTERACTION_TIMEOUT_MS = 200;
const PIN_USER_TOP_PADDING_PX = 16;

export type AutoscrollMode = 'pin-user-message' | 'pin-bottom' | 'off';

export function createChatScroll() {
    let atBottom = $state(true);
    let spacerHeight = $state(0);
    let containerEl: HTMLElement | null = null;
    let getMode: () => AutoscrollMode = () => 'pin-user-message';
    let getLastUserMessageEl: () => HTMLElement | null = () => null;
    let pinned = false;
    let snapToBottomPending = false;
    let lastScrollTop = 0;
    let userInteracting = false;
    let interactionTimer: ReturnType<typeof setTimeout> | null = null;

    function markInteracting() {
        userInteracting = true;
        snapToBottomPending = false;
        if (interactionTimer !== null) clearTimeout(interactionTimer);
        interactionTimer = setTimeout(() => {
            userInteracting = false;
            interactionTimer = null;
        }, INTERACTION_TIMEOUT_MS);
    }

    function naturalScrollHeight(): number {
        if (!containerEl) return 0;
        return containerEl.scrollHeight - untrack(() => spacerHeight);
    }

    function recomputeAtBottom() {
        if (!containerEl) return;
        atBottom =
            containerEl.scrollTop + containerEl.clientHeight >=
            naturalScrollHeight() - BOTTOM_THRESHOLD_PX;
    }

    function userMsgOffsetFromScroll(): number | null {
        if (!containerEl) return null;
        const userMsg = getLastUserMessageEl();
        if (!userMsg) return null;
        const userMsgTop = userMsg.getBoundingClientRect().top;
        const containerTop = containerEl.getBoundingClientRect().top;
        return userMsgTop - containerTop + containerEl.scrollTop;
    }

    function recomputeSpacer() {
        if (!containerEl) return;
        const offset = userMsgOffsetFromScroll();
        if (offset === null) {
            spacerHeight = 0;
            return;
        }
        const naturalHeightBelow = naturalScrollHeight() - offset;
        const needed =
            containerEl.clientHeight -
            PIN_USER_TOP_PADDING_PX -
            naturalHeightBelow;
        spacerHeight = Math.max(0, needed);
    }

    function shrinkSpacerToViewport() {
        if (!containerEl) return;
        const current = untrack(() => spacerHeight);
        if (current === 0) return;
        const overhang =
            containerEl.scrollTop +
            containerEl.clientHeight -
            naturalScrollHeight();
        const next = Math.min(current, Math.max(0, overhang));
        if (next !== current) spacerHeight = next;
    }

    function releasePin() {
        if (!pinned) return;
        pinned = false;
        shrinkSpacerToViewport();
    }

    function pinUserMessageToTop() {
        if (!containerEl) return;
        recomputeSpacer();
        requestAnimationFrame(() => {
            if (!containerEl) return;
            const offset = userMsgOffsetFromScroll();
            if (offset === null) return;
            containerEl.scrollTop = Math.max(
                0,
                offset - PIN_USER_TOP_PADDING_PX
            );
            lastScrollTop = containerEl.scrollTop;
            recomputeAtBottom();
        });
    }

    function snapToBottom() {
        if (!containerEl) return;
        containerEl.scrollTop = containerEl.scrollHeight;
        lastScrollTop = containerEl.scrollTop;
        atBottom = true;
    }

    return {
        get atBottom() {
            return atBottom;
        },
        get spacerHeight() {
            return spacerHeight;
        },

        markAtBottom() {
            atBottom = true;
        },

        scrollToBottom() {
            pinned = false;
            spacerHeight = 0;
            snapToBottom();
        },

        onSubmit() {
            snapToBottomPending = false;
            const mode = getMode();
            if (mode === 'pin-bottom') {
                this.scrollToBottom();
            } else if (mode === 'pin-user-message') {
                pinned = true;
                requestAnimationFrame(() => pinUserMessageToTop());
            }
        },

        onModeChange() {
            if (getMode() === 'pin-user-message') return;
            pinned = false;
            spacerHeight = 0;
        },

        onChatChange(snap: boolean) {
            pinned = false;
            spacerHeight = 0;
            snapToBottomPending = snap;
            if (snap) {
                requestAnimationFrame(() => {
                    if (snapToBottomPending) snapToBottom();
                });
            } else {
                recomputeAtBottom();
            }
        },

        attach(
            container: HTMLElement,
            content: HTMLElement,
            mode: () => AutoscrollMode,
            lastUserMessageEl: () => HTMLElement | null
        ) {
            containerEl = container;
            getMode = mode;
            getLastUserMessageEl = lastUserMessageEl;

            const isScrollable = () =>
                container.scrollHeight > container.clientHeight;

            const onContentResize = () => {
                const m = getMode();
                if (snapToBottomPending) {
                    container.scrollTop = container.scrollHeight;
                    lastScrollTop = container.scrollTop;
                } else if (m === 'pin-bottom' && atBottom) {
                    container.scrollTop = container.scrollHeight;
                    lastScrollTop = container.scrollTop;
                } else if (m === 'pin-user-message' && pinned) {
                    recomputeSpacer();
                } else {
                    shrinkSpacerToViewport();
                }
                recomputeAtBottom();
            };

            const handleScroll = () => {
                if (userInteracting) {
                    markInteracting();
                    if (container.scrollTop < lastScrollTop) releasePin();
                }
                if (!pinned) shrinkSpacerToViewport();
                lastScrollTop = container.scrollTop;
                recomputeAtBottom();
            };

            const onWheel = (e: WheelEvent) => {
                markInteracting();
                if (e.deltaY < 0 && isScrollable()) {
                    releasePin();
                    atBottom = false;
                }
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
                    releasePin();
                    atBottom = false;
                }
            };

            const contentRo = new ResizeObserver(onContentResize);
            contentRo.observe(content);
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
            untrack(() => onContentResize());

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
