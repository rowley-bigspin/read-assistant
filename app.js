/**
 * ReadFlow — 主应用逻辑
 * 依赖：epub.js (ePub global)、JSZip
 */

'use strict';

/* ============================================================
   状态
   ============================================================ */
const State = {
  book: null,
  rendition: null,
  currentCfi: null,
  highlights: [],
  bookmarks: [],
  notes: [],
  fontSize: 18,
  theme: 'light',
  readMode: 'paginated',
  tocItems: [],
  selectedText: '',
  selectedCfi: '',
  selectedContext: { before: '', after: '' },
  books: [],
  settings: {},
  chatMessages: [],
  currentBookRecord: null,
  noteFilter: { query: '', chapter: 'all' },
  noteIdCounter: 1,
  // 侧边栏收起状态
  sidebarState: {
    notes: true,  // true = 展开
    ai: true,
  },
  // 笔记章节展开状态（用于记忆每个章节的折叠状态）
  chapterFoldState: {},
  // 文学深读模式
  deepReadingMode: 'auto',   // 'auto' | 'on' | 'off'
  deepReadFormat: 'deep',    // 'brief' | 'deep'
};

/* ============================================================
   DOM 快捷引用
   ============================================================ */
const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
  welcomeScreen:   $('welcome-screen'),
  readerScreen:   $('reader-screen'),
  fileInput:      $('file-input'),
  uploadZone:     $('upload-zone'),
  uploadBtn:      $('upload-btn'),
  libraryList:    $('library-list'),
  libraryStatus:  $('library-status'),
  loadDemoBtn:    $('load-demo-btn'),
  bookTitleBar:   $('book-title-bar'),
  bookChapterBar: $('book-chapter-bar'),
  tocPanel:       $('toc-panel'),
  btnToc:         $('btn-toc'),
  btnCloseToc:    $('btn-close-toc'),
  tocList:        $('toc-list'),
  bookmarkList:   $('bookmark-list'),
  epubViewport:   $('epub-viewport'),
  btnPrev:        $('btn-prev'),
  btnNext:        $('btn-next'),
  progressBar:    $('progress-bar'),
  progressLabel:  $('progress-label'),
  btnBookmark:    $('btn-bookmark'),
  btnSettings:    $('btn-settings'),
  settingsPanel:  $('settings-panel'),
  bookSearchInput: $('book-search-input'),
  btnBookSearch: $('btn-book-search'),
  searchPanel: $('search-panel'),
  searchResults: $('search-results'),
  btnCloseSearch: $('btn-close-search'),
  btnFontMinus:   $('btn-font-minus'),
  btnFontPlus:    $('btn-font-plus'),
  fontSizeLabel: $('font-size-label'),
  themeSwatches:  $$('.swatch'),
  selectionPopup: $('selection-popup'),
  popupHighlight: $('popup-highlight'),
  popupAskAI:     $('popup-ask-ai'),
  chatHistory:    $('chat-history'),
  chatInput:      $('chat-input'),
  btnSendAI:      $('btn-send-ai'),
  notesPanel:     $('notes-panel'),
  notesList:      $('notes-list'),
  noteSearchInput: $('note-search-input'),
  noteChapterFilter: $('note-chapter-filter'),
  btnClearNoteFilter: $('btn-clear-note-filter'),
  btnExportNotes: $('btn-export-notes'),
  btnFoldAll:     $('btn-fold-all'),
  btnUnfoldAll:   $('btn-unfold-all'),
  btnToggleNotes: $('btn-toggle-notes'),
  aiPanel:        $('ai-panel'),
  btnToggleAI:    $('btn-toggle-ai'),
  aiAskModalOverlay: $('ai-ask-modal-overlay'),
  aiAskQuote:        $('ai-ask-quote'),
  aiAskTextarea:     $('ai-ask-textarea'),
  aiAskSubmit:       $('ai-ask-submit'),
  aiAskClose:        $('ai-ask-close'),
  noteModalOverlay: $('note-modal-overlay'),
  noteModal:        $('note-modal'),
  noteModalChapter: $('note-modal-chapter'),
  noteModalTime:    $('note-modal-time'),
  noteModalColorRow: $('note-modal-color-row'),
  noteModalContext:  $('note-modal-context'),
  noteModalTextarea: $('note-modal-textarea'),
  noteModalJump:     $('note-modal-jump'),
  noteModalDel:      $('note-modal-del'),
  noteModalClose:    $('note-modal-close'),
  btnBackHome:     $('btn-back-home'),
  toast:           $('toast'),
  btnModePaginated: $('btn-mode-paginated'),
  btnModeScroll:    $('btn-mode-scroll'),
  settingProvider: $('setting-provider'),
  settingBaseUrl: $('setting-base-url'),
  settingModel: $('setting-model'),
  settingEmbeddingProvider: $('setting-embedding-provider'),
  settingObsidianPath: $('setting-obsidian-path'),
  btnSaveSettings: $('btn-save-settings'),
  btnExportObsidian: $('btn-export-obsidian'),
  readerStats: $('reader-stats'),
};

const API_BASE = 'http://localhost:3000/api';

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function createClientId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================================================
   欢迎屏 — 文件导入
   ============================================================ */
DOM.uploadBtn.addEventListener('click', () => DOM.fileInput.click());
DOM.uploadZone.addEventListener('click', (e) => {
  if (e.target === DOM.uploadBtn) return;
  DOM.fileInput.click();
});
DOM.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadEpubFromFile(file);
});
DOM.uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  DOM.uploadZone.classList.add('drag-over');
});
DOM.uploadZone.addEventListener('dragleave', () => DOM.uploadZone.classList.remove('drag-over'));
DOM.uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  DOM.uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.epub')) loadEpubFromFile(file);
  else showToast('请拖入 .epub 格式的文件');
});
DOM.loadDemoBtn.addEventListener('click', loadDemoContent);

async function loadLibrary() {
  if (!DOM.libraryList) return;
  try {
    const data = await apiRequest('/books');
    State.books = data.books || [];
    DOM.libraryStatus.textContent = `${State.books.length} 本书`;
    renderLibrary();
  } catch (error) {
    DOM.libraryStatus.textContent = '后端未连接';
    DOM.libraryList.innerHTML = '<p class="empty-hint">启动后端后可使用本地图书馆。</p>';
  }
}

function renderLibrary() {
  if (!DOM.libraryList) return;
  DOM.libraryList.innerHTML = '';
  if (!State.books.length) {
    DOM.libraryList.innerHTML = '<p class="empty-hint">还没有导入书籍。选择 EPUB 后会保存到本地图书馆。</p>';
    return;
  }
  State.books.forEach(book => {
    const card = document.createElement('div');
    card.className = 'library-card';
    const pct = Math.round((book.progress?.percentage || 0) * 100);
    const chunks = book.index?.totalChunks || 0;
    card.innerHTML = `
      <div class="library-card-title">${escHtml(book.title || '未命名书籍')}</div>
      <div class="library-card-meta">
        ${book.author ? escHtml(book.author) + '<br>' : ''}
        进度 ${pct || 0}% · 索引 ${chunks ? chunks + ' 段' : '未完成'}
      </div>
      <div class="library-card-actions">
        <button class="btn-sm" data-action="open">继续阅读</button>
        <button class="btn-sm" data-action="delete">删除</button>
      </div>`;
    card.querySelector('[data-action="open"]').addEventListener('click', () => openBookFromLibrary(book));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteLibraryBook(book));
    DOM.libraryList.appendChild(card);
  });
}

