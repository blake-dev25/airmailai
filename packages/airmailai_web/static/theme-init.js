const t = localStorage.getItem('airmailai-theme');
if (t) document.documentElement.dataset.theme = t;
const mf = localStorage.getItem('airmailai-message-font');
if (mf) document.documentElement.dataset.messageFont = mf;
