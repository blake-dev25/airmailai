<script module lang="ts">
    import type { ModelOption } from './constants';

    export interface ModelGroup {
        label: string;
        pinned?: boolean;
        models: ModelOption[];
    }
</script>

<script lang="ts">
    import Dropdown from './Dropdown.svelte';

    let {
        groups,
        value = $bindable(),
        onchange,
        disabled = false,
        emptyLabel = 'Loading models...',
    }: {
        groups: ModelGroup[];
        value: string;
        onchange?: (id: string) => void;
        disabled?: boolean;
        emptyLabel?: string;
    } = $props();

    const dropdownGroups = $derived(
        groups.map((group) => ({
            label: group.label,
            pinned: group.pinned,
            options: group.models.map((model) => ({
                id: model.id,
                name: model.name,
                searchText: model.vendor,
            })),
        }))
    );
    const searchable = $derived(
        groups.reduce((count, group) => count + group.models.length, 0) > 50
    );
</script>

<Dropdown
    id="model"
    groups={dropdownGroups}
    bind:value
    {onchange}
    {disabled}
    {emptyLabel}
    {searchable}
    fullWidth
    searchPlaceholder="Search models..."
    emptySearchLabel="No models found"
/>
