(async () => {
  document.documentElement.dataset.theme = 'light';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = Array.from(document.querySelectorAll('button,div,a')).find((b) => (b.textContent || '').trim() === '外观');
  if (btn) { btn.click(); }
  await wait(500);
  const sc = document.querySelector('.settings-scroll, .settings-body, main');
  if (sc) sc.scrollTop = 0;
  await wait(300);
  return 'ok';
})()
