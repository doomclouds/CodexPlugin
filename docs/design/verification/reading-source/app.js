// This page searches the complete fixed reading corpus without hiding its body.
const tocToggle = document.querySelector('#toc-toggle');
const toc = document.querySelector('#toc-panel');
const wide = matchMedia('(min-width:1000px)');
let mobileOpen = false;
function syncToc() {
  toc.hidden = !wide.matches && !mobileOpen;
  tocToggle.setAttribute('aria-expanded', String(wide.matches || mobileOpen));
  tocToggle.textContent = mobileOpen ? '收起目录' : '展开六节目录';
}
syncToc();
wide.addEventListener('change', syncToc);
tocToggle.addEventListener('click', () => { mobileOpen = !mobileOpen; syncToc(); });
function jumpTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  if (id === 'toc-heading') { mobileOpen = true; syncToc(); }
  else if (!wide.matches) { mobileOpen = false; syncToc(); }
  target.scrollIntoView({ block: 'start', behavior: 'auto' });
  target.focus({ preventScroll: true });
}
for (const link of document.querySelectorAll('[data-jump]')) {
  link.addEventListener('click', event => { event.preventDefault(); jumpTo(link.dataset.jump); });
}
const tocLinks = [...document.querySelectorAll('.toc-link')];
const headings = [...document.querySelectorAll('.section-heading')];
function updateCurrent() {
  let current = headings[0]?.id;
  for (const heading of headings) if (heading.getBoundingClientRect().top <= 180) current = heading.id;
  for (const link of tocLinks) {
    if (link.dataset.jump === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
addEventListener('scroll', updateCurrent, { passive: true });
updateCurrent();
const queryInput = document.querySelector('#reading-search');
const clearButton = document.querySelector('#clear-search');
const searchStatus = document.querySelector('#search-status');
const results = document.querySelector('#search-results');
const empty = document.querySelector('#search-empty');
const records = [...document.querySelectorAll('[data-search-record]')].map(element => ({
  id: element.dataset.target || element.id,
  title: element.dataset.title,
  text: element.querySelector('[data-fixed-body]')?.textContent || element.textContent,
}));
function search() {
  const query = queryInput.value.trim();
  results.replaceChildren();
  clearButton.disabled = queryInput.value.length === 0;
  empty.hidden = true;
  if (!query) { searchStatus.textContent = '搜索仅在这篇正文与固定术语中进行，全文始终保留。'; return; }
  const folded = query.toLocaleLowerCase('zh-CN');
  const matches = records.filter(record => (record.title + ' ' + record.text).toLocaleLowerCase('zh-CN').includes(folded));
  searchStatus.textContent = `找到 ${matches.length} 处相关章节或术语。`;
  if (!matches.length) {
    empty.hidden = false;
    empty.querySelector('strong').textContent = `没有找到“${query}”`;
    return;
  }
  for (const record of matches) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'search-result';
    const title = document.createElement('strong'); title.textContent = record.title;
    const excerpt = document.createElement('span');
    const at = record.text.toLocaleLowerCase('zh-CN').indexOf(folded);
    const start = Math.max(0, at - 20);
    excerpt.textContent = (start ? '…' : '') + record.text.slice(start, start + 72) + (record.text.length > start + 72 ? '…' : '');
    button.append(title, excerpt);
    button.addEventListener('click', () => jumpTo(record.id));
    item.append(button); results.append(item);
  }
}
queryInput.addEventListener('input', event => { if (!event.isComposing) search(); });
queryInput.addEventListener('compositionend', search);
document.querySelector('#reading-search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
clearButton.addEventListener('click', () => { queryInput.value = ''; search(); queryInput.focus(); });
const copyButton = document.querySelector('#copy-terms');
const copyStatus = document.querySelector('#copy-status');
const copyDialog = document.querySelector('#copy-dialog');
const copyText = document.querySelector('#copy-text');
copyButton.addEventListener('click', async () => {
  const text = document.querySelector('#identity-example code').textContent;
  copyButton.disabled = true;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard write is unavailable');
    await navigator.clipboard.writeText(text);
    copyStatus.dataset.error = 'false';
    copyStatus.textContent = '已复制术语说明，可以粘贴到你的笔记。';
  } catch {
    copyStatus.dataset.error = 'true';
    copyStatus.textContent = '未能自动复制，已打开可选择的文本。';
    copyText.value = text;
    copyDialog.showModal(); copyText.focus(); copyText.select();
  } finally { copyButton.disabled = false; }
});
document.querySelector('#close-copy').addEventListener('click', () => copyDialog.close());
copyDialog.addEventListener('close', () => copyButton.focus());