async function openBookFromLibrary(book) {
  try {
    const response = await fetch(`${API_BASE}/books/${encodeURIComponent(book.bookId || book.id)}/file`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    initReader(buffer, book.title, { bookId: book.bookId || book.id, bookRecord: book, savedCfi: book.progress?.cfi });
  } catch (error) {
    showToast(`打开书籍失败：${error.message}`);
  }
}

async function deleteLibraryBook(book) {
  if (!confirm(`删除《${book.title}》及其本地笔记和索引？`)) return;
  try {
    await apiRequest(`/books/${encodeURIComponent(book.bookId || book.id)}`, { method: 'DELETE' });
    await loadLibrary();
    showToast('书籍已删除');
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

async function importBookFile(file) {
  const form = new FormData();
  form.append('file', file);
  form.append('title', file.name.replace(/\.epub$/i, ''));
  const response = await fetch(`${API_BASE}/books/import`, { method: 'POST', body: form });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

/* ============================================================
   加载 EPUB 文件
   ============================================================ */
function loadEpubFromFile(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    const arrayBuffer = e.target.result;
    const titleHint = file.name.replace(/\.epub$/i, '');
    let bookRecord = null;
    try {
      bookRecord = await importBookFile(file);
      await loadLibrary();
    } catch (error) {
      console.warn('Book import failed, using browser-only mode:', error);
      showToast('后端导入失败，临时打开阅读');
    }
    initReader(arrayBuffer, bookRecord?.title || titleHint, {
      bookId: bookRecord?.bookId,
      bookRecord
    });
  };
  reader.readAsArrayBuffer(file);
}

function initReader(arrayBuffer, titleHint, options = {}) {
  if (State.book) { try { State.book.destroy(); } catch(e) {} }
  DOM.epubViewport.innerHTML = '';

  State.book = ePub(arrayBuffer);
  State.currentBookRecord = options.bookRecord || null;
  State.chatMessages = [];
  resetChatHistoryView();

  DOM.welcomeScreen.classList.remove('active');
  DOM.readerScreen.classList.add('active');

  State.book.loaded.metadata.then((meta) => {
    const title = meta.title || titleHint || '未命名书籍';
    DOM.bookTitleBar.textContent = title;
    currentBookTitle = title;
    currentBookId = options.bookId || 'book_' + hashString(title);
    refreshBookStateFromBackend();
  }).catch(() => {
    const title = titleHint || '未命名书籍';
    DOM.bookTitleBar.textContent = title;
    currentBookTitle = title;
    currentBookId = options.bookId || 'book_' + hashString(title);
    refreshBookStateFromBackend();
  });

  const isScroll = State.readMode === 'scroll';
  State.rendition = State.book.renderTo(DOM.epubViewport, {
    width:  '100%',
    height: isScroll ? undefined : '100%',
    spread: 'none',
    flow:   isScroll ? 'scrolled-doc' : 'paginated',
    manager: isScroll ? 'continuous' : 'default',
  });

  applyThemeToRendition();
  applyFontSize();
  applyReadModeUI();

  const savedCfi = options.savedCfi || localStorage.getItem(`rf_pos_${getBookKey()}`);
  State.rendition.display(savedCfi || undefined);

  State.rendition.on('rendered', onRendered);
  State.rendition.on('relocated', onRelocated);
  State.rendition.on('selected', onTextSelected);

  State.book.loaded.navigation.then((nav) => {
    buildToc(nav);
    // 书籍目录加载完成后，异步索引到RAG（2秒后，避免阻塞渲染）
    setTimeout(() => {
      if (currentBookId && State.tocItems.length > 0) {
        indexBookForRAG(State.book, State.tocItems);
      }
    }, 2000);
  });

  State.book.ready.then(() => {
    State.book.locations.generate(1000).then(() => {
      updateProgress();
    });
  });
}

// 简单字符串哈希函数（用于生成书籍ID）
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

function getBookKey() {
  return DOM.bookTitleBar.textContent.slice(0, 20).replace(/\s/g, '_');
}

async function refreshBookStateFromBackend() {
  if (!currentBookId) return;
  await Promise.allSettled([
    loadNotes(),
    loadBookmarks(),
    loadHighlights(),
    loadReaderStats(),
    loadChatHistory()
  ]);
  reapplyHighlights();
}

/* ============================================================
   演示内容（内联生成小型 EPUB）
   ============================================================ */
function loadDemoContent() {
  const demoChapters = [
    {
      id: 'intro', title: '引言',
      body: `<h2>引言</h2>
      <p>欢迎使用 <strong>ReadFlow</strong>——一个把阅读、AI 问答与笔记沉淀串成一条工作流的阅读工具。</p>
      <p>本演示内容展示了 ReadFlow 的核心阅读功能，包括：翻页导航、章节目录、文字划线高亮、书签定位等。</p>
      <p>你可以尝试用鼠标选中下面的文字，会弹出操作菜单，让你对选中内容进行划线、存为笔记或向 AI 提问。</p>
      <p>阅读软件、AI 提问与笔记整理之间的来回切换，是当今知识工作者效率损耗的重要原因之一。ReadFlow 的目标是把这三件事合并成一个流畅的工作流。</p>`
    },
    {
      id: 'chapter1', title: '第一章：深度阅读的困境',
      body: `<h2>第一章：深度阅读的困境</h2>
      <p>在信息爆炸的时代，我们读的越来越多，但真正沉淀下来的知识却越来越少。</p>
      <p>心理学家将这种现象称为"阅读幻觉"——我们以为自己理解了，实际上只是浏览了文字表面。</p>
      <p>真正的深度阅读需要三个动作：<strong>主动提问</strong>、<strong>关联旧知识</strong>与<strong>输出复述</strong>。</p>
      <p>遗憾的是，传统的阅读工具只做到了"显示文字"这一步。它们没有为读者提供在阅读过程中提问、反思和记录的原生支持。</p>
      <p>于是读者不得不在电子书软件、搜索引擎、AI 聊天工具和笔记软件之间反复切换，每一次切换都是一次注意力的中断和上下文的丢失。</p>`
    },
    {
      id: 'chapter2', title: '第二章：工作流整合的价值',
      body: `<h2>第二章：工作流整合的价值</h2>
      <p>行为经济学有一个概念叫"摩擦成本"（Friction Cost）：每一次工具切换，都会增加行动的心理门槛，从而降低实际执行率。</p>
      <p>当提问和记录的入口就在阅读界面旁边时，读者更可能在灵感闪现的瞬间立刻行动，而不是"等读完这章再说"——而那个"再说"，往往永远不会发生。</p>
      <p>ReadFlow 的设计哲学：<em>让好的阅读行为发生在最小阻力的路径上。</em></p>
      <p>划线即记录，提问即学习，笔记即输出。三个动作，一个界面，零切换成本。</p>`
    },
    {
      id: 'chapter3', title: '第三章：如何使用 ReadFlow',
      body: `<h2>第三章：如何使用 ReadFlow</h2>
      <h3>导入书籍</h3>
      <p>点击首页的上传区域，选择你的 EPUB 文件，即可开始阅读。支持拖拽导入。</p>
      <h3>翻页与导航</h3>
      <p>使用界面两侧的箭头按钮翻页，或使用键盘方向键。点击顶部目录图标可打开章节列表，快速跳转。</p>
      <h3>划线高亮</h3>
      <p>用鼠标选中任意文字，弹出菜单中选择"划线"，文字会被高亮标注，颜色为黄色。</p>
      <h3>书签</h3>
      <p>点击顶部书签图标，可在当前位置添加书签。书签保存在目录面板的"书签"标签页中，点击可跳回对应位置。</p>
      <h3>向 AI 提问</h3>
      <p>选中文字后点击"问 AI"，所选内容会自动填入右侧 AI 对话框。右侧面板随时可以输入问题。</p>
      <h3>笔记沉淀</h3>
      <p>选中文字后点击"存为笔记"，该段落会作为引用保存到右侧笔记面板。你还可以为每条笔记添加自己的思考。</p>`
    },
  ];

  const zip = new JSZip();

  zip.file('mimetype', 'application/epub+zip');
  zip.folder('META-INF').file('container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );

  const oebps = zip.folder('OEBPS');

  const manifestItems = demoChapters.map(c =>
    `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n    ');
  const spineItems = demoChapters.map(c =>
    `<itemref idref="${c.id}"/>`
  ).join('\n    ');
  const tocNavPoints = demoChapters.map((c, i) =>
    `<navPoint id="nav${i}" playOrder="${i+1}"><navLabel><text>${c.title}</text></navLabel><content src="${c.id}.xhtml"/></navPoint>`
  ).join('\n  ');

  oebps.file('content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>ReadFlow 演示书籍</dc:title>
    <dc:creator>ReadFlow Team</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="uid">readflow-demo-001</dc:identifier>
  </metadata>
  <manifest>
    ${manifestItems}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`);

  oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="readflow-demo-001"/></head>
  <docTitle><text>ReadFlow 演示书籍</text></docTitle>
  <navMap>
  ${tocNavPoints}
  </navMap>
</ncx>`);

  demoChapters.forEach(c => {
    oebps.file(`${c.id}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${c.title}</title>
<style>
  body { font-family: Georgia, "STSong", serif; font-size: 18px; line-height: 1.9; color: #1a1a1a; max-width: 680px; margin: 0 auto; padding: 40px 24px; }
  h2 { font-size: 22px; font-weight: 700; margin-bottom: 20px; color: #111; border-bottom: 2px solid #4F6EF7; padding-bottom: 8px; }
  h3 { font-size: 16px; font-weight: 600; margin: 20px 0 8px; color: #333; }
  p { margin-bottom: 16px; text-indent: 2em; }
  strong { color: #2a3fc7; }
  em { color: #b05a00; font-style: italic; }
</style>
</head>
<body>${c.body}</body>
</html>`);
  });

  zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' }).then((buffer) => {
    initReader(buffer, 'ReadFlow 演示书籍');
  });
}

/* ============================================================
   epub.js 事件回调
   ============================================================ */
function onRendered(section) {
  reapplyHighlights();
  hookIframeSelection();
  if (State.readMode === 'scroll') {
    hookScrollProgress();
  }
}

function onRelocated(location) {
  State.currentCfi = location.start.cfi;
  localStorage.setItem(`rf_pos_${getBookKey()}`, State.currentCfi);
  const href = location.start.href;
  const tocItem = State.tocItems.find(t => href && t.href && href.includes(t.href.split('#')[0]));
  if (tocItem) {
    DOM.bookChapterBar.textContent = tocItem.label;
    highlightTocItem(tocItem.href);
  }
  updateProgress();
  saveProgressToBackend();
}

function onTextSelected(cfiRange, contents) {
  const sel = contents.window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text || text.length < 2) return;
  State.selectedText = text;
  State.selectedCfi = cfiRange;
  State.selectedContext = extractContext(sel, contents.document);

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const iframe = DOM.epubViewport.querySelector('iframe');
  const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
  const x = iframeRect.left + rect.left + rect.width / 2;
  const y = iframeRect.top + rect.top - 8;
  showSelectionPopup(x, y);
}

function extractContext(sel, iframeDoc) {
  const BLOCK_TAGS = new Set(['P','DIV','SECTION','ARTICLE','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','TD','TR']);
  const MAX_CTX = 120;

  try {
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    while (node && !BLOCK_TAGS.has(node.nodeName)) {
      node = node.parentNode;
    }
    if (!node) return { before: '', after: '' };

    let before = '';
    let prev = node.previousElementSibling;
    while (prev && !before.trim()) {
      if (BLOCK_TAGS.has(prev.nodeName)) {
        before = (prev.textContent || '').trim();
      }
      prev = prev.previousElementSibling;
    }

    let after = '';
    let next = node.nextElementSibling;
    while (next && !after.trim()) {
      if (BLOCK_TAGS.has(next.nodeName)) {
        after = (next.textContent || '').trim();
      }
      next = next.nextElementSibling;
    }

    return {
      before: before.length > MAX_CTX ? '…' + before.slice(-MAX_CTX) : before,
      after:  after.length  > MAX_CTX ? after.slice(0, MAX_CTX) + '…' : after,
    };
  } catch (e) {
    return { before: '', after: '' };
  }
}

function hookIframeSelection() {
  const iframe = DOM.epubViewport.querySelector('iframe');
  if (!iframe) return;
  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    iframeDoc.addEventListener('mouseup', () => {
      const sel = iframeDoc.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hideSelectionPopup();
      }
    });
    iframeDoc.addEventListener('keyup', () => {
      const sel = iframeDoc.getSelection();
      if (!sel || sel.isCollapsed) hideSelectionPopup();
    });
  } catch(e) {}
}

function hookScrollProgress() {
  const onScroll = () => {
    try {
      const el = DOM.epubViewport;
      const scrollTop = el.scrollTop;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable > 0) {
        const pct = Math.round((scrollTop / scrollable) * 100);
        DOM.progressBar.style.width = pct + '%';
        DOM.progressLabel.textContent = pct + '%';
        return;
      }
      const iframe = el.querySelector('iframe');
      if (iframe) {
        const win = iframe.contentWindow;
        const body = iframe.contentDocument?.body;
        if (win && body) {
          const s = win.scrollY || win.pageYOffset || 0;
          const h = Math.max(body.scrollHeight - win.innerHeight, 1);
          const pct = Math.round((s / h) * 100);
          DOM.progressBar.style.width = pct + '%';
          DOM.progressLabel.textContent = pct + '%';
        }
      }
    } catch(e) {}
  };
  DOM.epubViewport.addEventListener('scroll', onScroll, { passive: true });
  try {
    const iframe = DOM.epubViewport.querySelector('iframe');
    if (iframe) {
      iframe.contentWindow.addEventListener('scroll', onScroll, { passive: true });
    }
  } catch(e) {}
}

/* ============================================================
   翻页
   ============================================================ */
DOM.btnPrev.addEventListener('click', () => State.rendition?.prev());
DOM.btnNext.addEventListener('click', () => State.rendition?.next());

document.addEventListener('keydown', (e) => {
  if (!State.rendition) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') State.rendition.next();
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   State.rendition.prev();
});

/* ============================================================
   进度
   ============================================================ */
function updateProgress() {
  if (!State.book?.locations || !State.currentCfi) return;
  try {
    const pct = State.book.locations.percentageFromCfi(State.currentCfi);
    const pctInt = Math.round((pct || 0) * 100);
    DOM.progressBar.style.width = pctInt + '%';
    DOM.progressLabel.textContent = pctInt + '%';
  } catch(e) {}
}

async function saveProgressToBackend() {
  if (!currentBookId || !State.currentCfi) return;
  let percentage = 0;
  try {
    percentage = State.book?.locations?.percentageFromCfi(State.currentCfi) || 0;
  } catch {}
  try {
    await apiRequest('/progress', {
      method: 'POST',
      body: {
        bookId: currentBookId,
        chapter: DOM.bookChapterBar.textContent,
        cfi: State.currentCfi,
        position: Math.round(percentage * 10000),
        percentage,
        totalChars: 0
      }
    });
  } catch (error) {
    console.warn('Save progress failed:', error);
  }
}

/* ============================================================
   目录
   ============================================================ */
function buildToc(navigation) {
  State.tocItems = [];
  DOM.tocList.innerHTML = '';
  const items = navigation.toc || [];

  function renderItems(list, depth) {
    list.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item.label.trim();
      li.style.paddingLeft = (20 + depth * 14) + 'px';
      li.dataset.href = item.href;
      li.addEventListener('click', () => {
        State.rendition.display(item.href);
        closeToc();
      });
      DOM.tocList.appendChild(li);
      State.tocItems.push({ href: item.href, label: item.label.trim(), el: li });
      if (item.subitems && item.subitems.length) renderItems(item.subitems, depth + 1);
    });
  }
  renderItems(items, 0);
  if (!items.length) DOM.tocList.innerHTML = '<li class="toc-empty">暂无目录</li>';
}

function highlightTocItem(href) {
  State.tocItems.forEach(t => {
    t.el.classList.toggle('active', t.href === href);
  });
}

// 目录按钮移到左上角，从顶部滑下
DOM.btnToc.addEventListener('click', () => DOM.tocPanel.classList.toggle('open'));
DOM.btnCloseToc.addEventListener('click', closeToc);
function closeToc() { DOM.tocPanel.classList.remove('open'); }

$$('.toc-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.toc-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.toc;
    $('toc-chapters').classList.toggle('hidden', target !== 'chapters');
    $('toc-bookmarks').classList.toggle('hidden', target !== 'bookmarks');
  });
});

/* ============================================================
   书签
   ============================================================ */
DOM.btnBookmark.addEventListener('click', addBookmark);

function addBookmark() {
  if (!State.currentCfi) return showToast('请先打开一本书');
  const existing = State.bookmarks.find(b => b.cfi === State.currentCfi);
  if (existing) return showToast('当前位置已有书签');
  const chapter = DOM.bookChapterBar.textContent || '未知章节';
  const bm = {
    id: createClientId('bookmark'),
    bookId: currentBookId,
    cfi: State.currentCfi,
    chapter,
    label: chapter,
    time: new Date().toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }),
  };
  State.bookmarks.push(bm);
  saveBookmarks();
  renderBookmarkList();
  loadReaderStats();
  showToast('✅ 书签已添加');
}

function renderBookmarkList() {
  DOM.bookmarkList.innerHTML = '';
  if (!State.bookmarks.length) {
    DOM.bookmarkList.innerHTML = '<li class="toc-empty">暂无书签</li>';
    return;
  }
  State.bookmarks.forEach((bm, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${bm.label}</span>
      <span class="bookmark-item-text">${bm.time}</span>`;
    li.addEventListener('click', () => {
      State.rendition.display(bm.cfi);
      closeToc();
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm('删除此书签？')) {
        deleteBookmark(bm, idx);
      }
    });
    DOM.bookmarkList.appendChild(li);
  });
}

async function saveBookmarks() {
  localStorage.setItem(`rf_bm_${getBookKey()}`, JSON.stringify(State.bookmarks));
  if (!currentBookId) return;
  await Promise.allSettled(State.bookmarks.map(bookmark =>
    apiRequest('/bookmarks', {
      method: 'POST',
      body: {
        id: bookmark.id,
        bookId: bookmark.bookId || currentBookId,
        chapter: bookmark.chapter,
        cfi: bookmark.cfi,
        label: bookmark.label || bookmark.chapter,
        position: bookmark.position || 0,
        note: bookmark.note || ''
      }
    })
  ));
}

async function loadBookmarks() {
  const raw = localStorage.getItem(`rf_bm_${getBookKey()}`);
  const fallback = raw ? JSON.parse(raw) : [];
  if (!currentBookId) {
    State.bookmarks = fallback;
    renderBookmarkList();
    return;
  }
  try {
    const bookmarks = await apiRequest(`/bookmarks?bookId=${encodeURIComponent(currentBookId)}`);
    State.bookmarks = Array.isArray(bookmarks) ? bookmarks : [];
    if (!State.bookmarks.length && fallback.length) {
      State.bookmarks = fallback.map(item => ({ ...item, bookId: item.bookId || currentBookId }));
      await saveBookmarks();
    }
  } catch (error) {
    console.warn('Load bookmarks failed:', error);
    State.bookmarks = fallback;
  }
  renderBookmarkList();
}

async function deleteBookmark(bookmark, index) {
  State.bookmarks.splice(index, 1);
  localStorage.setItem(`rf_bm_${getBookKey()}`, JSON.stringify(State.bookmarks));
  renderBookmarkList();
  loadReaderStats();
  if (bookmark?.id && currentBookId) {
    try {
      await apiRequest(`/bookmarks/${encodeURIComponent(bookmark.id)}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('Delete bookmark failed:', error);
    }
  }
}

/* ============================================================
   划线高亮（同时存为笔记）
   ============================================================ */
function addHighlightAndNote(cfi, text, context) {
  if (!cfi) return;
  if (!State.highlights.find(h => h.cfi === cfi)) {
    State.highlights.push({
      id: createClientId('highlight'),
      bookId: currentBookId,
      chapter: DOM.bookChapterBar.textContent,
      cfi,
      text,
      color: '#fbbf24'
    });
    saveHighlights();
    loadReaderStats();
    try {
      State.rendition.annotations.highlight(cfi, {}, () => {}, 'readflow-highlight');
    } catch(e) { console.warn('highlight error', e); }
  }
  if (!State.notes.find(n => n.cfi === cfi)) {
    addNote(text, cfi, context);
  } else {
    showToast('✏️ 划线已更新');
  }
}

function reapplyHighlights() {
  if (!State.rendition) return;
  State.highlights.forEach(h => {
    try { State.rendition.annotations.remove(h.cfi, 'highlight'); } catch(e) {}
  });
  State.highlights.forEach(h => {
    try {
      State.rendition.annotations.highlight(h.cfi, {}, () => {}, 'readflow-highlight');
    } catch(e) {}
  });
}

async function saveHighlights() {
  localStorage.setItem(`rf_hl_${getBookKey()}`, JSON.stringify(State.highlights));
  if (!currentBookId) return;
  await Promise.allSettled(State.highlights.map(highlight =>
    apiRequest('/highlights', {
      method: 'POST',
      body: {
        id: highlight.id,
        bookId: highlight.bookId || currentBookId,
        chapter: highlight.chapter || DOM.bookChapterBar.textContent,
        cfi: highlight.cfi,
        text: highlight.text,
        color: highlight.color || '#fbbf24'
      }
    })
  ));
}

async function loadHighlights() {
  const raw = localStorage.getItem(`rf_hl_${getBookKey()}`);
  const fallback = raw ? JSON.parse(raw) : [];
  if (!currentBookId) {
    State.highlights = fallback;
    return;
  }
  try {
    const highlights = await apiRequest(`/highlights?bookId=${encodeURIComponent(currentBookId)}`);
    State.highlights = Array.isArray(highlights) ? highlights : [];
    if (!State.highlights.length && fallback.length) {
      State.highlights = fallback.map(item => ({
        id: item.id || createClientId('highlight'),
        bookId: item.bookId || currentBookId,
        chapter: item.chapter || DOM.bookChapterBar.textContent,
        cfi: item.cfi,
        text: item.text,
        color: item.color || '#fbbf24'
      }));
      await saveHighlights();
    }
  } catch (error) {
    console.warn('Load highlights failed:', error);
    State.highlights = fallback;
  }
}

/* ============================================================
   选中文字气泡菜单
   ============================================================ */
function showSelectionPopup(x, y) {
  const popup = DOM.selectionPopup;
  popup.classList.add('visible');
  const pw = popup.offsetWidth || 220;
  const left = Math.min(Math.max(x - pw / 2, 8), window.innerWidth - pw - 8);
  const top  = Math.max(y - popup.offsetHeight - 10, 8);
  popup.style.left = left + 'px';
  popup.style.top  = top + 'px';
}
function hideSelectionPopup() {
  DOM.selectionPopup.classList.remove('visible');
}

DOM.popupHighlight.addEventListener('click', () => {
  if (!State.selectedText) return;
  addHighlightAndNote(State.selectedCfi, State.selectedText, State.selectedContext);
  hideSelectionPopup();
});

DOM.popupAskAI.addEventListener('click', () => {
  if (!State.selectedText) return;
  openAIAskModal(State.selectedText);
  hideSelectionPopup();
});

/* ============================================================
   AI 提问弹窗
   ============================================================ */
function openAIAskModal(selectedText) {
  DOM.aiAskQuote.textContent = selectedText;
  DOM.aiAskTextarea.value = '';
  DOM.aiAskTextarea.placeholder = '例如：这句话是什么意思？有什么深层含义？';
  DOM.aiAskModalOverlay.classList.add('visible');
  DOM.aiAskTextarea.focus();
}

function closeAIAskModal() {
  DOM.aiAskModalOverlay.classList.remove('visible');
}

DOM.aiAskClose.addEventListener('click', closeAIAskModal);
DOM.aiAskModalOverlay.addEventListener('click', (e) => {
  if (e.target === DOM.aiAskModalOverlay) closeAIAskModal();
});

DOM.aiAskSubmit.addEventListener('click', async () => {
  const question = DOM.aiAskTextarea.value.trim();
  const selectedText = DOM.aiAskQuote.textContent;
  const expandedQuestion = expandSlashCommand(question);
  
  if (!question) {
    showToast('请输入你的问题');
    DOM.aiAskTextarea.focus();
    return;
  }
  
  // 构建完整的问题（引用 + 问题）
  const fullMessage = `关于这段话："${selectedText}"\n\n我的问题：${question}`;
  
  // 发送到聊天区
  appendChatBubble(fullMessage, 'user');
  State.chatMessages.push({
    role: 'user',
    content: `${expandedQuestion}\n\nSelected text: ${selectedText}`
  });
  
  // 关闭弹窗
  closeAIAskModal();
  
  // 显示思考中
  const loadingId = showLoadingBubble();
  
  // 调用后端AI（支持RAG）
  try {
    const reply = await generateAIReply(selectedText, expandedQuestion);
    removeLoadingBubble(loadingId);
    appendChatBubble(reply, 'ai');
    State.chatMessages.push({ role: 'assistant', content: reply });
  } catch (error) {
    removeLoadingBubble(loadingId);
    appendChatBubble(`请求失败：${error.message}`, 'ai');
  }
});

// 按 Enter 发送，Shift+Enter 换行
DOM.aiAskTextarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    DOM.aiAskSubmit.click();
  }
});

document.addEventListener('click', (e) => {
  if (!DOM.selectionPopup.contains(e.target)) hideSelectionPopup();
});

/* ============================================================
   笔记颜色配置
   ============================================================ */
const NOTE_COLORS = [
  { key: 'yellow', label: '黄',  bg: '#FFF9C4', border: '#F5C518', text: '#7a6200' },
  { key: 'green',  label: '绿',  bg: '#E8F5E9', border: '#43A047', text: '#1b5e20' },
  { key: 'blue',   label: '蓝',  bg: '#E3F2FD', border: '#1E88E5', text: '#0d47a1' },
  { key: 'pink',   label: '粉',  bg: '#FCE4EC', border: '#E91E63', text: '#880e4f' },
  { key: 'purple', label: '紫',  bg: '#F3E5F5', border: '#8E24AA', text: '#4a148c' },
];
function getNoteColor(key) {
  return NOTE_COLORS.find(c => c.key === key) || NOTE_COLORS[0];
}

/* ============================================================
   笔记 — 按大章节分组渲染
   ============================================================ */

// 提取大章节名称 - 严格只按最大层级聚合
// 目标：无论笔记来自哪个小节，都归到对应的大章下，控制分组数量
function getMajorChapter(chapterName) {
  if (!chapterName) return '未分类';
  
  const name = chapterName.trim();
  
  // 策略：在章节名中搜索"第X章"或"Chapter X"，提取最大的那个章节号
  // 这样可以处理 "第一章 1.2 小节" 这种嵌套格式
  
  // 1. 先找中文第X章（不限于开头，可能在中间）
  const chineseMatch = name.match(/第([一二三四五六七八九十零百千万\d]+)章/);
  if (chineseMatch) {
    return `第${chineseMatch[1]}章`;
  }
  
  // 2. 找英文 Chapter X
  const chapterMatch = name.match(/Chapter\s+(\d+)/i);
  if (chapterMatch) {
    return `第${chapterMatch[1]}章`;
  }
  
  // 3. 找 Part X
  const partMatch = name.match(/Part\s+(\d+|I{1,3}|IV|V|VI|VII|VIII|IX|X)/i);
  if (partMatch) {
    const partNum = partMatch[1];
    // 转换罗马数字
    const romanToNum = { 'I':1, 'II':2, 'III':3, 'IV':4, 'V':5, 'VI':6, 'VII':7, 'VIII':8, 'IX':9, 'X':10 };
    if (romanToNum[partNum.toUpperCase()]) {
      return `第${romanToNum[partNum.toUpperCase()]}章`;
    }
    return `第${partNum}章`;
  }
  
  // 4. 找开头的数字（如 "1.2 小节" 归到第1章）
  const numMatch = name.match(/^(\d+)/);
  if (numMatch) {
    return `第${parseInt(numMatch[1], 10)}章`;
  }
  
  // 5. 找中文数字开头（一、二、三）
  const cnNumMatch = name.match(/^([一二三四五六七八九十百千]+)[、\.\s]/);
  if (cnNumMatch) {
    return `第${cnNumMatch[1]}章`;
  }
  
  // 6. 罗马数字开头
  const romanMatch = name.match(/^([IVXivx]+)[、\.\s]/);
  if (romanMatch) {
    const romanToNum = { 'I':1, 'II':2, 'III':3, 'IV':4, 'V':5, 'VI':6, 'VII':7, 'VIII':8, 'IX':9, 'X':10 };
    const num = romanToNum[romanMatch[1].toUpperCase()];
    if (num) return `第${num}章`;
  }
  
  // 7. 无法归类的都放到"其他"
  return '其他';
}

function addNote(quote, cfi, context) {
  const ctx = context || { before: '', after: '' };
  const note = {
    id: createClientId('note'),
    bookId: currentBookId,
    quote: quote.slice(0, 300),
    color: 'yellow',
    contextBefore: ctx.before,
    contextAfter:  ctx.after,
    body: '',
    chapter: DOM.bookChapterBar.textContent,
    cfi,
    time: new Date().toLocaleString('zh-CN'),
  };
  State.notes.unshift(note);
  saveNotes();
  renderNotes();
  loadReaderStats();
  showToast('📌 已保存');
}

function updateNoteChapterFilter() {
  if (!DOM.noteChapterFilter) return;
  const current = State.noteFilter.chapter || 'all';
  const chapters = Array.from(new Set(State.notes.map(n => n.chapter).filter(Boolean))).sort();
  DOM.noteChapterFilter.innerHTML = '<option value="all">All chapters</option>' +
    chapters.map(ch => `<option value="${escHtml(ch)}">${escHtml(ch)}</option>`).join('');
  DOM.noteChapterFilter.value = chapters.includes(current) ? current : 'all';
  State.noteFilter.chapter = DOM.noteChapterFilter.value;
}

function getFilteredNotes() {
  const q = (State.noteFilter.query || '').trim().toLowerCase();
  const chapter = State.noteFilter.chapter || 'all';
  return State.notes.filter(note => {
    if (chapter !== 'all' && note.chapter !== chapter) return false;
    if (!q) return true;
    const haystack = [
      note.quote,
      note.body,
      note.content,
      note.chapter,
      note.contextBefore,
      note.contextAfter,
      ...(note.tags || [])
    ].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(q);
  });
}

function renderNotes() {
  DOM.notesList.innerHTML = '';
  updateNoteChapterFilter();
  const notesToRender = getFilteredNotes();
  if (!notesToRender.length) {
    if (State.notes.length) {
      DOM.notesList.innerHTML = '<p class="empty-hint">No matching notes yet.</p>';
      return;
    }
    DOM.notesList.innerHTML = '<p class="empty-hint">划线文字后点击"划线"即可添加笔记</p>';
    return;
  }

  // 按大章节分组
  const groups = {};
  notesToRender.forEach(n => {
    const majorCh = getMajorChapter(n.chapter);
    if (!groups[majorCh]) groups[majorCh] = [];
    groups[majorCh].push(n);
  });

  Object.entries(groups).forEach(([chapter, notes]) => {
    const group = document.createElement('div');
    group.className = 'note-group';
    group.dataset.chapter = chapter;

    // 折叠头部
    const header = document.createElement('div');
    header.className = 'note-group-header';
    header.innerHTML = `
      <span class="note-group-title">${escHtml(chapter)}</span>
      <span class="note-group-count">${notes.length}</span>
      <button class="note-group-toggle" title="折叠/展开">
        <svg class="toggle-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <polyline points="6 9 12 15 18 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>`;
    group.appendChild(header);

    // 卡片列表
    const cardList = document.createElement('div');
    cardList.className = 'note-group-cards';

    notes.forEach(n => {
      const col = getNoteColor(n.color);
      const card = document.createElement('div');
      card.className = 'note-card';
      card.dataset.id = n.id;
      card.innerHTML = `
        <div class="note-card-color-bar" style="background:${col.border}"></div>
        <div class="note-card-body">
          <div class="note-card-quote">${escHtml(n.quote)}</div>
          ${n.body ? `<div class="note-card-note">${escHtml(n.body)}</div>` : ''}
        </div>`;
      card.addEventListener('click', () => openNoteModal(n));
      cardList.appendChild(card);
    });

    group.appendChild(cardList);
    DOM.notesList.appendChild(group);

    // 折叠/展开
    const toggle = header.querySelector('.note-group-toggle');
    const arrow  = toggle.querySelector('.toggle-arrow');
    
    // 恢复之前的折叠状态，默认为折叠
    const isFolded = State.chapterFoldState[chapter] !== false;
    cardList.style.display = isFolded ? 'none' : '';
    arrow.style.transform = isFolded ? 'rotate(-90deg)' : '';
    
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = cardList.style.display !== 'none';
      cardList.style.display = open ? 'none' : '';
      arrow.style.transform = open ? 'rotate(-90deg)' : '';
      State.chapterFoldState[chapter] = open;  // true = 折叠
    });
  });
}

// 一键折叠全部
function foldAllChapters() {
  const groups = DOM.notesList.querySelectorAll('.note-group');
  groups.forEach(group => {
    const chapter = group.dataset.chapter;
    const cardList = group.querySelector('.note-group-cards');
    const arrow = group.querySelector('.toggle-arrow');
    cardList.style.display = 'none';
    arrow.style.transform = 'rotate(-90deg)';
    State.chapterFoldState[chapter] = true;
  });
}

// 一键展开全部
function unfoldAllChapters() {
  const groups = DOM.notesList.querySelectorAll('.note-group');
  groups.forEach(group => {
    const chapter = group.dataset.chapter;
    const cardList = group.querySelector('.note-group-cards');
    const arrow = group.querySelector('.toggle-arrow');
    cardList.style.display = '';
    arrow.style.transform = '';
    State.chapterFoldState[chapter] = false;
  });
}

DOM.btnFoldAll.addEventListener('click', foldAllChapters);
DOM.btnUnfoldAll.addEventListener('click', unfoldAllChapters);
DOM.noteSearchInput?.addEventListener('input', () => {
  State.noteFilter.query = DOM.noteSearchInput.value;
  renderNotes();
});
DOM.noteChapterFilter?.addEventListener('change', () => {
  State.noteFilter.chapter = DOM.noteChapterFilter.value;
  renderNotes();
});
DOM.btnClearNoteFilter?.addEventListener('click', () => {
  State.noteFilter = { query: '', chapter: 'all' };
  if (DOM.noteSearchInput) DOM.noteSearchInput.value = '';
  if (DOM.noteChapterFilter) DOM.noteChapterFilter.value = 'all';
  renderNotes();
});

/* ============================================================
   笔记详情弹窗
   ============================================================ */
let _currentNote = null;

function openNoteModal(note) {
  _currentNote = note;
  const col = getNoteColor(note.color);

  DOM.noteModalChapter.textContent = note.chapter;
  DOM.noteModalTime.textContent = note.time;

  // 颜色选择行
  DOM.noteModalColorRow.innerHTML = NOTE_COLORS.map(c =>
    `<button class="note-color-dot ${note.color === c.key ? 'active' : ''}"
      data-color="${c.key}"
      style="background:${c.border}"
      title="${c.label}"></button>`
  ).join('');

  // 上下文 + 引用
  DOM.noteModalContext.innerHTML =
    (note.contextBefore ? `<div class="note-context note-context-before">${escHtml(note.contextBefore)}</div>` : '') +
    `<div class="note-highlight-quote" style="background:${col.bg};border-left-color:${col.border};color:${col.text}">${escHtml(note.quote)}</div>` +
    (note.contextAfter ? `<div class="note-context note-context-after">${escHtml(note.contextAfter)}</div>` : '');

  DOM.noteModalTextarea.value = note.body || '';
  DOM.noteModalOverlay.classList.add('visible');
  DOM.noteModalTextarea.focus();

  // 颜色切换
  DOM.noteModalColorRow.onclick = (e) => {
    const dot = e.target.closest('.note-color-dot');
    if (!dot || !_currentNote) return;
    _currentNote.color = dot.dataset.color;
    saveNotes();
    renderNotes();
    openNoteModal(_currentNote);
  };

  // 笔记内容实时保存
  DOM.noteModalTextarea.oninput = () => {
    if (!_currentNote) return;
    _currentNote.body = DOM.noteModalTextarea.value;
    saveNotes();
  };

  // 跳转
  DOM.noteModalJump.onclick = () => {
    if (!_currentNote?.cfi || !State.rendition) return showToast('请先打开书籍');
    const cfi = _currentNote.cfi;
    closeNoteModal();
    State.rendition.display(cfi).then(() => showToast('📍 已跳转'))
      .catch(() => showToast('跳转失败'));
  };

  // 删除
  DOM.noteModalDel.onclick = () => {
    if (!_currentNote) return;
    if (!confirm('删除这条笔记？')) return;
    deleteNote(_currentNote);
  };

  // 关闭
  DOM.noteModalClose.onclick = closeNoteModal;
  DOM.noteModalOverlay.onclick = (e) => {
    if (e.target === DOM.noteModalOverlay) closeNoteModal();
  };
}

function closeNoteModal() {
  DOM.noteModalOverlay.classList.remove('visible');
  _currentNote = null;
}

/* ============================================================
   笔记持久化
   ============================================================ */
async function saveNotes() {
  localStorage.setItem(`rf_notes_${getBookKey()}`, JSON.stringify(State.notes));
  if (!currentBookId) return;
  await Promise.allSettled(State.notes.map(note => persistNote(note)));
}

async function persistNote(note) {
  if (!currentBookId || !note?.quote) return;
  await apiRequest('/notes', {
    method: 'POST',
    body: {
      id: note.id,
      bookId: note.bookId || currentBookId,
      chapter: note.chapter,
      cfi: note.cfi,
      quote: note.quote,
      body: note.body || note.content || '',
      color: note.color || 'yellow',
      contextBefore: note.contextBefore || '',
      contextAfter: note.contextAfter || '',
      tags: note.tags || []
    }
  });
}

async function loadNotes() {
  const raw = localStorage.getItem(`rf_notes_${getBookKey()}`);
  const fallback = raw ? JSON.parse(raw) : [];
  if (!currentBookId) {
    State.notes = fallback;
    renderNotes();
    return;
  }
  try {
    const notes = await apiRequest(`/notes?bookId=${encodeURIComponent(currentBookId)}`);
    State.notes = Array.isArray(notes) ? notes : [];
    if (!State.notes.length && fallback.length) {
      State.notes = fallback.map(item => ({ ...item, id: item.id || createClientId('note'), bookId: item.bookId || currentBookId }));
      await saveNotes();
    }
  } catch (error) {
    console.warn('Load notes failed:', error);
    State.notes = fallback;
  }
  renderNotes();
}

async function deleteNote(note) {
  State.notes = State.notes.filter(n => n.id !== note.id);
  localStorage.setItem(`rf_notes_${getBookKey()}`, JSON.stringify(State.notes));
  closeNoteModal();
  renderNotes();
  loadReaderStats();
  if (note?.id && currentBookId) {
    try {
      await apiRequest(`/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('Delete note failed:', error);
    }
  }
}

// 导出笔记
DOM.btnExportNotes.addEventListener('click', exportNotesToMarkdown);
async function exportNotesToMarkdown() {
  if (currentBookId) {
    try {
      await saveNotes();
      const result = await apiRequest('/export/obsidian', {
        method: 'POST',
        body: { bookId: currentBookId }
      });
      if (result.markdown) {
        downloadText(result.markdown, `${DOM.bookTitleBar.textContent || 'reading-notes'}.md`);
      }
      showToast(result.writtenPath ? 'Obsidian export written' : 'Markdown export ready');
      return;
    } catch (error) {
      console.warn('Backend export failed, using local markdown:', error);
    }
  }

  if (!State.notes.length) return showToast('No notes to export');
  let md = `# ${DOM.bookTitleBar.textContent} - Reading Notes\n\n`;
  md += `> Exported at: ${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;
  State.notes.forEach((n, i) => {
    md += `## Note ${i + 1}: ${n.chapter || 'Unknown chapter'}\n\n`;
    if (n.contextBefore) md += `_${n.contextBefore}_\n\n`;
    md += `> ${String(n.quote || '').replace(/\n/g, '\n> ')}\n\n`;
    if (n.contextAfter) md += `_${n.contextAfter}_\n\n`;
    if (n.body || n.content) md += `${n.body || n.content}\n\n`;
    md += `---\n\n`;
  });
  downloadText(md, `${DOM.bookTitleBar.textContent || 'reading-notes'}-notes.md`);
  showToast('Markdown export ready');
}

function exportNotes() {
  if (!State.notes.length) return showToast('暂无笔记可导出');
  let md = `# ${DOM.bookTitleBar.textContent} — 阅读笔记\n\n`;
  md += `> 导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;
  State.notes.forEach((n, i) => {
    md += `## 笔记 ${i + 1}（${n.chapter}）\n\n`;
    if (n.contextBefore) md += `*…${n.contextBefore}*\n\n`;
    md += `> **${n.quote.replace(/\n/g, '\n> ')}**\n\n`;
    if (n.contextAfter) md += `*${n.contextAfter}…*\n\n`;
    if (n.body) md += `💭 ${n.body}\n\n`;
    md += `---\n\n`;
  });
  downloadText(md, `${DOM.bookTitleBar.textContent}-笔记.md`);
  showToast('✅ 笔记已导出为 Markdown');
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function loadSettings() {
  try {
    const data = await apiRequest('/settings');
    State.settings = data.settings || {};
    if (DOM.settingProvider) DOM.settingProvider.value = State.settings.defaultProvider || 'openai';
    if (DOM.settingBaseUrl) DOM.settingBaseUrl.value = State.settings.openaiBaseUrl || '';
    if (DOM.settingModel) DOM.settingModel.value = State.settings.openaiModel || '';
    if (DOM.settingEmbeddingProvider) DOM.settingEmbeddingProvider.value = State.settings.embeddingProvider || '';
    if (DOM.settingObsidianPath) DOM.settingObsidianPath.value = State.settings.obsidianVaultPath || '';
  } catch (error) {
    console.warn('Load settings failed:', error);
  }
}

async function saveSettings() {
  try {
    const settings = {
      ...State.settings,
      defaultProvider: DOM.settingProvider?.value || State.settings.defaultProvider || 'openai',
      openaiBaseUrl: DOM.settingBaseUrl?.value?.trim() || State.settings.openaiBaseUrl || '',
      openaiModel: DOM.settingModel?.value?.trim() || State.settings.openaiModel || '',
      embeddingProvider: DOM.settingEmbeddingProvider?.value?.trim() || State.settings.embeddingProvider || '',
      obsidianVaultPath: DOM.settingObsidianPath?.value?.trim() || ''
    };
    const data = await apiRequest('/settings', { method: 'PUT', body: settings });
    State.settings = data.settings || settings;
    showToast('Settings saved');
  } catch (error) {
    showToast(`Save settings failed: ${error.message}`);
  }
}

async function exportObsidian() {
  if (!currentBookId) return showToast('Open a book first');
  try {
    await saveNotes();
    await saveHighlights();
    await saveBookmarks();
    const result = await apiRequest('/export/obsidian', {
      method: 'POST',
      body: { bookId: currentBookId }
    });
    if (!result.writtenPath && result.markdown) {
      downloadText(result.markdown, `${DOM.bookTitleBar.textContent || 'reading-notes'}.md`);
    }
    showToast(result.writtenPath ? 'Exported to Obsidian vault' : 'Markdown export ready');
  } catch (error) {
    showToast(`Export failed: ${error.message}`);
  }
}

async function loadReaderStats() {
  if (!DOM.readerStats || !currentBookId) return;
  try {
    const stats = await apiRequest(`/stats/${encodeURIComponent(currentBookId)}`);
    const pct = Math.round(((stats.progress?.percentage) || 0) * 100);
    DOM.readerStats.textContent = `Notes ${stats.notes || 0} | Highlights ${stats.highlights || 0} | Bookmarks ${stats.bookmarks || 0} | ${pct}%`;
  } catch (error) {
    DOM.readerStats.textContent = '';
  }
}

DOM.btnSaveSettings?.addEventListener('click', saveSettings);
DOM.btnExportObsidian?.addEventListener('click', exportObsidian);

/* ============================================================
   AI 聊天（模拟响应）
   ============================================================ */
DOM.btnSendAI.addEventListener('click', sendAIMessage);
DOM.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); }
});

