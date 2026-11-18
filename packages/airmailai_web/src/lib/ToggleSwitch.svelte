<script lang="ts">
    import type { ClassValue } from 'svelte/elements';

    let {
        id,
        checked,
        label,
        disabled = false,
        title,
        class: extraClass,
        onchange,
    }: {
        id: string;
        checked: boolean;
        label: string;
        disabled?: boolean;
        title?: string;
        class?: ClassValue;
        onchange: (checked: boolean) => void;
    } = $props();
</script>

<button
    {id}
    type="button"
    class={[
        'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
        checked && 'on',
        disabled && 'cursor-not-allowed',
        extraClass,
    ]}
    role="switch"
    aria-checked={checked}
    aria-label={label}
    {title}
    {disabled}
    onclick={() => onchange(!checked)}
>
    <span class="toggle-switch-thumb"></span>
</button>
