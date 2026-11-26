(() => {
  const library = document.querySelector('[data-library]');
  if (!library) return;
  const entries = [...library.querySelectorAll('[data-entry]')].map(element => ({
    element, kind: element.dataset.kind, tags: JSON.parse(element.dataset.tags || '[]'),
    text: element.textContent.normalize('NFC').toLocaleLowerCase()
  }));
  if (!entries.length) return;
  const query = library.querySelector('[data-query]');
  const types = [...library.querySelectorAll('[data-kind-filter]')];
  const topics = [...library.querySelectorAll('[data-topic]')];
  let kind = '', topic = '';
  function update() {
    const words = query.value.normalize('NFC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    let count = 0;
    for (const item of entries) {
      const matches = (!kind || item.kind === kind) && (!topic || item.tags.includes(topic)) && words.every(w => item.text.includes(w));
      item.element.hidden = !matches;
      if (matches) count++;
    }
    for (const b of types) b.setAttribute('aria-pressed', String(b.dataset.kindFilter === kind));
    for (const b of topics) b.setAttribute('aria-pressed', String(b.dataset.topic === topic));
    library.querySelector('[data-total]').textContent = count;
    library.querySelector('[data-found]').textContent = count + '개의 글';
    library.querySelector('[data-no-match]').hidden = count !== 0;
  }
  for (const b of types) b.addEventListener('click', () => { kind = b.dataset.kindFilter; update(); });
  for (const b of topics) b.addEventListener('click', () => { topic = topic === b.dataset.topic ? '' : b.dataset.topic; update(); });
  query.addEventListener('input', update);
  library.querySelector('[data-clear]').addEventListener('click', () => {
    kind = ''; topic = ''; query.value = ''; update(); query.focus();
  });
  for (const el of library.querySelectorAll('[data-control]')) el.hidden = false;
})();