async function sendAIMessage() {
  const rawText = DOM.chatInput.value.trim();
  if (!rawText) return;
  const text = expandSlashCommand(rawText);
  DOM.chatInput.value = '';
  appendChatBubble(rawText, 'user');
  State.chatMessages.push({ role: 'user', content: text });
  
  // 显示思考中
  const loadingId = showLoadingBubble();
  
  // 调用后端AI（支持RAG上下文）
  try {
    const reply = await generateAIReply(null, text);
    removeLoadingBubble(loadingId);
    appendChatBubble(reply, 'ai');
    State.chatMessages.push({ role: 'assistant', content: reply });
  } catch (error) {
    removeLoadingBubble(loadingId);
    appendChatBubble(`请求失败：${error.message}`, 'ai');
  }
}

// 显示加载中的气泡
let loadingCounter = 0;
function showLoadingBubble() {
  const id = `loading-${++loadingCounter}`;
  const div = document.createElement('div');
  div.id = id;
  div.className = 'chat-bubble ai-bubble loading-bubble';
  div.innerHTML = '<span class="loading-dots">思考中<span>.</span><span>.</span><span>.</span></span>';
  DOM.chatHistory.appendChild(div);
  DOM.chatHistory.scrollTop = DOM.chatHistory.scrollHeight;
  return id;
}

