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
    a.download = `courierai-openrouter-models-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Exported.');
});

btnClearChats.addEventListener('click', async () => {
    if (
        !confirm(
            'Delete all chat history? This also deletes locally stored files. Files on provider servers are not affected. Cannot be undone.'
        )
    )
        return;
    setLoading(true);
    setStatus('');
    const res = await chrome.runtime.sendMessage({ type: 'admin_clear_chats' });
    setLoading(false);
    if (res?.ok) {
        setStatus('Chat history deleted.');
    } else {
        setStatus(res?.message ?? 'Something went wrong.', true);
    }
});

btnClearAll.addEventListener('click', async () => {
    if (
        !confirm(
            'Delete all local storage? This removes your API keys, settings, chat history, and locally stored files. Files on provider servers are not affected. Cannot be undone.'
        )
    )
        return;
    setLoading(true);
    setStatus('');
    const res = await chrome.runtime.sendMessage({ type: 'admin_clear_all' });
    setLoading(false);
    if (res?.ok) {
        setStatus('All local storage deleted.');
    } else {
        setStatus(res?.message ?? 'Something went wrong.', true);
    }
});
