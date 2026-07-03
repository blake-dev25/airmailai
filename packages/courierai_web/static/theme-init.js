const t = localStorage.getItem('courierai-theme');
if (t) document.documentElement.dataset.theme = t;
const mf = localStorage.getItem('courierai-message-font');
if (mf) document.documentElement.dataset.messageFont = mf;