// 移除加载中的气泡
function removeLoadingBubble(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function appendChatBubble(text, role) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${role === 'ai' ? 'ai-bubble' : 'user-bubble'}`;
  
  if (role === 'ai' && typeof marked !== 'undefined') {
    // AI回复：使用Markdown渲染（加安全过滤）
    const html = marked.parse(text, { breaks: true, gfm: true });
    // 允许链接标签用于参考来源跳转
    const allowedTags = ['a','p','br','strong','em','code','pre','blockquote','ul','ol','li','h1','h2','h3','h4','hr'];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // 先过滤标签
    const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    const toRemove = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!allowedTags.includes(el.tagName.toLowerCase())) {
        toRemove.push(el);
      }
    }
    toRemove.forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    
    // 安全处理链接：只允许 readflow:// 协议
    const links = doc.body.querySelectorAll('a[href]');
    links.forEach(a => {
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('readflow://')) {
        a.removeAttribute('href');
      }
    });
    
    div.innerHTML = doc.body.innerHTML;
  } else {
    // 用户消息：纯文本，防XSS
    div.textContent = text;
  }
  
  DOM.chatHistory.appendChild(div);
  DOM.chatHistory.scrollTop = DOM.chatHistory.scrollHeight;
}

function resetChatHistoryView() {
  if (!DOM.chatHistory) return;
  DOM.chatHistory.innerHTML = '';
  appendChatBubble('Ask about the current book, selected text, or use /解释概念, /生成知识图谱, /预读导航, /笔记格式化, /记住.', 'ai');
}

async function loadChatHistory() {
  if (!currentBookId || !DOM.chatHistory) return;
  try {
    const data = await apiRequest(`/chat/history/${encodeURIComponent(currentBookId)}`);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (!messages.length) return;
    State.chatMessages = messages.map(m => ({ role: m.role, content: m.content }));
    DOM.chatHistory.innerHTML = '';
    State.chatMessages.forEach(message => {
      appendChatBubble(message.content, message.role === 'assistant' ? 'ai' : 'user');
    });
  } catch (error) {
    console.warn('Load chat history failed:', error);
  }
}

/**
 * 格式化参考来源为可点击跳转的Markdown
 * @param {Array} sources - 来源数组，每项含 { chapter, href, content }
 * @param {Object} options - { maxPreview }
 * @returns {string} Markdown格式的参考来源文本
 */
function formatSources(sources, options = {}) {
  if (!sources || sources.length === 0) return '';
  
  const { maxPreview = 120 } = options;
  
  const validSources = sources.filter(s => {
    const c = (s.content || '').trim();
    if (c.length < 30) return false;
    const nonContentPatterns = [
      /^版权所有/i, /^All rights reserved/i, /^ISBN[\s:]/i,
      /^目录\s*$/i, /^Contents\s*$/i, /^出版说明/i, /^编?辑?推荐/i
    ];
    return !nonContentPatterns.some(p => p.test(c));
  });
  
  if (validSources.length === 0) return '';

  let result = '\n\n---\n**参考来源**\n';

  validSources.forEach((s, i) => {
    // 清理章节标题
    let chapter = (s.chapter || '未命名章节')
      .replace(/^\d+[\s\-_.]+/, '')
      .replace(/[_\-_]{2,}/g, ' · ')
      .trim();
    
    const href = s.href || '';
    const encodedHref = encodeURIComponent(href);
    
    // 预览内容
    let preview = (s.content || '').replace(/\n/g, ' ').trim();
    if (preview.length > maxPreview) {
      const truncated = preview.slice(0, maxPreview);
      const lastStop = Math.max(
        truncated.lastIndexOf('。'), truncated.lastIndexOf('？'),
        truncated.lastIndexOf('！'), truncated.lastIndexOf('.'),
        truncated.lastIndexOf('?'), truncated.lastIndexOf('!')
      );
      preview = lastStop > 30 ? truncated.slice(0, lastStop + 1) : truncated;
      preview += '…';
    }
    
    // 生成可点击的Markdown链接（点击跳转到对应段落）
    // 传入文本前缀用于 CFI 精确定位
    const contentPrefix = preview.slice(0, 150);
    const encodedPrefix = encodeURIComponent(contentPrefix);
    if (href) {
      result += `\n**${i + 1}. [${escHtml(chapter)}](readflow://source?href=${encodedHref}&txt=${encodedPrefix})**\n> ${escHtml(preview)}\n`;
    } else {
      result += `\n**${i + 1}. ${escHtml(chapter)}**\n> ${escHtml(preview)}\n`;
    }
  });

  return result;
}

