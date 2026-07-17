import type { StorageRequest, StorageResponse } from '@airmailai/shared';
import { CACHE_KEY } from '../../openrouter-models';

const statusEl = document.getElementById('status')!;
const btnExport = document.getElementById(
    'btn-export-openrouter'
) as HTMLButtonElement;
const btnClearChats = document.getElementById(
    'btn-clear-chats'
) as HTMLButtonElement;
const btnClearAll = document.getElementById(
    'btn-clear-all'
) as HTMLButtonElement;

function setStatus(msg: string, error = false) {
    statusEl.textContent = msg;
    statusEl.className = `status${error ? ' error' : ''}`;
}

function setLoading(loading: boolean) {
    btnExport.disabled = loading;
    btnClearChats.disabled = loading;
    btnClearAll.disabled = loading;
}

btnExport.addEventListener('click', async () => {
    setStatus('');
    const result = await chrome.storage.local.get(CACHE_KEY);
    const cache = result[CACHE_KEY];
    if (!cache) {
        setStatus('No cache yet - open the model picker first.', true);
        return;
    }
    const blob = new Blob([JSON.stringify(cache, null, 2)], {
        type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `airmailai-openrouter-models-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Exported.');
});

async function runClear(request: StorageRequest, successMessage: string) {
    setLoading(true);
    setStatus('');
    const res: StorageResponse | undefined =
        await chrome.runtime.sendMessage(request);
    setLoading(false);
    if (res?.type === 'saved') {
        setStatus(successMessage);
    } else {
        setStatus(
            res?.type === 'error' ? res.message : 'Something went wrong.',
            true
        );
    }
}

btnClearChats.addEventListener('click', async () => {
    if (
        !confirm(
            'Delete all chat history? This also deletes locally stored files. Files on provider servers are not affected. Cannot be undone.'
        )
    )
        return;
    await runClear({ type: 'clear_chats' }, 'Chat history deleted.');
});

btnClearAll.addEventListener('click', async () => {
    if (
        !confirm(
            'Delete all local storage? This removes your API keys, settings, chat history, and locally stored files. Files on provider servers are not affected. Cannot be undone.'
        )
    )
        return;
    await runClear({ type: 'clear_all' }, 'All local storage deleted.');
});
