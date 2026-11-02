(async () => {
  document.documentElement.dataset.theme = 'dark';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const card = Array.from(document.querySelectorAll('.set-card')).find((c) => (c.textContent || '').includes('下载与网络'));
  if (card) card.scrollIntoView({ block: 'start' });
  await wait(600);
  return 'ok';
})()