// 点击参考来源链接，跳转到书中对应位置（优先 CFI 精确定位，降级到 href 章节跳转）
DOM.chatHistory.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="readflow://source"]');
  if (link) {
    e.preventDefault();
    try {
      const url = new URL(link.href);
      const href = decodeURIComponent(url.searchParams.get('href') || '');
      const textPrefix = decodeURIComponent(url.searchParams.get('txt') || '');
      
      if (!State.rendition) return;
      
      // 1. 优先使用 CFI 精确定位段落
      const cfiMap = currentBookId ? bookCfiMaps[currentBookId] : null;
      let targetCfi = null;
      if (cfiMap && textPrefix) {
        // 精确匹配
        if (cfiMap[textPrefix]) {
          targetCfi = cfiMap[textPrefix];
        } else {
          // 模糊匹配：寻找包含该文本前缀的 key
          const matchKey = Object.keys(cfiMap).find(key => 
            textPrefix.includes(key.slice(0, 80)) || key.includes(textPrefix.slice(0, 80))
          );
          if (matchKey) targetCfi = cfiMap[matchKey];
        }
      }
      
      if (targetCfi) {
        State.rendition.display(targetCfi).then(() => showToast('📍 已跳转到对应段落'))
          .catch(() => {
            // CFI 跳转失败，降级到 href
            if (href) {
              State.rendition.display(href).then(() => showToast('📍 已跳转到对应章节'));
            }
          });
      } else if (href) {
        State.rendition.display(href).then(() => showToast('📍 已跳转到对应章节'));
      }
    } catch(err) {
      console.warn('来源跳转失败:', err);
    }
  }
});

