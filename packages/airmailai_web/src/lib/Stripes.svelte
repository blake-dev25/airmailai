<script lang="ts">
    let { width, shift }: { width: number; shift: number } = $props();

    const STRIPE_H = 20;
    const STRIPE_W = 40;
    const GAP = 40;
    const PITCH = STRIPE_W + GAP;

    const clipId = $props.id();

    let stripes = $derived.by(() => {
        const startI = -Math.ceil(STRIPE_H / PITCH) - 1;
        const endI = Math.ceil(width / PITCH) + 1;
        return Array.from({ length: endI - startI + 1 }, (_, idx) => {
            const i = startI + idx;
            const x = i * PITCH + shift;
            return {
                points: `${x + STRIPE_H},0 ${x + STRIPE_H + STRIPE_W},0 ${x + STRIPE_W},${STRIPE_H} ${x},${STRIPE_H}`,
                red: i % 2 === 0,
            };
        });
    });
</script>

<svg
    {width}
    height={STRIPE_H}
    viewBox="0 0 {width} {STRIPE_H}"
    class="block shrink-0"
    aria-hidden="true"
>
    <defs>
        <clipPath id={clipId}>
            <rect {width} height={STRIPE_H} />
        </clipPath>
    </defs>
    <g clip-path="url(#{clipId})">
        <rect {width} height={STRIPE_H} fill="var(--color-canvas)" />
        <!-- eslint-disable-next-line svelte/require-each-key -->
        {#each stripes as stripe}
            <polygon
                points={stripe.points}
                fill={stripe.red
                    ? 'var(--color-accent-bg)'
                    : 'var(--color-accent-2-bg)'}
            />
        {/each}
    </g>
</svg>
