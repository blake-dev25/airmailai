<script module lang="ts">
    import Check from '@lucide/svelte/icons/check';
    import ChevronDown from '@lucide/svelte/icons/chevron-down';
    import CircleAlert from '@lucide/svelte/icons/circle-alert';
    import ChevronRight from '@lucide/svelte/icons/chevron-right';
    import Copy from '@lucide/svelte/icons/copy';
    import Download from '@lucide/svelte/icons/download';
    import ExternalLink from '@lucide/svelte/icons/external-link';
    import File from '@lucide/svelte/icons/file';
    import Folder from '@lucide/svelte/icons/folder';
    import Info from '@lucide/svelte/icons/info';
    import LoaderCircle from '@lucide/svelte/icons/loader-circle';
    import Mail from '@lucide/svelte/icons/mail';
    import MailPlus from '@lucide/svelte/icons/mail-plus';
    import Pencil from '@lucide/svelte/icons/pencil';
    import Plus from '@lucide/svelte/icons/plus';
    import RefreshCw from '@lucide/svelte/icons/refresh-cw';
    import Search from '@lucide/svelte/icons/search';
    import Send from '@lucide/svelte/icons/send';
    import Settings from '@lucide/svelte/icons/settings';
    import Square from '@lucide/svelte/icons/square';
    import Star from '@lucide/svelte/icons/star';
    import Trash from '@lucide/svelte/icons/trash';
    import Upload from '@lucide/svelte/icons/upload';
    import X from '@lucide/svelte/icons/x';

    type IconName =
        | 'check'
        | 'chevron-down'
        | 'chevron-right'
        | 'circle-alert'
        | 'close'
        | 'copy'
        | 'download'
        | 'edit'
        | 'external-link'
        | 'file'
        | 'folder'
        | 'info'
        | 'mail'
        | 'mail-plus'
        | 'plus'
        | 'retry'
        | 'search'
        | 'send'
        | 'settings'
        | 'spinner'
        | 'star'
        | 'stop'
        | 'trash'
        | 'upload';

    const ICONS = {
        check: Check,
        'chevron-down': ChevronDown,
        'chevron-right': ChevronRight,
        'circle-alert': CircleAlert,
        close: X,
        copy: Copy,
        download: Download,
        edit: Pencil,
        'external-link': ExternalLink,
        file: File,
        folder: Folder,
        info: Info,
        mail: Mail,
        'mail-plus': MailPlus,
        plus: Plus,
        retry: RefreshCw,
        search: Search,
        send: Send,
        settings: Settings,
        spinner: LoaderCircle,
        star: Star,
        stop: Square,
        trash: Trash,
        upload: Upload,
    } as const;

    const DEFAULT_SIZE: Record<IconName, number> = {
        check: 15,
        'chevron-down': 14,
        'chevron-right': 12,
        'circle-alert': 13,
        close: 10,
        copy: 12,
        download: 12,
        edit: 12,
        'external-link': 11,
        file: 12,
        folder: 14,
        info: 13,
        mail: 18,
        'mail-plus': 32,
        plus: 18,
        retry: 12,
        search: 16,
        send: 16,
        settings: 15,
        spinner: 12,
        star: 11,
        stop: 14,
        trash: 12,
        upload: 14,
    };
</script>

<script lang="ts">
    interface Props {
        name: IconName;
        size?: number;
        strokeWidth?: number;
        fill?: string;
        class?: string;
    }

    let {
        name,
        size,
        strokeWidth,
        fill,
        class: className = '',
    }: Props = $props();

    let Component = $derived(ICONS[name]);
    let resolvedSize = $derived(size ?? DEFAULT_SIZE[name]);
    let resolvedStroke = $derived(strokeWidth ?? 2);
</script>

<Component
    size={resolvedSize}
    strokeWidth={resolvedStroke}
    {...fill ? { fill } : {}}
    class={`airmail-icon ${name === 'spinner' ? 'airmail-icon-spin' : ''} ${className}`}
/>

<style>
    :global(.airmail-icon) {
        flex-shrink: 0;
    }

    :global(.airmail-icon-spin) {
        animation: airmail-spin 0.8s linear infinite;
        transform-box: fill-box;
        transform-origin: center;
    }

    @keyframes airmail-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