function generateMockAIReply(question) {
  if (question.includes('解释')) {
    return '这段话描述的是…（AI 功能将在后续版本中接入真实大模型，当前为演示模拟回复）';
  }
  if (question.includes('总结')) {
    return '本章节的核心观点是：（模拟回复）连接阅读与思考，降低工具切换成本。';
  }
  return `你提问了：「${question.slice(0, 30)}…」\n\n这是一个模拟回复。在真实产品版本中，此处将调用 GPT / Claude 等大模型接口进行实时回答。`;
}

// 当前书籍ID（用于RAG上下文）
let currentBookId = null;
let currentBookTitle = '';

// 存储每本书的 CFI 查找映射（textPrefix → CFI，用于参考来源精确定位）
const bookCfiMaps = {};

const deepModeBtn = document.getElementById('btn-deep-mode');
const deepModeDropdown = document.getElementById('deep-mode-dropdown');

// 更新深读按钮状态
function updateDeepModeUI() {
  if (!deepModeBtn) return;
  const modeLabels = { auto: '🔄 深读', on: '✅ 深读', off: '📖 问答' };
  deepModeBtn.textContent = modeLabels[State.deepReadingMode] || '📖 深读';
  deepModeBtn.dataset.mode = State.deepReadingMode;
}

// 切换下拉菜单
deepModeBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  deepModeDropdown?.classList.toggle('visible');
});

// 选项点击
deepModeDropdown?.addEventListener('click', (e) => {
  const option = e.target.closest('.deep-mode-option');
  if (!option) return;
  
  const mode = option.dataset.mode;
  const format = option.dataset.format;
  
  if (mode) {
    State.deepReadingMode = mode;
    updateDeepModeUI();
    showToast(`深读模式：${mode === 'auto' ? '自动' : mode === 'on' ? '始终开启' : '关闭'}`);
  }
  
  if (format) {
    State.deepReadFormat = format;
    showToast(`解读格式：${format === 'brief' ? '简洁' : '深度'}`);
  }
  
  deepModeDropdown?.classList.remove('visible');
});

// 点击其他区域关闭下拉
document.addEventListener('click', () => {
  deepModeDropdown?.classList.remove('visible');
});

