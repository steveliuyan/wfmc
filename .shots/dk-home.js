(async () => { document.documentElement.dataset.theme = 'dark'; await new Promise(r=>setTimeout(r,500)); return 'ok'; })()
