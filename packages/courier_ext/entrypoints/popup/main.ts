const statusEl = document.getElementById('status')!;
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
	btnClearChats.disabled = loading;
	btnClearAll.disabled = loading;
}

btnClearChats.addEventListener('click', async () => {
	if (!confirm('Delete all chat history? This cannot be undone.')) return;
	setLoading(true);
	setStatus('');
	const res = await chrome.runtime.sendMessage({ type: 'admin_clear_chats' });
	setLoading(false);
	if (res?.ok) {
		setStatus('Chat history deleted.');
	} else {
		setStatus('Something went wrong.', true);
	}
});

btnClearAll.addEventListener('click', async () => {
	if (
		!confirm(
			'Delete all storage? This removes your API keys, settings, and all chat history. Cannot be undone.'
		)
	)
		return;
	setLoading(true);
	setStatus('');
	const res = await chrome.runtime.sendMessage({ type: 'admin_clear_all' });
	setLoading(false);
	if (res?.ok) {
		setStatus('All storage deleted.');
	} else {
		setStatus('Something went wrong.', true);
	}
});