// 检查后端服务状态
async function checkBackendHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const data = await response.json();
    console.log('✅ 后端服务状态:', data.status);
    return true;
  } catch (error) {
    console.warn('⚠️ 后端服务未启动，AI功能将使用本地模拟模式');
    return false;
  }
}

// 调用后端API生成AI回复（支持RAG + 文学深读模式）
function expandSlashCommand(input) {
  const text = (input || '').trim();
  if (!text.startsWith('/')) return text;
  const [command, ...rest] = text.split(/\s+/);
  const body = rest.join(' ').trim();
  const map = {
    '/解释概念': `请解释概念${body ? `“${body}”` : ''}，并结合当前书中的上下文说明它的含义、出处和相关例子。`,
    '/生成知识图谱': '请把当前讨论和书中相关内容整理成结构化知识图谱，用 Markdown 列出节点、关系和可继续追问的问题。',
    '/预读导航': '请基于当前书籍目录和已知上下文，给我一份预读导航：先读什么、留意哪些问题、可能的难点是什么。',
    '/笔记格式化': '请把刚才的讨论整理成适合归档到 Obsidian 的阅读笔记，包含标题、摘录、解释、我的想法和标签。',
    '/记住': `请记住以下阅读偏好或书籍要点，并在后续回答中使用：${body || '当前这条信息'}`
  };
  return map[command] || text.slice(1);
}

function buildPageContext(selectedText = '') {
  const parts = [
    currentBookTitle ? `Book: ${currentBookTitle}` : '',
    DOM.bookChapterBar?.textContent ? `Chapter: ${DOM.bookChapterBar.textContent}` : '',
    State.currentCfi ? `CFI: ${State.currentCfi}` : '',
    selectedText ? `Selected: ${selectedText}` : '',
    State.selectedContext?.before ? `Before: ${State.selectedContext.before}` : '',
    State.selectedContext?.after ? `After: ${State.selectedContext.after}` : ''
  ].filter(Boolean);
  return parts.join('\n');
}

async function generateAIReply(selectedText, question) {
  const q = question.toLowerCase();
  const text = selectedText ? selectedText.slice(0, 50) : '这段内容';
  
  try {
    // 检查后端是否可用
    const isBackendReady = await checkBackendHealth();
    
    if (!isBackendReady || !currentBookId) {
      // 后端未启动或无书籍上下文，使用本地模拟
      return generateMockReply(selectedText, question);
    }

    // 判断是否使用文学深读模式
    const useDeepMode = (() => {
      if (State.deepReadingMode === 'on') return true;
      if (State.deepReadingMode === 'off') return false;
      // auto 模式：有选中文本 + 问题包含文学解读关键词
      if (!selectedText) return false;
      const deepKeywords = ['上下文','表达了','含义','艺术效果','为什么这么写','怎么理解','什么意思','暗示','隐喻','象征','伏笔','铺垫','情绪','心理','意图','手法','作用','效果','背景','为什么','说明什么','体现','反映','表达','表现','解读','赏析','品味','体会','meaning','implication','symbolism'];
      return deepKeywords.some(kw => q.includes(kw));
    })();

    if (useDeepMode && selectedText) {
      // 调用文学深读 API
      const response = await fetch(`${API_BASE}/chat/book-context-deep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: currentBookId,
          question: question,
          selectedText: selectedText,
          chatHistory: State.chatMessages.slice(-12),
          pageContext: buildPageContext(selectedText),
          contextSize: 2,
          format: State.deepReadFormat
        })
      });

      if (!response.ok) {
        throw new Error(`深读API请求失败: ${response.status}`);
      }

      const data = await response.json();
      let answer = data.answer;

      // 如果降级到普通模式
      if (data.deepModeDegraded) {
        answer = '[深读模式降级为普通回答]\n\n' + answer;
      }

      // 添加来源（深读模式：合并上下文片段和补充片段）
      if (data.sources && data.sources.length > 0) {
        answer += formatSources(data.sources, { maxPreview: 120 });
      }

      if (data.mock) {
        answer += '\n\n[系统提示：当前使用模拟回复]';
      }

      return answer;
    }
    
    // 普通模式：调用后端API（带书籍上下文）
    const response = await fetch(`${API_BASE}/chat/book-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: currentBookId,
        question: question,
        selectedText: selectedText,
        pageContext: buildPageContext(selectedText),
        chatHistory: State.chatMessages.slice(-12)
      })
    });
    
    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`);
    }
    
    const data = await response.json();
    
    // 拼接参考来源（可点击跳转）
    let answer = data.answer;
    if (data.sources && data.sources.length > 0) {
      answer += formatSources(data.sources, { maxPreview: 120 });
    }

    // 低置信度提示
    if (data.lowConfidence) {
      answer += '\n\n⚠️ *本次检索未找到书中明确依据，回答可能不够准确*';
    }

    // 如果是模拟模式，添加提示
    if (data.mock) {
      answer += '\n\n[系统提示：当前使用模拟回复，请在服务端 .env 文件中配置真实 AI API Key]';
    }
    
    return answer;
    
  } catch (error) {
    console.error('AI请求失败:', error);
    return generateMockReply(selectedText, question) + 
           '\n\n[错误提示：' + error.message + ']';
  }
}

// 本地模拟回复（备用方案）
function generateMockReply(selectedText, question) {
  const q = question.toLowerCase();
  const text = selectedText ? selectedText.slice(0, 50) : '这段内容';
  
  if (q.includes('意思') || q.includes('含义') || q.includes('解释')) {
    return `这段话的核心意思是：作者在这里想表达的是关于"${text}..."的深层思考。\n\n（后端服务未启动或配置未完成，显示模拟回复）`;
  }
  if (q.includes('为什么') || q.includes('原因')) {
    return `这是因为：在当时的语境下，"${text}..." 反映了某种特定的观点或立场。\n\n（后端服务未启动或配置未完成，显示模拟回复）`;
  }
  if (q.includes('怎么') || q.includes('如何')) {
    return `建议可以从以下几个角度理解：\n1. 结合上下文语境\n2. 关注关键词的用法\n3. 思考作者的写作意图\n\n（后端服务未启动或配置未完成，显示模拟回复）`;
  }
  if (q.includes('例子') || q.includes('举例')) {
    return `这段话可以举例说明：比如在实际阅读场景中，当我们遇到"${text}..."这样的表达时，可以尝试...\n\n（后端服务未启动或配置未完成，显示模拟回复）`;
  }
  
  return `关于"${text}..."，这是一个很好的问题。\n\n我的看法是：这段话值得深入思考。建议你可以结合上下文来理解作者的意图，同时也可以参考相关的背景资料。\n\n（后端服务未启动或配置未完成，显示模拟回复）`;
}

/**
 * 从 XHTML 解析 DOM 并生成每个段落的 CFI（用于精确定位）
 * @param {string} xhtml - 章节的 XHTML 内容
 * @param {Object} spineInfo - 书籍脊信息 { index, idref }
 * @returns {Array<{textPrefix: string, cfi: string}>}
 */
function generateParagraphCfis(xhtml, spineInfo) {
  const cfiList = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xhtml, 'text/html');
    const body = doc.body;
    if (!body) return cfiList;
    
    const spineIndex = (spineInfo?.index ?? 0) + 1; // CFI 从 1 开始
    const idref = spineInfo?.idref || '';
    if (!idref) return cfiList;
    
    // 获取所有可能包含文本的块级元素
    const selectors = ['p', 'div', 'section', 'article', 'li', 'blockquote',
                       'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td'];
    const elements = body.querySelectorAll(selectors.join(','));
    
    elements.forEach(el => {
      const text = (el.textContent || '').trim();
      if (text.length < 5) return; // 忽略过短元素
      
      // 构建 DOM 路径（从元素到 html）
      const path = [];
      let current = el;
      while (current && current.parentNode && current.nodeType === 1) {
        const parent = current.parentNode;
        if (parent.nodeType !== 1) break; // 到 document 节点停止
        
        let index = 0;
        for (let child = parent.firstChild; child; child = child.nextSibling) {
          index++;
          if (child === current) break;
        }
        path.unshift(index);
        current = parent;
        if (current === el.ownerDocument.documentElement) break;
      }
      
      if (path.length > 0) {
        // CFI 格式: epubcfi(/6/{spineIndex}[{idref}]!/4/{path})
        // /6/ → spine 元素, /4/ → html 元素在文档中的位置
        const cfi = `epubcfi(/6/${spineIndex}[${idref}]!/4/${path.join('/')})`;
        cfiList.push({ textPrefix: text.slice(0, 150), cfi });
      }
    });
  } catch (e) {
    console.warn('CFI 生成失败:', e);
  }
  return cfiList;
}

// ==================== 索引书籍内容到RAG ====================
async function indexBookForRAG(book, tocItems) {
  if (!currentBookId) {
    console.warn('未设置书籍ID，跳过RAG索引');
    return;
  }

  // 先检查索引状态
  try {
    const statusRes = await fetch(`${API_BASE}/rag/status/${encodeURIComponent(currentBookId)}`);
    if (statusRes.ok) {
      const status = await statusRes.json();
      if (status.indexed) {
        console.log('⏭️ 书籍索引已存在，跳过重建');
        updateRAGStatus('ready');
        return;
      }
    }
  } catch (e) {
    // 后端未启动或接口不存在，继续尝试索引
  }

  updateRAGStatus('indexing');

  try {
    console.log('📚 开始索引书籍内容到RAG...');

    // 构建 spine 索引映射（用于生成 CFI）
    const spineMap = {};
    if (book.spine && typeof book.spine.each === 'function') {
      book.spine.each((item) => {
        if (item.href) {
          spineMap[item.href] = { index: item.index, idref: item.idref };
        }
      });
    }

    const chapters = [];
    const cfiMap = {}; // textPrefix → CFI，用于参考来源精确定位

    for (const item of tocItems) {
      try {
        const section = book.section(item.href);
        if (!section) {
          console.warn(`找不到章节: ${item.label}`);
          continue;
        }

        let text = '';
        if (book.archive && typeof book.archive.getText === 'function') {
          try {
            const html = await book.archive.getText(section.url);
            // 为当前章节生成段落级 CFI
            const spineInfo = spineMap[item.href] || null;
            const cfiList = generateParagraphCfis(html, spineInfo);
            cfiList.forEach(({ textPrefix, cfi }) => {
              cfiMap[textPrefix] = cfi;
            });
            text = html.replace(/<[^>]*>/g, '');
          } catch (archiveErr) {
            console.warn(`archive 读取失败: ${item.label}`, archiveErr);
          }
        }

        if (text && text.trim()) {
          chapters.push({
            title: item.label,
            content: text.trim(),
            href: item.href
          });
        }
      } catch (e) {
        console.warn(`无法获取章节内容: ${item.label}`, e);
      }
    }

    // 保存 CFI 映射
    if (currentBookId) {
      bookCfiMaps[currentBookId] = cfiMap;
      console.log(`🗺️ CFI 映射已生成: ${Object.keys(cfiMap).length} 个段落`);
    }

    if (chapters.length === 0) {
      console.warn('未获取到任何章节内容');
      updateRAGStatus('error');
      return;
    }

    const response = await fetch(`${API_BASE}/rag/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: currentBookId,
        chapters: chapters
      })
    });

    if (response.ok) {
      const result = await response.json();
      if (result.skipped) {
        console.log('⏭️ RAG索引跳过:', result.reason);
        updateRAGStatus('ready');
      } else {
        console.log(`✅ RAG索引完成: ${result.totalChunks} 个文档块`);
        showToast(`书籍索引完成：${result.totalChunks} 个片段`);
        updateRAGStatus('ready');
      }
    } else {
      console.warn('RAG索引失败');
      updateRAGStatus('error');
    }
  } catch (error) {
    console.error('RAG索引错误:', error);
    updateRAGStatus('error');
  }
}

