(async () => {
  const byText = (t) => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes(t));
  const agree = byText('我已阅读并同意');
  if (agree) { agree.click(); await new Promise((r) => setTimeout(r, 600)); }
  const skip = byText('跳过');
  if (skip) { skip.click(); await new Promise((r) => setTimeout(r, 600)); }
  return document.body.innerText.slice(0, 80);
})()
