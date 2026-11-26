(() => {
  'use strict';
  const form = document.getElementById('compose');
  if (!form) return;
  const get = id => document.getElementById(id);
  const names = ['title', 'paper', 'venue', 'tags', 'summary', 'body', 'date'];
  const kinds = ['analysis', 'impression', 'study'];
  const locationKey = 'fieldnotes:writing-draft:v1';
  const guides = {
    analysis: ['논문이 묻는 질문', '핵심 방법', '실험에서 확인한 결과', '내 해석과 남은 질문'],
    impression: ['읽기 전의 예상', '생각이 달라진 대목', '내 연구에서 확인할 질문'],
    study: ['확인하고 싶은 점', '관찰과 근거', '다음에 해볼 일']
  };
  const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul', year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), n => n.toString(16).padStart(2,'0')).join('');
  let draftId = newId();
  const body = form.elements.body;
  const preview = get('draft-preview');
  const status = get('save-state');
  const message = get('editor-message');
  const exportStep = get('publish-next');
  const inputMode = get('edit-mode');
  const viewMode = get('preview-mode');
  const addTemplate = get('insert-template');
  let dirty = false;
  form.elements.date.value = today();

  function state() {
    const value = {id: draftId, kind: form.elements.kind.value};
    for (const name of names) value[name] = form.elements[name].value;
    return value;
  }
  function setState(value) {
    if (!value || !/^[a-f0-9]{8}$/.test(value.id) || !kinds.includes(value.kind)) return false;
    draftId = value.id; form.elements.kind.value = value.kind;
    for (const name of names) if (typeof value[name] === 'string') form.elements[name].value = value[name];
    if (!form.elements.date.value) form.elements.date.value = today();
    return true;
  }
  try {
    const saved = localStorage.getItem(locationKey);
    if (saved && setState(JSON.parse(saved))) status.textContent = '저장된 초안 불러옴';
  } catch { status.textContent = '브라우저 저장을 사용할 수 없음'; }
  function save() {
    dirty = true;
    try { localStorage.setItem(locationKey, JSON.stringify(state())); status.textContent = '이 브라우저에 저장됨'; }
    catch { status.textContent = '자동 저장 불가 · 파일로 보관하세요'; }
  }
  function syncTools() {
    addTemplate.disabled = Boolean(body.value.trim());
    if (addTemplate.disabled) addTemplate.title = '빈 본문에 글 틀을 넣을 수 있습니다.';
    else addTemplate.removeAttribute('title');
  }
  function onEdit() {
    save(); syncTools();
    exportStep.hidden = true; message.textContent = '';
    body.setCustomValidity(''); form.elements.paper.setCustomValidity('');
  }
  form.addEventListener('input', onEdit);
  get('insert-template').addEventListener('click', () => {
    if (body.value.trim()) return;
    body.value = guides[form.elements.kind.value].map(x => '## '+x+'\n\n').join('\n');
    onEdit(); showPreview(false); body.focus();
  });

  // Keep TeX intact while Markdown handles tables, lists and code.
  const md = typeof window.markdownit === 'function' ? window.markdownit({html:false, linkify:false}) : null;
  if (md) {
    md.inline.ruler.before('escape', 'note_math', (s, silent) => {
      if (s.src.slice(s.pos, s.pos+2) !== '$$') return false;
      const end = s.src.indexOf('$$',s.pos+2);
      if (end < 0) return false;
      if (!silent) {
        const token = s.push('note_math','',0);
        token.content = s.src.slice(s.pos+2,end);
      }
      s.pos = end+2; return true;
    });
    md.renderer.rules.note_math = (tokens, i) => {
      const tex = tokens[i].content;
      const delimiters = tex.includes('\n') ? ['\\[','\\]'] : ['\\(','\\)'];
      return delimiters[0]+md.utils.escapeHtml(tex.trim())+delimiters[1];
    };
  }
  function showPreview(enabled) {
    body.hidden = enabled; preview.hidden = !enabled;
    inputMode.setAttribute('aria-pressed',String(!enabled)); viewMode.setAttribute('aria-pressed',String(enabled));
    if (!enabled) return;
    if (window.MathJax?.typesetClear) window.MathJax.typesetClear([preview]);
    if (!body.value.trim()) preview.textContent = '본문을 입력하면 이곳에서 미리 볼 수 있습니다.';
    else if (!md) preview.textContent = body.value;
    else {
      preview.innerHTML = md.render(body.value);
      const renderMath = () => window.MathJax?.typesetPromise?.([preview]).catch(() => {});
      if (window.MathJax?.startup?.promise) window.MathJax.startup.promise.then(renderMath);
    }
  }
  inputMode.addEventListener('click', () => { showPreview(false); body.focus(); });
  viewMode.addEventListener('click', () => showPreview(true));

  function fileFor(d) {
    const slug = d.title.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    // Bound UTF-8 length well below Git's filename limit, including Hangul.
    const name = Array.from(slug).slice(0,44).join('').replace(/-$/,'') || 'note';
    return d.date+'-'+name+'-'+d.id+'.md';
  }
  function markdownFor(d) {
    const str = JSON.stringify;
    const front = ['---','layout: note','title: '+str(d.title.trim()),'date: '+str(d.date+' 00:00:00 +0900'),
      'categories: ['+(d.kind === 'study' ? 'Study' : 'Paper-Review')+']','note_kind: '+d.kind,'use_math: true','comments: true'];
    if (d.paper.trim()) front.push('paper_url: '+str(d.paper.trim()));
    if (d.venue.trim()) front.push('venue: '+str(d.venue.trim()));
    if (d.summary.trim()) front.push('description: '+str(d.summary.trim()));
    const tags = [...new Set(d.tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean))];
    if (tags.length) front.push('tags: '+str(tags));
    // Jekyll processes Liquid before fenced code or Markdown. Keep pasted examples literal.
    const literalBody = d.body.trim().replace(/\{(?:\{|%)/g, opener => '{{ '+ "'" + opener + "'" +' }}');
    return front.concat('---','',literalBody,'').join('\n');
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const d = state();
    if (!d.title.trim()) { form.elements.title.focus(); message.textContent='제목을 입력해 주세요.'; return; }
    if (!d.body.trim() || d.body.trim() === guides[d.kind].map(x=>'## '+x+'\n\n').join('\n').trim()) {
      showPreview(false); body.setCustomValidity('본문 내용을 입력해 주세요.'); body.reportValidity(); body.focus(); return;
    }
    if (d.paper.trim() && !/^https?:\/\//i.test(d.paper.trim())) {
      form.elements.paper.setCustomValidity('http 또는 https 원문 주소를 입력해 주세요.');form.elements.paper.reportValidity();return;
    }
    const link = document.createElement('a'), filename = fileFor(d);
    const url = URL.createObjectURL(new Blob([markdownFor(d)], {type:'text/markdown;charset=utf-8'}));
    link.href=url; link.download=filename; document.body.append(link); link.click(); link.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url),30000);
    get('export-name').textContent=filename; exportStep.hidden=false;
    message.textContent='발행용 파일을 만들었습니다. 초안은 계속 편집할 수 있습니다.';
    exportStep.querySelector('a').focus();
  });
  get('reset-draft').addEventListener('click', () => {
    const hasText = names.some(n=>n!=='date' && form.elements[n].value.trim());
    if ((dirty || hasText) && !window.confirm('현재 초안을 비우고 새 글을 시작할까요?')) return;
    form.reset(); form.elements.date.value=today(); draftId=newId(); dirty=false;
    body.setCustomValidity(''); form.elements.paper.setCustomValidity('');
    try { localStorage.removeItem(locationKey); status.textContent='새 초안'; }
    catch { status.textContent='브라우저 저장을 사용할 수 없음'; }
    exportStep.hidden=true; message.textContent=''; syncTools(); showPreview(false); form.elements.title.focus();
  });
  syncTools(); form.hidden = false;
})();