/**
 * 更新RAG状态指示器
 * @param {string} status - 状态：'not_indexed' | 'indexing' | 'ready' | 'error'
 */
function updateRAGStatus(status) {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  
  if (!statusDot || !statusText) return;
  
  // 移除所有状态类
  statusDot.className = 'status-dot';
  
  switch (status) {
    case 'indexing':
      statusDot.classList.add('indexing');
      statusText.textContent = '索引中...';
      break;
    case 'ready':
      statusDot.classList.add('ready');
      statusText.textContent = '已索引';
      break;
    case 'error':
      statusDot.classList.add('error');
      statusText.textContent = '索引失败';
      break;
    default:
      statusText.textContent = '未索引';
  }
}

// 搜索书籍内容
async function searchBookContent(query) {
  if (!currentBookId) {
    showToast('请先加载书籍');
    return [];
  }
  
  try {
    const response = await fetch(`${API_BASE}/rag/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: currentBookId,
        query: query,
        limit: 5
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      return result.results || [];
    }
  } catch (error) {
    console.error('搜索失败:', error);
  }
  return [];
}

async function runBookSearch() {
  const query = DOM.bookSearchInput?.value?.trim();
  if (!query) return showToast('Enter a search query');
  if (!DOM.searchPanel || !DOM.searchResults) return;
  DOM.searchPanel.classList.add('open');
  DOM.searchResults.innerHTML = '<p class="empty-hint">Searching...</p>';
  const results = await searchBookContent(query);
  renderSearchResults(results, query);
}

function renderSearchResults(results, query) {
  if (!DOM.searchResults) return;
  if (!results.length) {
    DOM.searchResults.innerHTML = `<p class="empty-hint">No results for "${escHtml(query)}".</p>`;
    return;
  }
  DOM.searchResults.innerHTML = '';
  results.forEach((result, index) => {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.innerHTML = `
      <div class="search-result-title">${index + 1}. ${escHtml(result.chapter || 'Unknown chapter')}</div>
      <div class="search-result-text">${escHtml((result.content || '').slice(0, 280))}</div>
    `;
    card.addEventListener('click', () => jumpToSearchResult(result));
    DOM.searchResults.appendChild(card);
  });
}

function jumpToSearchResult(result) {
  if (!State.rendition) return;
  const target = result.cfi || result.href;
  if (!target) return showToast('This result has no location');
  State.rendition.display(target)
    .then(() => {
      DOM.searchPanel?.classList.remove('open');
      showToast('Jumped to result');
    })
    .catch(() => showToast('Jump failed'));
}

DOM.btnBookSearch?.addEventListener('click', runBookSearch);
DOM.bookSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runBookSearch();
  }
});
DOM.btnCloseSearch?.addEventListener('click', () => DOM.searchPanel?.classList.remove('open'));

/* ============================================================
   侧边栏收起/展开
   ============================================================ */
function toggleSidebar(side) {
  const isOpen = State.sidebarState[side];
  State.sidebarState[side] = !isOpen;
  
  if (side === 'notes') {
    DOM.notesPanel.classList.toggle('collapsed', !State.sidebarState.notes);
    updateToggleBtnIcon(DOM.btnToggleNotes, State.sidebarState.notes, 'left');
  } else {
    DOM.aiPanel.classList.toggle('collapsed', !State.sidebarState.ai);
    updateToggleBtnIcon(DOM.btnToggleAI, State.sidebarState.ai, 'right');
  }
}

function updateToggleBtnIcon(btn, isOpen, direction) {
  // 根据展开/收起状态更新图标方向
  const icon = btn.querySelector('svg');
  if (isOpen) {
    // 展开状态，显示"收起"箭头
    if (direction === 'left') {
      icon.innerHTML = '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      btn.title = '收起';
    } else {
      icon.innerHTML = '<path d="M13 17l5-5-5-5M6 17l5-5-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      btn.title = '收起';
    }
  } else {
    // 收起状态，显示"展开"箭头
    if (direction === 'left') {
      icon.innerHTML = '<path d="M13 17l5-5-5-5M6 17l5-5-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      btn.title = '展开';
    } else {
      icon.innerHTML = '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      btn.title = '展开';
    }
  }
}

DOM.btnToggleNotes.addEventListener('click', () => toggleSidebar('notes'));
DOM.btnToggleAI.addEventListener('click', () => toggleSidebar('ai'));

/* ============================================================
   显示设置
   ============================================================ */
DOM.btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  DOM.settingsPanel.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!DOM.settingsPanel.contains(e.target) && e.target !== DOM.btnSettings) {
    DOM.settingsPanel.classList.remove('open');
  }
});

DOM.btnModePaginated.addEventListener('click', () => switchReadMode('paginated'));
DOM.btnModeScroll.addEventListener('click',    () => switchReadMode('scroll'));

function switchReadMode(mode) {
  if (State.readMode === mode) return;
  State.readMode = mode;

  DOM.btnModePaginated.classList.toggle('active', mode === 'paginated');
  DOM.btnModeScroll.classList.toggle('active',    mode === 'scroll');

  if (!State.book) return;

  const restoreCfi = State.currentCfi;

  try { State.rendition.destroy(); } catch(e) {}
  DOM.epubViewport.innerHTML = '';

  const isScroll = mode === 'scroll';
  State.rendition = State.book.renderTo(DOM.epubViewport, {
    width:   '100%',
    height:  isScroll ? undefined : '100%',
    spread:  'none',
    flow:    isScroll ? 'scrolled-doc' : 'paginated',
    manager: isScroll ? 'continuous' : 'default',
  });

  applyThemeToRendition();
  applyFontSize();
  applyReadModeUI();

  State.rendition.on('rendered',  onRendered);
  State.rendition.on('relocated', onRelocated);
  State.rendition.on('selected',  onTextSelected);

  State.rendition.display(restoreCfi || undefined);
  showToast(mode === 'scroll' ? '📜 已切换为滚动模式' : '📄 已切换为分页模式');
}

function applyReadModeUI() {
  const isScroll = State.readMode === 'scroll';
  DOM.btnPrev.style.display = isScroll ? 'none' : '';
  DOM.btnNext.style.display = isScroll ? 'none' : '';
  DOM.epubViewport.classList.toggle('scroll-mode', isScroll);
}

DOM.btnFontPlus.addEventListener('click',  () => changeFontSize(+2));
DOM.btnFontMinus.addEventListener('click', () => changeFontSize(-2));
function changeFontSize(delta) {
  State.fontSize = Math.min(28, Math.max(12, State.fontSize + delta));
  DOM.fontSizeLabel.textContent = State.fontSize + 'px';
  applyFontSize();
}
function applyFontSize() {
  if (!State.rendition) return;
  State.rendition.themes.fontSize(State.fontSize + 'px');
}

DOM.themeSwatches.forEach(swatch => {
  swatch.addEventListener('click', () => {
    DOM.themeSwatches.forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    State.theme = swatch.dataset.theme;
    applyTheme();
  });
});
function applyTheme() {
  document.body.classList.remove('theme-light', 'theme-sepia', 'theme-dark');
  if (State.theme !== 'light') document.body.classList.add(`theme-${State.theme}`);
  applyThemeToRendition();
}
function applyThemeToRendition() {
  if (!State.rendition) return;
  const themes = {
    light: { 'body': { background: '#fffff8', color: '#1a1a1a' } },
    sepia: { 'body': { background: '#f4ecd8', color: '#3b2e1a' } },
    dark:  { 'body': { background: '#1a1a2e', color: '#e0e0e0' } },
  };
  State.rendition.themes.register('current', themes[State.theme] || themes.light);
  State.rendition.themes.select('current');
}

/* ============================================================
   返回首页
   ============================================================ */
DOM.btnBackHome.addEventListener('click', () => {
  if (!confirm('返回首页将关闭当前书籍，阅读进度已自动保存。确认返回？')) return;
  if (State.book) { try { State.book.destroy(); } catch(e) {} }
  State.book = null; State.rendition = null;
  DOM.readerScreen.classList.remove('active');
  DOM.welcomeScreen.classList.add('active');
  DOM.fileInput.value = '';
});

/* ============================================================
   Toast
   ============================================================ */
let toastTimer;
function showToast(msg) {
  DOM.toast.textContent = msg;
  DOM.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => DOM.toast.classList.remove('show'), 2200);
}

/* ============================================================
   工具函数
   ============================================================ */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   初始化
   ============================================================ */
function init() {
  DOM.welcomeScreen.classList.add('active');
  renderNotes();
  renderBookmarkList();
  loadLibrary();
  loadSettings();
  
  // 初始化侧边栏收起按钮图标
  updateToggleBtnIcon(DOM.btnToggleNotes, true, 'left');
  updateToggleBtnIcon(DOM.btnToggleAI, true, 'right');

  // 初始化深读模式 UI
  updateDeepModeUI();
}

init();
