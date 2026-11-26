(() => {
  const body = document.getElementById('note-body');
  const outline = document.getElementById('note-outline');
  if (!body || !outline) return;
  const copy = document.querySelector('[data-copy-address]');
  if (copy && navigator.clipboard && window.isSecureContext) {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      const address = document.querySelector('link[rel="canonical"]')?.href || location.href;
      try {
        await navigator.clipboard.writeText(address);
        copy.textContent = '주소 복사됨';
        document.querySelector('[data-copy-status]').textContent = '글 주소를 복사했습니다.';
      } catch { window.prompt('복사할 글 주소', address); }
    });
  }
  const headings = [...body.querySelectorAll('h2')];
  const originalToc = body.hasAttribute('data-legacy-outline') && headings.find(h => h.textContent.includes('목차'));
  const sections = headings.filter(h => h !== originalToc && h.id);
  if (!sections.length) return;
  if (originalToc && originalToc.nextElementSibling?.matches('ol, ul')) {
    originalToc.hidden = true;
    originalToc.nextElementSibling.hidden = true;
  }
  for (const heading of sections) {
    const link = document.createElement('a');
    link.href = '#' + encodeURIComponent(heading.id);
    link.textContent = heading.textContent.replace(/^[📌✅🚀✍️\s]+/u, '').trim();
    const item = document.createElement('li');
    item.append(link); outline.querySelector('ul').append(item);
  }
  outline.hidden = false;
})();
