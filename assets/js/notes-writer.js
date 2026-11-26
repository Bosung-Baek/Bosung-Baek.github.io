(() => {
  'use strict';
  const form = document.getElementById('compose');
  if (!form) return;
  const $ = id => document.getElementById(id);
  const repo = form.dataset.repo, branch = form.dataset.branch, site = form.dataset.site || '';
  const API = 'https://api.github.com/repos/' + repo;
  const DRAFT_KEY = 'fieldnotes:writing-draft:v1';
  const TOKEN_KEY = 'notes:github-token:v1';
  const VIEW_KEY = 'notes:editor-view:v1';
  const FIELDS = ['title', 'paper', 'venue', 'tags', 'summary', 'body', 'date'];
  const KINDS = ['analysis', 'impression', 'study'];
  const IMAGE_TYPES = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'};
  const guides = {
    analysis: ['논문이 묻는 질문', '핵심 방법', '실험에서 확인한 결과', '내 해석과 남은 질문'],
    impression: ['읽기 전의 예상', '생각이 달라진 대목', '내 연구에서 확인할 질문'],
    study: ['확인하고 싶은 점', '관찰과 근거', '다음에 해볼 일']
  };
  const body = form.elements.body;
  const editor = $('editor'), preview = $('draft-preview');
  const status = $('save-state'), message = $('editor-message');
  const publishButton = $('publish'), addTemplate = $('insert-template');
  const localImages = new Map();   // site path -> object URL, so a fresh upload shows before the site rebuilds
  let draftId = newId();
  let editing = null;              // the published post being edited, if any
  let token = '';
  let connection = 'none';
  let uploads = 0;

  function newId() { return Array.from(crypto.getRandomValues(new Uint8Array(4)), n => n.toString(16).padStart(2, '0')).join(''); }
  function today() { return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()); }
  function say(text, link) {
    message.textContent = text || '';
    if (!link) return;
    const a = document.createElement('a');
    a.href = link.href; a.textContent = link.text; a.target = '_blank'; a.rel = 'noopener';
    message.append(' ', a);
  }

  /* ── front matter: keep lines this editor does not manage exactly as they were ── */
  function splitFront(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
    return m ? {front: m[1], body: text.slice(m[0].length)} : {front: '', body: text};
  }
  function blocksOf(front) {
    const blocks = [];
    for (const line of front.split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*)[ \t]*:/.exec(line);
      if (m) blocks.push({key: m[1], lines: [line]});
      else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
      else blocks.push({key: '', lines: [line]});
    }
    return blocks;
  }
  function unquote(text) {
    const s = text.trim();
    if (s.startsWith('"')) { try { return String(JSON.parse(s)); } catch { /* fall through */ } }
    if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    return s.replace(/\s+#.*$/, '');
  }
  function valueOf(block) {
    if (!block) return '';
    const first = block.lines[0].replace(/^[^:]*:/, '');
    const rest = block.lines.slice(1);
    const items = rest.map(l => /^\s*-\s+(.*)$/.exec(l)).filter(Boolean).map(m => unquote(m[1]));
    if (!first.trim() && items.length) return items;
    const joined = [first, ...rest].map(s => s.trim()).filter(Boolean).join(' ');
    if (joined.startsWith('[')) {
      try { return JSON.parse(joined).map(String); }
      catch { return joined.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean); }
    }
    return unquote(joined);
  }
  function metaFrom(blocks) {
    const get = key => valueOf(blocks.find(b => b.key === key));
    const text = key => { const v = get(key); return Array.isArray(v) ? v.join(', ') : v; };
    const categories = [].concat(get('categories') || []).join(' ');
    const noteKind = text('note_kind');
    const titleKey = blocks.some(b => b.key === 'paper_title') ? 'paper_title' : 'title';
    return {
      titleKey, title: text(titleKey), date: text('date').slice(0, 10),
      kind: /\bStudy\b/.test(categories) ? 'study' : KINDS.includes(noteKind) ? noteKind : 'analysis',
      paper: text('paper_url'), venue: text('venue'), summary: text('description'),
      tags: [].concat(get('tags') || []).join(', ')
    };
  }
  function startEditing(path, sha, front) {
    const blocks = blocksOf(front);
    const meta = metaFrom(blocks);
    editing = {path, sha, front, blocks, titleKey: meta.titleKey, date: meta.date, kind: meta.kind, draft: path.startsWith('_drafts/')};
    $('editing-label').textContent = editing.draft ? '초안 검토 중' : '올린 글 수정 중';
    $('editing-name').textContent = path.replace(/^_(posts|drafts)\//, '');
    $('editing-note').hidden = false;
    refreshButtons();
    return meta;
  }
  function stopEditing() {
    editing = null;
    $('editing-note').hidden = true;
    refreshButtons();
  }

  /* ── draft kept in this browser ── */
  function state() {
    const value = {id: draftId, kind: form.elements.kind.value};
    for (const name of FIELDS) value[name] = form.elements[name].value;
    if (editing) value.source = {path: editing.path, sha: editing.sha, front: editing.front};
    return value;
  }
  function setState(value) {
    if (!value || !/^[a-f0-9]{8}$/.test(value.id) || !KINDS.includes(value.kind)) return false;
    draftId = value.id; form.elements.kind.value = value.kind;
    for (const name of FIELDS) if (typeof value[name] === 'string') form.elements[name].value = value[name];
    if (!form.elements.date.value) form.elements.date.value = today();
    const s = value.source;
    if (s && typeof s.path === 'string' && typeof s.sha === 'string' && typeof s.front === 'string') startEditing(s.path, s.sha, s.front);
    return true;
  }
  function save() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state())); status.textContent = '초안 저장됨'; }
    catch { status.textContent = '자동 저장 불가 · 파일로 보관하세요'; }
  }
  function hasText() { return FIELDS.some(n => n !== 'date' && form.elements[n].value.trim()); }
  function syncTools() {
    addTemplate.disabled = Boolean(body.value.trim());
    addTemplate.title = addTemplate.disabled ? '본문이 비어 있을 때 넣을 수 있습니다.' : '';
  }
  function onEdit() {
    save(); syncTools(); schedulePreview();
    body.setCustomValidity(''); form.elements.paper.setCustomValidity('');
  }

  /* ── preview ── */
  const md = typeof window.markdownit === 'function' ? window.markdownit({html: false, linkify: false}) : null;
  if (md) {
    // Keep TeX intact while Markdown handles tables, lists and code.
    md.inline.ruler.before('escape', 'note_math', (s, silent) => {
      if (s.src.slice(s.pos, s.pos + 2) !== '$$') return false;
      const end = s.src.indexOf('$$', s.pos + 2);
      if (end < 0) return false;
      if (!silent) s.push('note_math', '', 0).content = s.src.slice(s.pos + 2, end);
      s.pos = end + 2; return true;
    });
    md.renderer.rules.note_math = (tokens, i) => {
      const tex = tokens[i].content;
      const d = tex.includes('\n') ? ['\\[', '\\]'] : ['\\(', '\\)'];
      return d[0] + md.utils.escapeHtml(tex.trim()) + d[1];
    };
  }
  let previewTimer = 0;
  function renderPreview() {
    if (editor.dataset.mode === 'edit') return;
    if (window.MathJax && window.MathJax.typesetClear) window.MathJax.typesetClear([preview]);
    const empty = !body.value.trim();
    preview.classList.toggle('is-empty', empty);
    if (empty) { preview.textContent = '본문을 쓰면 여기에 발행될 모습이 보입니다.'; return; }
    if (!md) { preview.textContent = body.value; return; }
    preview.innerHTML = md.render(body.value);
    for (const img of preview.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (localImages.has(src)) img.src = localImages.get(src);
      else if (src.startsWith('/assets/')) img.addEventListener('error', () => { img.src = 'https://raw.githubusercontent.com/' + repo + '/' + branch + src; }, {once: true});
    }
    const typeset = () => window.MathJax && window.MathJax.typesetPromise && window.MathJax.typesetPromise([preview]).catch(() => {});
    if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) window.MathJax.startup.promise.then(typeset);
  }
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 300); }
  function setView(mode) {
    editor.dataset.mode = mode;
    for (const b of editor.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
    try { localStorage.setItem(VIEW_KEY, mode); } catch { /* not essential */ }
    renderPreview();
  }
  for (const b of editor.querySelectorAll('[data-view]')) b.addEventListener('click', () => { setView(b.dataset.view); if (b.dataset.view !== 'preview') body.focus(); });

  /* ── writing tools ── */
  function insert(text) {
    body.focus();
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { done = false; }   // keeps undo history
    if (!done) { body.setRangeText(text, body.selectionStart, body.selectionEnd, 'end'); onEdit(); }
  }
  function selected() { return body.value.slice(body.selectionStart, body.selectionEnd); }
  function wrap(before, after, placeholder) {
    const start = body.selectionStart, inner = selected() || placeholder;
    insert(before + inner + after);
    body.setSelectionRange(start + before.length, start + before.length + inner.length);
  }
  function prefixLines(prefix) {
    const start = body.value.lastIndexOf('\n', body.selectionStart - 1) + 1;
    body.setSelectionRange(start, body.selectionEnd);
    insert(selected().split('\n').map(line => prefix + line).join('\n'));
  }
  function insertBlock(text) {
    const before = body.value.slice(0, body.selectionStart);
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    insert(lead + text + '\n');
  }
  const tools = {
    heading: () => prefixLines('## '),
    bold: () => wrap('**', '**', '굵은 글씨'),
    list: () => prefixLines('- '),
    link: () => wrap('[', '](https://)', '링크 글자'),
    code: () => { const s = selected(); if (!s || s.includes('\n')) insertBlock('```\n' + (s || '코드') + '\n```'); else wrap('`', '`', '코드'); },
    math: () => wrap('$$', '$$', 'x^2'),
    table: () => insertBlock('| 항목 | 값 |\n| --- | --- |\n|  |  |'),
    image: () => $('image-file').click()
  };
  for (const b of editor.querySelectorAll('[data-tool]')) b.addEventListener('click', () => tools[b.dataset.tool]());
  body.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b') { event.preventDefault(); tools.bold(); }
    else if (key === 'k') { event.preventDefault(); tools.link(); }
  });
  form.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    else if (event.key === 'Enter') { event.preventDefault(); publish(); }
  });
  addTemplate.addEventListener('click', () => {
    if (body.value.trim()) return;
    body.value = guides[form.elements.kind.value].map(x => '## ' + x + '\n\n').join('\n');
    onEdit(); body.focus();
  });

  /* ── GitHub ── */
  function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function textFromBase64(b64) { return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0))); }
  async function gh(path, options) {
    const headers = {Accept: 'application/vnd.github+json'};
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try { response = await fetch(API + path, Object.assign({headers, cache: 'no-store'}, options)); }
    catch { throw Object.assign(new Error('network'), {status: 0}); }
    if (!response.ok) throw Object.assign(new Error('github'), {status: response.status});
    return response.json();
  }
  function explain(error) {
    switch (error.status) {
      case 0: return '인터넷 연결을 확인해 주세요.';
      case 401: return '토큰이 만료되었거나 올바르지 않습니다. 아래 "GitHub 연결"에서 다시 등록해 주세요.';
      case 403: case 404: return '이 저장소에 쓸 권한이 없습니다. 토큰의 저장소 선택과 Contents: Read and write 권한을 확인해 주세요.';
      case 409: return '그 사이 저장소의 파일이 바뀌었습니다. 잠시 뒤 다시 눌러 주세요.';
      case 422: return '같은 이름의 파일이 이미 있거나 그 사이 내용이 바뀌었습니다. "올린 글 고치기"에서 다시 불러와 주세요.';
      default: return 'GitHub 응답 오류(' + error.status + ')입니다. 잠시 뒤 다시 시도해 주세요.';
    }
  }
  const connectionText = {
    none: ['미등록', '토큰이 등록되지 않았습니다. 발행을 누르면 GitHub 화면이 열립니다.'],
    checking: ['확인 중', '연결 상태를 확인하는 중입니다.'],
    ok: ['연결됨', '연결되었습니다. 이 화면에서 바로 발행하고 그림을 붙여넣을 수 있습니다.'],
    readonly: ['권한 부족', '토큰이 읽기 전용입니다. Contents 권한을 Read and write로 바꿔 주세요.'],
    invalid: ['토큰 오류', '토큰이 만료되었거나 올바르지 않습니다. 새 토큰을 등록해 주세요.'],
    denied: ['접근 불가', '이 토큰으로는 이 저장소에 접근할 수 없습니다. 토큰의 저장소 선택을 확인해 주세요.'],
    offline: ['오프라인', 'GitHub에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.']
  };
  function refreshButtons() {
    const direct = connection === 'ok';
    publishButton.textContent = direct ? (editing && !editing.draft ? '수정 발행' : '발행') : 'GitHub에서 발행';
    publishButton.disabled = uploads > 0;
    $('save-draft').hidden = !(direct && editing && editing.draft);
  }
  function setConnection(value) {
    connection = value;
    const chip = $('connect-chip');
    chip.textContent = connectionText[value][0]; chip.dataset.state = value;
    $('connect-state').textContent = connectionText[value][1];
    $('token-clear').hidden = !token;
    refreshButtons();
  }
  async function checkConnection() {
    if (!token) { setConnection('none'); return; }
    setConnection('checking');
    try {
      const info = await gh('');
      setConnection(info.permissions && info.permissions.push === false ? 'readonly' : 'ok');
      if (connection === 'ok') loadDrafts();   // signed-in listing is not rate limited
    } catch (error) {
      setConnection(error.status === 401 ? 'invalid' : error.status === 0 ? 'offline' : 'denied');
    }
  }
  $('token-save').addEventListener('click', async () => {
    const value = $('token-input').value.trim();
    if (!value) { $('token-input').focus(); return; }
    token = value;
    await checkConnection();
    if (connection === 'ok') {
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* works for this visit only */ }
      $('token-input').value = '';
    } else if (connection !== 'offline') {
      token = ''; $('token-clear').hidden = true; refreshButtons();   // keep the reason on screen, do not store a token that does not work
    }
  });
  $('token-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('token-save').click(); } });
  $('token-clear').addEventListener('click', () => {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
    setConnection('none');
  });

  /* ── images: paste, drop or pick ── */
  function swap(mark, text) {
    const at = body.value.indexOf(mark);
    if (at < 0) return;
    const caret = body.selectionStart;
    body.value = body.value.slice(0, at) + text + body.value.slice(at + mark.length);
    const moved = caret > at ? Math.max(at, caret + text.length - mark.length) : caret;
    body.setSelectionRange(moved, moved);
    onEdit();
  }
  async function addImages(fileList) {
    const files = [...fileList].filter(f => IMAGE_TYPES[f.type]);
    if (!files.length) return;
    if (connection !== 'ok') {
      say('그림을 바로 올리려면 아래 "GitHub 연결"에서 토큰을 등록해 주세요.');
      return;
    }
    uploads += files.length; refreshButtons();
    for (const file of files) {
      const key = newId(), mark = '![그림 올리는 중…](uploading-' + key + ')';
      try {
        if (file.size > 10 * 1024 * 1024) throw Object.assign(new Error('size'), {tooLarge: true});
        insertBlock(mark);
        const path = 'assets/images/notes/' + draftId + '/' + key + '.' + IMAGE_TYPES[file.type];
        const content = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        await gh('/contents/' + encodePath(path), {method: 'PUT', body: JSON.stringify({message: 'Add an image for a note', content, branch})});
        localImages.set('/' + path, URL.createObjectURL(file));
        swap(mark, '![](/' + path + ')');
        say('그림을 올렸습니다. 대괄호 안에 그림 설명을 적어 두면 좋습니다.');
      } catch (error) {
        swap(mark, '');
        say(error.tooLarge ? '10MB가 넘는 그림은 올릴 수 없습니다.' : '그림을 올리지 못했습니다. ' + explain(error));
      } finally {
        uploads -= 1; refreshButtons();
      }
    }
  }
  body.addEventListener('paste', event => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter(f => IMAGE_TYPES[f.type]);
    if (!files.length) return;
    event.preventDefault(); addImages(files);
  });
  body.addEventListener('dragover', event => { if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
  body.addEventListener('drop', event => {
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault(); addImages(event.dataTransfer.files);
  });
  $('image-file').addEventListener('change', event => { addImages(event.target.files); event.target.value = ''; });

  /* ── paper details from an arXiv or DOI address ── */
  $('fetch-paper').addEventListener('click', async () => {
    const field = form.elements.paper;
    let url = field.value.trim();
    try { url = decodeURIComponent(url); } catch { /* use as typed */ }
    const arxiv = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/i.exec(url);
    const doi = /\b(10\.\d{4,9}\/[^\s?#]+)/.exec(url);
    if (!arxiv && !doi) { say('arXiv(arxiv.org/abs/…) 또는 DOI 주소일 때만 가져올 수 있습니다.'); field.focus(); return; }
    say('논문 정보를 가져오는 중입니다.');
    try {
      let title = '', venue = '';
      if (arxiv) {
        const r = await fetch('https://api.datacite.org/dois/10.48550/arXiv.' + arxiv[1]);
        if (!r.ok) throw new Error('lookup');
        const a = (await r.json()).data.attributes;
        title = a.titles[0].title; venue = 'arXiv ' + a.publicationYear;
      } else {
        const r = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi[1]));
        if (!r.ok) throw new Error('lookup');
        const m = (await r.json()).message;
        const parts = (m.published || m.issued || {})['date-parts'];
        title = (m.title || [])[0] || '';
        venue = [(m['container-title'] || [])[0] || (m.event && m.event.name), parts && parts[0] && parts[0][0]].filter(Boolean).join(' ');
      }
      title = title.replace(/\s+/g, ' ').trim();
      const kept = [];
      if (title) { if (form.elements.title.value.trim()) kept.push('제목'); else form.elements.title.value = title; }
      if (venue) { if (form.elements.venue.value.trim()) kept.push('학회·연도'); else form.elements.venue.value = venue; }
      onEdit();
      say(title ? '논문 정보를 채웠습니다.' + (kept.length ? ' 이미 적혀 있던 ' + kept.join(', ') + '은(는) 그대로 두었습니다.' : '') : '제목을 찾지 못했습니다.');
    } catch {
      say('논문 정보를 가져오지 못했습니다. 직접 입력해 주세요.');
    }
  });

  /* ── the file that gets published ── */
  function fileFor(d) {
    const slug = d.title.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    // Bound UTF-8 length well below Git's filename limit, including Hangul.
    const name = Array.from(slug).slice(0, 44).join('').replace(/-$/, '') || 'note';
    return d.date + '-' + name + '-' + d.id + '.md';
  }
  function frontFor(d) {
    const str = JSON.stringify;
    const category = d.kind === 'study' ? 'Study' : 'Paper-Review';
    const tags = [...new Set(d.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))];
    const optional = {
      paper_url: d.paper.trim() && 'paper_url: ' + str(d.paper.trim()),
      venue: d.venue.trim() && 'venue: ' + str(d.venue.trim()),
      description: d.summary.trim() && 'description: ' + str(d.summary.trim()),
      tags: tags.length && 'tags: ' + str(tags)
    };
    if (!editing) {
      return ['layout: note', 'title: ' + str(d.title.trim()), 'date: ' + str(d.date + ' 00:00:00 +0900'),
        'categories: [' + category + ']', 'note_kind: ' + d.kind, 'use_math: true', 'comments: true']
        .concat(Object.values(optional).filter(Boolean)).join('\n');
    }
    const blocks = editing.blocks.map(b => ({key: b.key, lines: b.lines.slice()}));
    const set = (key, line) => {
      const at = blocks.findIndex(b => b.key === key);
      if (!line) { if (at >= 0) blocks.splice(at, 1); }
      else if (at >= 0) blocks[at].lines = [line];
      else blocks.push({key, lines: [line]});
    };
    set(editing.titleKey, editing.titleKey + ': ' + str(d.title.trim()));
    if (d.date !== editing.date) set('date', 'date: ' + str(d.date + ' 00:00:00 +0900'));
    if (d.kind !== editing.kind) { set('categories', 'categories: [' + category + ']'); set('note_kind', 'note_kind: ' + d.kind); }
    for (const key of Object.keys(optional)) set(key, optional[key]);
    return blocks.map(b => b.lines.join('\n')).join('\n');
  }
  function markdownFor(d) {
    // Jekyll processes Liquid before fenced code or Markdown. Keep pasted examples literal.
    const literalBody = d.body.trim().replace(/\{(?:\{|%)/g, opener => "{{ '" + opener + "' }}");
    return ['---', frontFor(d), '---', '', literalBody, ''].join('\n');
  }
  function checked() {
    const d = state();
    if (!d.title.trim()) { form.elements.title.focus(); say('제목을 입력해 주세요.'); return null; }
    if (!d.body.trim() || d.body.trim() === guides[d.kind].map(x => '## ' + x + '\n\n').join('\n').trim()) {
      if (editor.dataset.mode === 'preview') setView('edit');
      body.setCustomValidity('본문 내용을 입력해 주세요.'); body.reportValidity(); body.focus(); return null;
    }
    if (d.paper.trim() && !/^https?:\/\//i.test(d.paper.trim())) {
      form.elements.paper.setCustomValidity('http 또는 https 원문 주소를 입력해 주세요.'); form.elements.paper.reportValidity(); return null;
    }
    if (/\]\(uploading-[a-f0-9]{8}\)/.test(d.body)) { say('아직 올리는 중인 그림이 있습니다. 잠시 뒤 다시 눌러 주세요.'); return null; }
    return d;
  }
  function pageFor(path, kind) {
    const slug = path.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    return site + '/' + (kind === 'study' ? 'study' : 'paper-review') + '/' + encodeURIComponent(slug) + '/';
  }
  async function publish() {
    const d = checked();
    if (!d) return;
    const text = markdownFor(d);
    // A draft is published by writing it into _posts under the chosen date and removing the draft file.
    const draft = editing && editing.draft ? {path: editing.path, sha: editing.sha} : null;
    const draftName = draft && /^_drafts\/\d{4}-\d{2}-\d{2}-/.test(draft.path) ? d.date + draft.path.slice('_drafts/'.length + 10) : fileFor(d);
    const path = draft ? '_posts/' + draftName : editing ? editing.path : '_posts/' + fileFor(d);
    if (connection !== 'ok') {
      if (draft) { say('초안을 발행하려면 아래 "GitHub 연결"에서 토큰을 등록해 주세요.'); return; }
      publishOnGitHub(path, text); return;
    }
    const wasEditing = Boolean(editing) && !draft;
    publishButton.disabled = true; say('발행하는 중입니다.');
    try {
      const request = {message: (wasEditing ? 'Update note: ' : 'Add note: ') + d.title.trim().slice(0, 60), content: bytesToBase64(new TextEncoder().encode(text)), branch};
      if (wasEditing) request.sha = editing.sha;
      const result = await gh('/contents/' + encodePath(path), {method: 'PUT', body: JSON.stringify(request)});
      // Further changes to this text now update the same post instead of creating a second one.
      startEditing(path, result.content.sha, splitFront(text).front);
      save();
      let leftover = '';
      if (draft) {
        try { await gh('/contents/' + encodePath(draft.path), {method: 'DELETE', body: JSON.stringify({message: 'Remove a published draft', sha: draft.sha, branch})}); }
        catch { leftover = ' 초안 파일은 지우지 못했습니다. 초안함에 남아 있으면 GitHub에서 지워 주세요.'; }
        loadDrafts();
      }
      say((wasEditing ? '수정 내용을 발행했습니다.' : '발행했습니다.') + leftover, {href: pageFor(path, d.kind), text: '글 열기 (반영까지 1~2분)'});
    } catch (error) {
      say('발행하지 못했습니다. ' + explain(error) + ' 초안은 그대로 남아 있습니다.');
    } finally {
      refreshButtons();
    }
  }
  // Without a token: hand the text to GitHub's own editor, so publishing is one Commit click there.
  async function publishOnGitHub(path, text) {
    const github = 'https://github.com/' + repo;
    if (!editing) {
      const base = github + '/new/' + branch + '?filename=' + encodeURIComponent(path);
      const full = base + '&value=' + encodeURIComponent(text);
      if (full.length <= 7000) {
        window.open(full, '_blank', 'noopener');
        say('GitHub 새 탭에서 Commit changes를 누르면 발행됩니다.');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        window.open(base, '_blank', 'noopener');
        say('글이 길어 본문을 클립보드에 복사했습니다. GitHub 새 탭의 빈 칸에 붙여넣기(Ctrl+V) 후 Commit changes를 누르세요.');
      } catch { say('본문을 복사하지 못했습니다. "파일로 받기"를 이용해 주세요.'); }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      window.open(github + '/edit/' + branch + '/' + encodePath(path), '_blank', 'noopener');
      say('수정한 전체 내용을 클립보드에 복사했습니다. GitHub 새 탭에서 기존 내용을 모두 지우고 붙여넣기(Ctrl+V) 후 Commit changes를 누르세요.');
    } catch { say('내용을 복사하지 못했습니다. "파일로 받기"를 이용해 주세요.'); }
  }
  publishButton.addEventListener('click', publish);
  $('save-draft').addEventListener('click', async () => {
    const d = checked();
    if (!d || !editing || !editing.draft) return;
    say('초안을 저장하는 중입니다.');
    try {
      const text = markdownFor(d);
      const request = {message: 'Update draft: ' + d.title.trim().slice(0, 60), content: bytesToBase64(new TextEncoder().encode(text)), branch, sha: editing.sha};
      const result = await gh('/contents/' + encodePath(editing.path), {method: 'PUT', body: JSON.stringify(request)});
      startEditing(editing.path, result.content.sha, splitFront(text).front);
      save();
      say('초안을 저장했습니다. 아직 사이트에는 보이지 않습니다.');
    } catch (error) {
      say('초안을 저장하지 못했습니다. ' + explain(error));
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const d = checked();
    if (!d) return;
    const link = document.createElement('a');
    const name = editing ? editing.path.replace(/^_(posts|drafts)\//, '') : fileFor(d);
    const url = URL.createObjectURL(new Blob([markdownFor(d)], {type: 'text/markdown;charset=utf-8'}));
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    say(name + ' 파일을 받았습니다.', {href: 'https://github.com/' + repo + '/upload/' + branch + '/_posts', text: 'GitHub 업로드 화면 열기'});
  });

  /* ── open a published post ── */
  async function openPost(path) {
    if (!/^_(posts|drafts)\/[^/]+\.(md|markdown)$/.test(path)) return;
    if (editing && editing.path === path && body.value.trim()) { form.scrollIntoView(); return; }
    if (hasText() && !window.confirm('지금 쓰던 내용을 닫고 이 글을 불러올까요? (쓰던 내용은 사라집니다)')) return;
    say('글을 불러오는 중입니다.');
    try {
      const file = await gh('/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(branch));
      const parts = splitFront(textFromBase64(file.content));
      draftId = newId();
      const meta = startEditing(path, file.sha, parts.front);
      form.elements.kind.value = meta.kind;
      form.elements.title.value = meta.title; form.elements.paper.value = meta.paper; form.elements.venue.value = meta.venue;
      form.elements.tags.value = meta.tags; form.elements.summary.value = meta.summary;
      form.elements.date.value = /^\d{4}-\d{2}-\d{2}$/.test(meta.date) ? meta.date : today();
      body.value = parts.body.replace(/^\s*\n/, '').replace(/\{\{ '(\{\{|\{%)' \}\}/g, '$1').replace(/\s+$/, '') + '\n';
      onEdit();
      say(editing.draft ? '초안을 불러왔습니다. 손글씨를 옮긴 부분을 확인하고 "발행"을 누르면 공개됩니다.' : '글을 불러왔습니다. 고친 뒤 "' + publishButton.textContent + '"을 누르세요.');
      form.scrollIntoView();
    } catch (error) {
      say('글을 불러오지 못했습니다. ' + (error.status === 404 ? '파일을 찾을 수 없습니다.' : explain(error)));
    }
  }
  for (const b of document.querySelectorAll('[data-open-post]')) b.addEventListener('click', () => openPost(b.dataset.openPost));
  /* ── drafts waiting for review (written by the Zotero routine) ── */
  async function loadDrafts() {
    const list = $('draft-list'), count = $('draft-count');
    let files = [];
    try { files = (await gh('/contents/_drafts?ref=' + encodeURIComponent(branch))).filter(f => f.type === 'file' && /\.(md|markdown)$/.test(f.name)); }
    catch (error) { if (error.status !== 404) { $('draft-hint').textContent = '초안 목록을 불러오지 못했습니다. ' + explain(error); return; } }
    list.textContent = '';
    count.textContent = String(files.length); count.dataset.state = files.length ? 'ok' : 'none';
    $('draft-hint').textContent = files.length ? '제목을 누르면 편집기에 불러옵니다. 확인하고 "발행"을 누르기 전까지는 사이트에 보이지 않습니다.' : '검토할 초안이 없습니다.';
    for (const file of files.sort((a, b) => b.name.localeCompare(a.name))) {
      const li = document.createElement('li'), button = document.createElement('button'), when = document.createElement('span');
      const match = /^(\d{4}-\d{2}-\d{2})-(.*?)(?:-[a-z0-9]{8})?\.(?:md|markdown)$/.exec(file.name);
      button.type = 'button'; button.className = 'link-button';
      button.textContent = match ? match[2].replace(/-/g, ' ') : file.name;
      button.addEventListener('click', () => openPost(file.path));
      when.className = 'when'; when.textContent = match ? match[1].replace(/-/g, '.') : '';
      li.append(button, when); list.append(li);
    }
  }
  function reset(ask) {
    if (ask && hasText() && !window.confirm('현재 내용을 비우고 새 글을 시작할까요?')) return;
    form.reset(); form.elements.date.value = today(); draftId = newId(); stopEditing();
    body.setCustomValidity(''); form.elements.paper.setCustomValidity('');
    try { localStorage.removeItem(DRAFT_KEY); status.textContent = '새 초안'; }
    catch { status.textContent = '브라우저 저장을 사용할 수 없음'; }
    say(''); syncTools(); renderPreview(); form.elements.title.focus();
  }
  $('reset-draft').addEventListener('click', () => reset(true));
  $('leave-editing').addEventListener('click', () => reset(true));

  /* ── Zotero: bring a paper's details, notes and annotations into the draft ── */
  const ZOTERO = 'https://api.zotero.org';
  const ZOTERO_KEY = 'notes:zotero-key:v1';
  const zoteroPanel = $('zotero-panel'), zoteroList = $('zotero-list'), zoteroQuery = $('zotero-query');
  let zoteroKey = '', zoteroUser = '', zoteroState = 'none';
  async function zot(path, params) {
    const url = new URL(ZOTERO + path);
    for (const name of Object.keys(params || {})) url.searchParams.set(name, params[name]);
    let response;
    try { response = await fetch(url, {headers: {'Zotero-API-Key': zoteroKey, 'Zotero-API-Version': '3'}}); }
    catch { throw Object.assign(new Error('network'), {status: 0}); }
    if (!response.ok) throw Object.assign(new Error('zotero'), {status: response.status});
    return response.json();
  }
  async function zotAll(path, params) {
    const all = [];
    for (let start = 0; start < 1000; start += 100) {
      const page = await zot(path, Object.assign({}, params, {limit: 100, start}));
      all.push(...page);
      if (page.length < 100) break;
    }
    return all;
  }
  function zoteroProblem(error) {
    if (error.status === 0) return '인터넷 연결을 확인해 주세요.';
    if (error.status === 403) return 'Zotero 키가 올바르지 않거나 라이브러리 읽기 권한이 없습니다.';
    if (error.status === 429) return 'Zotero 요청이 잠시 제한되었습니다. 조금 뒤 다시 시도해 주세요.';
    return 'Zotero 응답 오류(' + error.status + ')입니다.';
  }
  const zoteroText = {
    none: ['미등록', 'Zotero 키가 등록되지 않았습니다.'],
    checking: ['확인 중', 'Zotero 연결을 확인하는 중입니다.'],
    ok: ['연결됨', 'Zotero에 연결되었습니다.'],
    limited: ['권한 부족', '이 키로는 라이브러리를 읽을 수 없습니다. 키 설정에서 "Allow library access"를 켜 주세요.'],
    invalid: ['키 오류', 'Zotero 키가 올바르지 않습니다. 새 키를 등록해 주세요.'],
    offline: ['오프라인', 'Zotero에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.']
  };
  function setZotero(value, name) {
    zoteroState = value;
    const chip = $('zotero-chip');
    chip.textContent = zoteroText[value][0]; chip.dataset.state = value === 'limited' ? 'readonly' : value;
    $('zotero-state').textContent = zoteroText[value][1] + (value === 'ok' && name ? ' (계정: ' + name + ')' : '');
    $('zotero-clear').hidden = !zoteroKey;
  }
  async function checkZotero() {
    if (!zoteroKey) { setZotero('none'); return; }
    setZotero('checking');
    try {
      const info = await zot('/keys/current');
      zoteroUser = String(info.userID);
      setZotero(info.access && info.access.user && info.access.user.library ? 'ok' : 'limited', info.username);
    } catch (error) {
      setZotero(error.status === 0 ? 'offline' : 'invalid');
    }
  }
  $('zotero-save').addEventListener('click', async () => {
    const value = $('zotero-input').value.trim();
    if (!value) { $('zotero-input').focus(); return; }
    zoteroKey = value;
    await checkZotero();
    if (zoteroState === 'ok') {
      try { localStorage.setItem(ZOTERO_KEY, zoteroKey); } catch { /* works for this visit only */ }
      $('zotero-input').value = '';
    } else if (zoteroState !== 'offline') {
      zoteroKey = ''; $('zotero-clear').hidden = true;
    }
  });
  $('zotero-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('zotero-save').click(); } });
  $('zotero-clear').addEventListener('click', () => {
    zoteroKey = ''; zoteroUser = '';
    try { localStorage.removeItem(ZOTERO_KEY); } catch { /* nothing stored */ }
    setZotero('none'); zoteroPanel.hidden = true;
  });

  const VENUES = [[/computer vision and pattern recognition/i, 'CVPR'], [/international conference on computer vision/i, 'ICCV'],
    [/european conference on computer vision/i, 'ECCV'], [/neural information processing systems/i, 'NeurIPS'],
    [/international conference on machine learning/i, 'ICML'], [/international conference on learning representations/i, 'ICLR'],
    [/winter conference on applications of computer vision/i, 'WACV'], [/aaai conference on artificial intelligence/i, 'AAAI'],
    [/acm international conference on multimedia/i, 'ACM MM'], [/british machine vision/i, 'BMVC'],
    [/pattern analysis and machine intelligence/i, 'IEEE TPAMI'], [/international journal of computer vision/i, 'IJCV']];
  const COLORS = {'#ffd400': '노랑', '#ff6666': '빨강', '#5fb236': '초록', '#2ea8e5': '파랑', '#a28ae5': '보라', '#e56eee': '분홍', '#f19837': '주황', '#aaaaaa': '회색'};
  function creatorsOf(data) {
    return (data.creators || []).filter(c => !c.creatorType || c.creatorType === 'author')
      .map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(Boolean);
  }
  function venueOf(data) {
    const year = (/\d{4}/.exec(data.date || '') || [''])[0];
    let venue = data.conferenceName || data.proceedingsTitle || data.journalAbbreviation || data.publicationTitle
      || data.repository || data.university || (data.itemType === 'preprint' ? 'arXiv' : '');
    for (const [pattern, short] of VENUES) if (pattern.test(venue)) { venue = short; break; }
    venue = venue.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
    return [venue, year].filter(Boolean).join(' ');
  }
  function htmlToMarkdown(html) {
    const root = new DOMParser().parseFromString(html, 'text/html').body;
    const inline = node => [...node.childNodes].map(n => {
      if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ');
      if (n.nodeType !== 1) return '';
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') return '\n';
      if (tag === 'img' || tag === 'ul' || tag === 'ol') return '';
      if (tag === 'code') return '`' + n.textContent + '`';
      const inner = inline(n);
      if (tag === 'strong' || tag === 'b') return inner.trim() ? '**' + inner.trim() + '**' : '';
      if (tag === 'em' || tag === 'i') return inner.trim() ? '*' + inner.trim() + '*' : '';
      if (tag === 'a') { const href = n.getAttribute('href') || ''; return /^https?:/i.test(href) && inner.trim() ? '[' + inner.trim() + '](' + href + ')' : inner; }
      return inner;
    }).join('');
    const blocks = (node, indent) => {
      const out = [];
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { if (n.textContent.trim()) out.push(n.textContent.trim()); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) out.push('#'.repeat(Math.min(Number(tag[1]) + 2, 4)) + ' ' + inline(n).trim());
        else if (tag === 'p') { const text = inline(n).trim(); if (text) out.push(text); }
        else if (tag === 'ul' || tag === 'ol') {
          const lines = [];
          [...n.children].forEach((li, i) => {
            lines.push(indent + (tag === 'ol' ? (i + 1) + '. ' : '- ') + inline(li).trim());
            for (const nested of li.children) if (/^(ul|ol)$/i.test(nested.tagName)) lines.push(...blocks({childNodes: [nested]}, indent + '  '));
          });
          out.push(lines.join('\n'));
        }
        else if (tag === 'blockquote') out.push(blocks(n, indent).join('\n\n').split('\n').map(line => '> ' + line).join('\n'));
        else if (tag === 'pre') out.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```');
        else if (tag === 'hr') out.push('---');
        else out.push(...blocks(n, indent));
      }
      return out;
    };
    return blocks(root, '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // Handwriting arrives as stroke coordinates; draw each page's strokes into one picture.
  function inkPictures(annotations) {
    const pages = new Map();
    for (const a of annotations) {
      let position = a.annotationPosition || {};
      if (typeof position === 'string') { try { position = JSON.parse(position); } catch { position = {}; } }
      const paths = (position.paths || []).filter(p => p.length >= 4);
      if (!paths.length) continue;
      const page = a.annotationPageLabel || String((position.pageIndex || 0) + 1);
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page).push({paths, width: position.width || 2, color: a.annotationColor || '#222222'});
    }
    const pictures = [];
    for (const [page, groups] of pages) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const g of groups) for (const p of g.paths) for (let i = 0; i + 1 < p.length; i += 2) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
      }
      const pad = 12, scale = Math.min(2, 2400 / Math.max(x1 - x0 + pad * 2, y1 - y0 + pad * 2));
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil((x1 - x0 + pad * 2) * scale); canvas.height = Math.ceil((y1 - y0 + pad * 2) * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const g of groups) {
        ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(1, g.width * scale);
        for (const p of g.paths) {
          ctx.beginPath();
          for (let i = 0; i + 1 < p.length; i += 2) {
            const x = (p[i] - x0 + pad) * scale, y = (y1 - p[i + 1] + pad) * scale;   // PDF y grows upward
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      pictures.push({page, canvas});
    }
    return pictures;
  }
  async function uploadCanvas(canvas) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const path = 'assets/images/notes/' + draftId + '/' + newId() + '.png';
    const content = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    await gh('/contents/' + encodePath(path), {method: 'PUT', body: JSON.stringify({message: 'Add handwriting for a note', content, branch})});
    localImages.set('/' + path, URL.createObjectURL(blob));
    return '/' + path;
  }
  function materialFrom(data, notes, annotations) {
    const parts = [];
    const authors = creatorsOf(data);
    if (authors.length) parts.push('**저자** ' + authors.join(', '));
    const noteText = notes.map(n => htmlToMarkdown(n.note || '')).filter(Boolean);
    if (noteText.length) parts.push('## Zotero 메모', noteText.join('\n\n---\n\n'));
    const marks = annotations.filter(a => a.annotationType !== 'ink' && ((a.annotationText || '').trim() || (a.annotationComment || '').trim()));
    const colors = new Set(marks.filter(a => (a.annotationText || '').trim()).map(a => (a.annotationColor || '').toLowerCase()));
    if (marks.length) {
      const lines = marks.map(a => {
        const text = (a.annotationText || '').replace(/\s+/g, ' ').trim();
        const comment = (a.annotationComment || '').trim();
        const where = ['p.' + (a.annotationPageLabel || '?')];
        const color = COLORS[(a.annotationColor || '').toLowerCase()];
        if (text && colors.size > 1 && color) where.push(color);
        if (text) return '> ' + text + ' *(' + where.join(' · ') + ')*' + (comment ? '\n\n' + comment : '');
        return '**메모 (' + where[0] + ')** ' + comment;
      });
      parts.push('## 읽으며 표시한 부분', lines.join('\n\n'));
    }
    return parts.join('\n\n');
  }
  async function importFromZotero(item) {
    const data = item.data;
    if (!editing && hasText() && !window.confirm('지금 쓰던 내용을 이 논문으로 바꿀까요? (쓰던 내용은 사라집니다)')) return;
    say('Zotero에서 메모와 표시한 부분을 가져오는 중입니다.');
    try {
      const base = '/users/' + zoteroUser + '/items/';
      const flat = c => Object.assign({key: c.key}, c.data);
      const children = (await zotAll(base + item.key + '/children')).map(flat);
      const notes = children.filter(c => c.itemType === 'note');
      let annotations = [];
      // Only files stored in Zotero can carry annotations; a link to a PDF cannot, and asking for its children is an error.
      const files = children.filter(c => c.itemType === 'attachment' && c.linkMode !== 'linked_url');
      const linkOnly = children.some(c => c.itemType === 'attachment') && !files.length;
      for (const attachment of files) {
        try {
          annotations.push(...(await zotAll(base + attachment.key + '/children')).map(flat).filter(c => c.itemType === 'annotation'));
        } catch (error) {
          if (error.status !== 400) throw error;   // not a PDF, EPUB or snapshot
        }
      }
      annotations.sort((a, b) => String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex)));
      let material = materialFrom(data, notes, annotations);
      const pictures = inkPictures(annotations.filter(a => a.annotationType === 'ink'));
      let inkNote = '';
      if (pictures.length && connection === 'ok') {
        uploads += 1; refreshButtons();
        try {
          const lines = [];
          for (const picture of pictures) lines.push('![p.' + picture.page + ' 손글씨](' + (await uploadCanvas(picture.canvas)) + ')');
          material += '\n\n## 손글씨 필기\n\n' + lines.join('\n\n');
          inkNote = ' 손글씨 ' + pictures.length + '쪽을 그림으로 넣었습니다.';
        } catch (error) {
          inkNote = ' 손글씨 그림은 올리지 못했습니다. ' + explain(error);
        } finally { uploads -= 1; refreshButtons(); }
      } else if (pictures.length) {
        inkNote = ' 손글씨 ' + pictures.length + '쪽은 GitHub 연결 후 다시 가져오면 그림으로 들어갑니다.';
      }
      if (editing) {
        body.value = body.value.replace(/\s+$/, '') + '\n\n' + material + '\n';
      } else {
        form.reset(); draftId = draftId || newId();
        form.elements.kind.value = 'analysis';
        form.elements.title.value = (data.title || '').replace(/\s+/g, ' ').trim();
        form.elements.venue.value = venueOf(data);
        form.elements.paper.value = /^https?:/i.test(data.url || '') ? data.url : (data.DOI ? 'https://doi.org/' + data.DOI : '');
        form.elements.tags.value = (data.tags || []).filter(t => t.type !== 1).map(t => t.tag).join(', ');
        form.elements.date.value = today();
        body.value = guides.analysis.map(x => '## ' + x + '\n\n').join('\n') + (material ? '\n---\n\n' + material + '\n' : '');
      }
      onEdit(); zoteroPanel.hidden = true;
      const counts = [];
      if (notes.length) counts.push('메모 ' + notes.length + '개');
      const marked = annotations.filter(a => a.annotationType !== 'ink').length;
      if (marked) counts.push('표시 ' + marked + '개');
      const linkNote = linkOnly ? ' 이 논문은 Zotero에 PDF 링크만 있어 하이라이트·손글씨가 없습니다. PDF 파일을 Zotero에 저장하고 거기서 읽어야 표시가 남습니다.' : '';
      say('Zotero에서 가져왔습니다' + (counts.length ? ' (' + counts.join(', ') + ').' : '. 메모나 표시한 부분은 없었습니다.') + inkNote + linkNote);
      form.scrollIntoView();
    } catch (error) {
      say('Zotero에서 가져오지 못했습니다. ' + zoteroProblem(error));
    }
  }
  async function listZotero() {
    zoteroList.textContent = '';
    const status = document.createElement('li'); status.className = 'hint'; status.textContent = '불러오는 중입니다.';
    zoteroList.append(status);
    try {
      const params = {limit: 40, sort: 'dateModified', direction: 'desc'};
      if (zoteroQuery.value.trim()) params.q = zoteroQuery.value.trim();
      const items = (await zot('/users/' + zoteroUser + '/items/top', params)).filter(i => !['attachment', 'note', 'annotation'].includes(i.data.itemType));
      zoteroList.textContent = '';
      if (!items.length) { status.textContent = '찾은 논문이 없습니다.'; zoteroList.append(status); return; }
      for (const item of items) {
        const li = document.createElement('li'), button = document.createElement('button'), detail = document.createElement('span');
        button.type = 'button'; button.className = 'link-button'; button.textContent = item.data.title || '(제목 없음)';
        button.addEventListener('click', () => importFromZotero(item));
        const authors = creatorsOf(item.data);
        detail.className = 'when';
        detail.textContent = [authors.length > 1 ? authors[0] + ' 외' : authors[0], venueOf(item.data)].filter(Boolean).join(' · ');
        li.append(button, detail); zoteroList.append(li);
      }
    } catch (error) {
      status.textContent = zoteroProblem(error);
    }
  }
  $('zotero-open').addEventListener('click', () => {
    if (zoteroState !== 'ok') {
      say('먼저 아래 "Zotero 연결"에서 키를 등록해 주세요.');
      $('zotero').scrollIntoView();
      return;
    }
    zoteroPanel.hidden = !zoteroPanel.hidden;
    if (!zoteroPanel.hidden) { listZotero(); zoteroQuery.focus(); }
  });
  let zoteroTimer = 0;
  zoteroQuery.addEventListener('input', () => { clearTimeout(zoteroTimer); zoteroTimer = setTimeout(listZotero, 400); });
  zoteroQuery.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(zoteroTimer); listZotero(); } });
  $('zotero-close').addEventListener('click', () => { zoteroPanel.hidden = true; });

  /* ── start ── */
  form.elements.date.value = today();
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved && setState(JSON.parse(saved))) status.textContent = '저장된 초안 불러옴';
  } catch { status.textContent = '브라우저 저장을 사용할 수 없음'; }
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { token = ''; }
  try { zoteroKey = localStorage.getItem(ZOTERO_KEY) || ''; } catch { zoteroKey = ''; }
  form.addEventListener('input', onEdit);
  let view = 'split';
  try { view = localStorage.getItem(VIEW_KEY) || view; } catch { /* default */ }
  if (!['edit', 'split', 'preview'].includes(view)) view = 'split';
  syncTools(); form.hidden = false; setView(view); refreshButtons();
  checkConnection();
  checkZotero();
  loadDrafts();
  const wanted = new URLSearchParams(location.search).get('edit');
  if (wanted) {
    history.replaceState(null, '', location.pathname);
    openPost(wanted);
  }
})();
