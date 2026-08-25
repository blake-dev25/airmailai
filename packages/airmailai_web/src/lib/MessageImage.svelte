<script lang="ts">
    import { reportAppError } from './errorStore.svelte';
    import { getFileBlob } from './extension';

    let {
        hash,
        filename,
        streaming = false,
    }: { hash: string; filename: string; streaming?: boolean } = $props();

    let url = $state<string | null>(null);

    $effect(() => {
        streaming;
        const currentHash = hash;
        let objectUrl: string | null = null;
        let cancelled = false;
        getFileBlob(currentHash)
            .then((blob) => {
                if (!blob || cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                url = objectUrl;
            })
            .catch((err) => {
                reportAppError(
                    `image load failed (hash=${currentHash})`,
                    `Couldn't load ${filename}`,
                    err
                );
            });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            url = null;
        };
    });
</script>

{#if url}
    <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open {filename} full size"
    >
        <img
            src={url}
            alt={filename}
            class="block max-w-full max-h-[60vh] w-auto h-auto rounded-lg border border-border"
            loading="lazy"
        />
    </a>
{/if}
