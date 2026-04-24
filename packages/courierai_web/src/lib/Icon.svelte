<script lang="ts">
    type IconName =
        | 'chevron-down'
        | 'chevron-right'
        | 'inbox'
        | 'retry'
        | 'edit'
        | 'copy'
        | 'trash'
        | 'spinner'
        | 'file'
        | 'close'
        | 'plus'
        | 'send';

    interface Props {
        name: IconName;
        size?: number;
        class?: string;
    }

    let { name, size, class: className = '' }: Props = $props();

    const META: Record<IconName, { size: number; viewBox: string }> = {
        'chevron-down': { size: 14, viewBox: '0 0 14 14' },
        'chevron-right': { size: 12, viewBox: '0 0 12 12' },
        inbox: { size: 32, viewBox: '0 0 32 32' },
        retry: { size: 12, viewBox: '0 0 12 12' },
        edit: { size: 12, viewBox: '0 0 12 12' },
        copy: { size: 12, viewBox: '0 0 12 12' },
        trash: { size: 12, viewBox: '0 0 12 12' },
        spinner: { size: 12, viewBox: '0 0 12 12' },
        file: { size: 12, viewBox: '0 0 12 12' },
        close: { size: 10, viewBox: '0 0 10 10' },
        plus: { size: 16, viewBox: '0 0 16 16' },
        send: { size: 16, viewBox: '0 0 16 16' },
    };
</script>

<svg
    width={size ?? META[name].size}
    height={size ?? META[name].size}
    viewBox={META[name].viewBox}
    fill="none"
    aria-hidden="true"
    data-icon={name}
    class={className}
>
    {#if name === 'chevron-down'}
        <path
            d="M3 5l4 4 4-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {:else if name === 'chevron-right'}
        <path
            d="M4.5 2.5l3.5 3.5-3.5 3.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {:else if name === 'inbox'}
        <rect
            x="2"
            y="5"
            width="28"
            height="22"
            rx="3"
            stroke="currentColor"
            stroke-width="1.5"
        />
        <path
            d="M2 11l14 9 14-9"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
        />
    {:else if name === 'retry'}
        <path
            d="M2.5 6A3.5 3.5 0 1 0 6 2.5"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
        />
        <path
            d="M8.5 1L6 2.5L8.5 4"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {:else if name === 'edit'}
        <path
            d="M8.5 1.5l2 2L3 11H1V9L8.5 1.5Z"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {:else if name === 'copy'}
        <rect
            x="4"
            y="1"
            width="7"
            height="7"
            rx="1.5"
            stroke="currentColor"
            stroke-width="1.25"
        />
        <path
            d="M8 8v2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {:else if name === 'trash'}
        <path
            d="M2 4h9M5 4V2.5h3V4M3.5 4l.5 7h5l.5-7"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {:else if name === 'spinner'}
        <circle
            cx="6"
            cy="6"
            r="4.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-dasharray="18 8"
            stroke-linecap="round"
        />
    {:else if name === 'file'}
        <path
            d="M2 1.5h5.5L10 4v6.5H2V1.5z"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
        />
        <path
            d="M7.5 1.5V4H10"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
        />
    {:else if name === 'close'}
        <path
            d="M2 2l6 6M8 2l-6 6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
        />
    {:else if name === 'plus'}
        <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
        />
    {:else if name === 'send'}
        <path
            d="M2 8h12M9 3l5 5-5 5"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    {/if}
</svg>

<style>
    svg {
        flex-shrink: 0;
    }

    svg[data-icon='spinner'] {
        animation: spin 0.8s linear infinite;
        transform-box: fill-box;
        transform-origin: center;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
