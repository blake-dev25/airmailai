<script lang="ts">
    import Icon from '../Icon.svelte';

    let {
        label,
        text,
        above = false,
    }: { label: string; text: string; above?: boolean } = $props();
</script>

<span
    class="info-icon relative flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
    aria-label={label}
>
    <Icon name="info" />
    <span
        class={[
            'info-tooltip hidden absolute left-0 w-72 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal shadow-[0_4px_16px_oklch(0%_0_0/15%)] pointer-events-none z-10',
            above ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
        ]}>{text}</span
    >
</span>
