<script lang="ts">
    import { THEMES } from '../constants';
    import Dropdown from '../Dropdown.svelte';
    import { settingsStore } from '../settingsStore.svelte';
    import {
        settingLabelClass,
        settingRowClass,
        settingRowInlineClass,
    } from './styles';

    const rangeClass =
        'range-styled appearance-none w-full h-1 bg-surface-raised border-0 rounded p-0 cursor-pointer outline-none';
</script>

<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="theme-select" class={settingLabelClass}>Theme</label>
    <Dropdown
        id="theme-select"
        bind:value={settingsStore.theme}
        options={THEMES}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="message-font" class={settingLabelClass}>Message Font</label>
    <Dropdown
        id="message-font"
        bind:value={settingsStore.messageFont}
        options={[
            {
                id: 'serif',
                name: 'Serif',
                fontFamily: 'var(--font-serif)',
            },
            {
                id: 'sans',
                name: 'Sans',
                fontFamily: 'var(--font-sans)',
            },
        ]}
    />
</div>
<div class={settingRowClass}>
    <label for="font-size" class={settingLabelClass}>Text Size</label>
    <input
        type="range"
        id="font-size"
        class={rangeClass}
        min="0"
        max="5"
        step="1"
        bind:value={settingsStore.fontSizeIndex}
    />
    <div class="flex justify-between text-[0.6875rem] text-fg -mt-1">
        <span>Smaller</span>
        <span>Larger</span>
    </div>
</div>
<div class={settingRowClass}>
    <label for="chat-width" class={settingLabelClass}>Chat Width</label>
    <input
        type="range"
        id="chat-width"
        class={rangeClass}
        min="0"
        max="100"
        step="1"
        bind:value={settingsStore.chatWidth}
    />
    <div class="flex justify-between text-[0.6875rem] text-fg -mt-1">
        <span>Narrower</span>
        <span>Wider</span>
    </div>
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="submit-keystroke" class={settingLabelClass}
        >Submit Keystroke</label
    >
    <Dropdown
        id="submit-keystroke"
        bind:value={settingsStore.submitKeystroke}
        options={[
            { id: 'enter', name: 'Enter' },
            { id: 'ctrl+enter', name: 'Control+Enter' },
        ]}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="autoscroll-mode" class={settingLabelClass}
        >Autoscroll Mode</label
    >
    <Dropdown
        id="autoscroll-mode"
        bind:value={settingsStore.autoscrollMode}
        options={[
            {
                id: 'pin-user-message',
                name: 'Scroll to user message',
            },
            { id: 'pin-bottom', name: 'Scroll to bottom' },
            { id: 'off', name: 'Off' },
        ]}
    />
</div>
