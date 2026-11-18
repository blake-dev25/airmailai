<script lang="ts">
    import { settingsStore } from '../settingsStore.svelte';
    import DemoLockedPanel from './DemoLockedPanel.svelte';
    import InfoTip from './InfoTip.svelte';
    import {
        settingLabelClass,
        settingRowClass,
        settingRowInlineClass,
    } from './styles';
    import ToggleSwitch from '../ToggleSwitch.svelte';

    const WEB_SEARCH_INFO =
        'Lets models search the internet using a provider server-side search tool. May have additional costs, see provider API documentation for details.';
    const WEB_FETCH_INFO =
        'Lets models fetch specific web pages using a provider server-side fetch tool. May have additional costs, see provider API documentation for details.';
    const CODE_EXECUTION_INFO =
        'Lets models execute code in a provider server-side sandbox environment. May have additional costs, see provider API documentation for details. ' +
        'Code runs in a container that persists temporarily on provider servers (OpenAI ~20 minutes idle, Anthropic ~30 days). Some providers do not offer a way to delete containers. ' +
        'OpenRouter containers sleep after 5 minutes idle, keep their files for ~30 days after last use, and are billed per second of sandbox time. ' +
        "Google runs code in a temporary sandbox with no persistent storage - nothing is stored on Google's servers to manage or delete.";
    const PROVIDER_FILE_STORAGE_INFO =
        'When turned on, stores uploaded files on provider servers. This can save tokens in multi-turn conversations. When turned off, files are sent and processed every turn, but are not stored on provider servers. With Provider File Storage off, inline files and chats are limited to 25MB (8MB on OpenRouter). See provider API documentation for details.';
    const FILE_UPLOADS_WARNING =
        "When file uploads are enabled, AirmailAI turns on Provider File Storage (PFS) and Code Execution (CE) by default. Any files uploaded through AirmailAI are stored on your device in IndexedDB; PFS also saves a copy on provider servers until you delete it, subject to each provider's retention policies. When combined with PFS, Code Execution enables Anthropic and OpenAI models to access, search, and process files directly in its sandbox container, which can reduce token usage. With OpenRouter, files are sent to the model and also copied into the sandbox container. With Google, files are read fully into the model's context each time they are used (including by CE), so they do not reduce token usage and large files may not fit. When PFS is turned off, the full file content must be sent to the provider with every relevant message, which can increase token usage. You can manage stored files anytime from the Files tab in the sidebar. PFS and CE may add provider-side costs, see each provider's API documentation for pricing and retention details.";
</script>

<DemoLockedPanel>
    <div class={[settingRowClass, settingRowInlineClass]}>
        <div class="flex items-center gap-1.25">
            <label for="enable-web-search" class={settingLabelClass}
                >Web Search</label
            >
            <InfoTip label="About web search" text={WEB_SEARCH_INFO} />
        </div>
        <ToggleSwitch
            id="enable-web-search"
            checked={settingsStore.enableWebSearch}
            label="Enable Web Search"
            onchange={(checked) => {
                settingsStore.enableWebSearch = checked;
            }}
        />
    </div>
    <div class={[settingRowClass, settingRowInlineClass]}>
        <div class="flex items-center gap-1.25">
            <label for="enable-web-fetch" class={settingLabelClass}
                >Web Fetch</label
            >
            <InfoTip label="About web fetch" text={WEB_FETCH_INFO} />
        </div>
        <ToggleSwitch
            id="enable-web-fetch"
            checked={settingsStore.enableWebFetch}
            label="Enable Web Fetch"
            onchange={(checked) => {
                settingsStore.enableWebFetch = checked;
            }}
        />
    </div>
    <div class={[settingRowClass, settingRowInlineClass]}>
        <div class="flex items-center gap-1.25">
            <label for="enable-code-execution" class={settingLabelClass}
                >Code Execution</label
            >
            <InfoTip label="About code execution" text={CODE_EXECUTION_INFO} />
        </div>
        <ToggleSwitch
            id="enable-code-execution"
            checked={settingsStore.enableCodeExecution}
            label="Enable Code Execution"
            onchange={(checked) => {
                settingsStore.enableCodeExecution = checked;
            }}
        />
    </div>
    <div class={[settingRowClass, settingRowInlineClass]}>
        <label for="enable-file-uploads" class={settingLabelClass}
            >File Uploads</label
        >
        <ToggleSwitch
            id="enable-file-uploads"
            checked={settingsStore.enableFileUploads}
            label="Enable File Uploads"
            onchange={(checked) => settingsStore.setFileUploadsEnabled(checked)}
        />
    </div>
    <div
        class={[
            settingRowClass,
            settingRowInlineClass,
            'pl-5',
            !settingsStore.enableFileUploads && 'opacity-50',
        ]}
    >
        <div class="flex items-center gap-1.25">
            <label for="enable-provider-file-storage" class={settingLabelClass}
                >Provider File Storage</label
            >
            <InfoTip
                label="About provider file storage"
                text={PROVIDER_FILE_STORAGE_INFO}
            />
        </div>
        <ToggleSwitch
            id="enable-provider-file-storage"
            checked={settingsStore.enableProviderFileStorage}
            label="Enable Provider File Storage"
            disabled={!settingsStore.enableFileUploads}
            onchange={(checked) => {
                settingsStore.setProviderFileStorageEnabled(checked);
            }}
        />
    </div>
    <p class="m-0 text-xs leading-normal text-fg-muted">
        {FILE_UPLOADS_WARNING}
    </p>
</DemoLockedPanel>
