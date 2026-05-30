/**
 * ReadFlow Backend Server
 * 
 * 功能：
 * 1. AI API 代理（保护 API Key）
 * 2. RAG 向量存储与检索
 * 3. 书籍内容索引管理
 * 4. 笔记数据持久化
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const aiService = require('./ai-service');
const embeddingService = require('./embedding-service');
const BM25 = require('wink-bm25-text-search');
const memoryService = require('./memory-service');
const citationService = require('./citation-service');
const routingService = require('./routing-service');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

for (const dir of [DATA_DIR, BOOKS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({ dest: UPLOADS_DIR });

function addColumnIfMissing(table, columnSql) {
  db.run(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn(`⚠️ 迁移 ${table}.${columnSql} 失败:`, err.message);
    }
  });
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return safeJsonParse(fs.readFileSync(SETTINGS_PATH, 'utf8'), {}) || {};
}

function writeSettings(nextSettings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(nextSettings, null, 2), 'utf8');
}

function sanitizeFileName(name) {
  return String(name || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

function computeFileHash(filePath) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ==================== 中间件配置 ====================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.')));

// ==================== 数据库初始化 ====================
const DB_PATH = path.join(__dirname, 'data', 'readflow.db');

// 确保数据目录存在
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

// 初始化表结构
db.serialize(() => {
  // 笔记表
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter TEXT,
      cfi TEXT,
      quote TEXT,
      content TEXT NOT NULL,
      color TEXT DEFAULT 'yellow',
      context_before TEXT,
      context_after TEXT,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 书签表
  db.run(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter TEXT,
      cfi TEXT,
      label TEXT,
      position INTEGER,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 高亮表
  db.run(`
    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter TEXT,
      cfi TEXT,
      text TEXT NOT NULL,
      color TEXT DEFAULT '#fbbf24',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 阅读进度表
  db.run(`
    CREATE TABLE IF NOT EXISTS reading_progress (
      book_id TEXT PRIMARY KEY,
      chapter TEXT,
      cfi TEXT,
      position INTEGER DEFAULT 0,
      percentage REAL DEFAULT 0,
      total_chars INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      file_name TEXT,
      file_path TEXT,
      cover TEXT,
      toc TEXT,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_opened_at DATETIME
    )
  `);

  addColumnIfMissing('notes', "cfi TEXT");
  addColumnIfMissing('notes', "color TEXT DEFAULT 'yellow'");
  addColumnIfMissing('notes', "context_before TEXT");
  addColumnIfMissing('notes', "context_after TEXT");
  addColumnIfMissing('bookmarks', "cfi TEXT");
  addColumnIfMissing('bookmarks', "label TEXT");
  addColumnIfMissing('highlights', "cfi TEXT");
  addColumnIfMissing('reading_progress', "cfi TEXT");
  addColumnIfMissing('reading_progress', "percentage REAL DEFAULT 0");

  // RAG: 文档块表（用于向量检索）
  db.run(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter TEXT,
      chapter_index INTEGER,
      href TEXT,
      cfi_start TEXT,
      cfi_end TEXT,
      paragraph_index INTEGER,
      content TEXT NOT NULL,
      embedding TEXT, -- JSON 存储向量
      chunk_index INTEGER,
      prev_chunk_id TEXT,
      next_chunk_id TEXT,
      source_type TEXT DEFAULT 'body',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：添加 source_type 列（如果表已存在）
  db.run(`ALTER TABLE document_chunks ADD COLUMN source_type TEXT DEFAULT 'body'`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn('⚠️ source_type 列迁移警告（可能已存在）:', err.message);
    }
  });

  // 索引元数据表（避免重复索引）
  db.run(`
    CREATE TABLE IF NOT EXISTS index_metadata (
      book_id TEXT PRIMARY KEY,
      content_hash TEXT,
      embedding_model TEXT,
      chunk_strategy TEXT,
      chunk_size INTEGER,
      chunk_overlap INTEGER,
      total_chunks INTEGER DEFAULT 0,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // AI 对话历史表
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      selected_text TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 评测集表
  db.run(`
    CREATE TABLE IF NOT EXISTS evaluation_set (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      question TEXT NOT NULL,
      expected_answer TEXT,
      question_type TEXT, -- fact, summary, cross_chapter, citation, negative
      expected_chunks TEXT, -- JSON array of chunk ids
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ========== 记忆表初始化（三层记忆体系）==========
  memoryService.initMemoryTables(db);
  console.log('✅ 记忆表初始化完成');

  console.log('✅ 数据库初始化完成');
});

// ==================== 记忆提取（异步，不阻塞主流程）====================

/**
 * triggerMemoryExtraction: 每5轮对话触发一次小模型记忆提取
 * 对齐 deepreader 的 memoryExtract 工具
 * 从最近对话中提取 user_profile、book_gist、concept 三层记忆
 */
async function triggerMemoryExtraction(db, aiService, bookId, sessionId, chatHistory, lastQuestion) {
  if (!chatHistory || chatHistory.length < 3) return;

  // 取最近5轮对话
  const recentHistory = chatHistory.slice(-5);
  const historyText = recentHistory.map(m =>
    `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 150)}`
  ).join('\n');

  const extractPrompt = `你是一个阅读助手的记忆提取模块。请从以下对话历史中提取关键信息，分类存储。

【提取规则】
从对话中提取以下三类信息：

1. user_profile（用户画像）：用户的沟通风格、阅读偏好、特殊需求
   - 例如："用户喜欢简洁的回答"、"用户关注技术细节"、"用户偏好深入分析"

2. book_gist（书籍要点）：书中的核心论点、重要情节、章节要点
   - 例如："本书核心观点是XXX"、"第三章讨论了YYY"、"故事发生在ZZZ"

3. concept（重要概念）：书中出现的关键定义、术语解释
   - 例如："小王子的'驯服'指的是建立情感联系"、"狐狸说：'你为某物花费了时间，才使其变得重要'"

对话历史：
${historyText}

请输出以下JSON格式（只输出JSON）：
{
  "user_profile": {
    "communication_style": "从对话推断的用户沟通偏好",
    "reading_preference": "用户的阅读兴趣或偏好",
    "interest_topics": ["用户感兴趣的话题列表"],
    "special_requirements": "用户的特殊要求或习惯"
  },
  "book_gists": [
    {
      "gist_type": "核心论点|重要情节|章节要点",
      "content": "具体内容（50字以内）",
      "chapter": "如果提到了章节，写章节名"
    }
  ],
  "concepts": [
    {
      "concept": "概念名称",
      "definition": "书中给出的定义或解释（30字以内）"
    }
  ]
}`;

  try {
    const result = await aiService.chat(
      [{ role: 'system', content: extractPrompt }],
      { temperature: 0.3, maxTokens: 500, provider: 'zhipu' }
    );

    const text = result.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.log('⚠️ 记忆提取失败：无法解析JSON');
      return;
    }

    const extracted = JSON.parse(jsonMatch[0]);

    // 存储 user_profile
    if (extracted.user_profile) {
      await new Promise((resolve, reject) => {
        memoryService.setUserProfileBatch(db, 'default', extracted.user_profile, err => err ? reject(err) : resolve());
      });
      console.log('✅ user_profile 记忆已更新');
    }

    // 存储 book_gists
    if (extracted.book_gists && Array.isArray(extracted.book_gists)) {
      for (const gist of extracted.book_gists.slice(0, 5)) {
        await new Promise((resolve, reject) => {
          memoryService.upsertBookGist(db, bookId, gist.gist_type, gist.content, gist.chapter, null, 3, err => err ? reject(err) : resolve());
        });
      }
      console.log(`✅ 提取了 ${extracted.book_gists.length} 条 book_gist`);
    }

    // 存储 concepts
    if (extracted.concepts && Array.isArray(extracted.concepts)) {
      for (const concept of extracted.concepts.slice(0, 5)) {
        await new Promise((resolve, reject) => {
          memoryService.upsertConceptMemory(db, bookId, concept.concept, concept.definition, null, null, null, err => err ? reject(err) : resolve());
        });
      }
      console.log(`✅ 提取了 ${extracted.concepts.length} 条 concept`);
    }

    console.log('✅ 记忆提取完成');
  } catch (error) {
    console.warn('记忆提取出错:', error.message);
  }
}

// ==================== 工具函数 ====================

/** ==================== 工具函数 ==================== */

/**
 * 计算内容hash（用于判断是否需要重建索引）
 */
function computeContentHash(chapters) {
  const crypto = require('crypto');
  const text = chapters.map(c => c.title + '\n' + (c.content || '')).join('\n---\n');
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * 计算余弦相似度（用于本地向量检索）
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 向量缓存（解析后的向量，避免重复JSON.parse）
const vectorCache = new Map(); // bookId -> { timestamp, vectors: Map(chunkId -> Float32Array) }
const VECTOR_CACHE_TTL = 30 * 60 * 1000; // 30分钟

function getCachedVectors(bookId) {
  const cached = vectorCache.get(bookId);
  if (cached && Date.now() - cached.timestamp < VECTOR_CACHE_TTL) {
    return cached.vectors;
  }
  return null;
}

function setCachedVectors(bookId, vectors) {
  vectorCache.set(bookId, { timestamp: Date.now(), vectors });
}

function invalidateVectorCache(bookId) {
  vectorCache.delete(bookId);
}

/**
 * 改进的文本分块：段落优先 + 最大长度限制 + overlap
 * @param {string} text - 章节文本
 * @param {Object} meta - 章节元数据 { title, href, chapterIndex }
 * @param {number} maxChunkSize - 单块最大字符数（默认800）
 * @param {number} overlap - 重叠字符数（默认150）
 * @returns {Array} chunks - 每个chunk含 content, paragraphIndex 等
 */
function chunkTextByParagraphs(text, meta, maxChunkSize = 800, overlap = 150) {
  // 先按段落分割（支持多种换行格式）
  const paragraphs = text
    .split(/\n{2,}|\r\n{2,}/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 0);

  const chunks = [];
  let current = [];
  let currentLen = 0;
  let startParagraph = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    // 如果单个段落就超长，直接按句子切分（保底策略）
    if (p.length > maxChunkSize * 1.5) {
      // 先把当前累积的段落flush出去
      if (current.length > 0) {
        chunks.push({
          content: current.join('\n\n'),
          paragraphIndex: startParagraph,
          chapter: meta.title,
          chapterIndex: meta.chapterIndex,
          href: meta.href,
        });
      }
      // 强制句子级切分
      const sentences = p.match(/[^。？！.?!]+[。？！.?!]+|[^。？！.?!]+$/g) || [p];
      let sBuffer = [];
      let sLen = 0;
      for (const s of sentences) {
        if (sLen + s.length > maxChunkSize && sBuffer.length > 0) {
          chunks.push({
            content: sBuffer.join(''),
            paragraphIndex: i,
            chapter: meta.title,
            chapterIndex: meta.chapterIndex,
            href: meta.href,
          });
          // overlap: 保留后半部分句子
          const overlapText = sBuffer.join('').slice(-overlap);
          sBuffer = [overlapText];
          sLen = overlapText.length;
        }
        sBuffer.push(s);
        sLen += s.length;
      }
      if (sBuffer.length > 0) {
        chunks.push({
          content: sBuffer.join(''),
          paragraphIndex: i,
          chapter: meta.title,
          chapterIndex: meta.chapterIndex,
          href: meta.href,
        });
      }
      current = [];
      currentLen = 0;
      startParagraph = i + 1;
      continue;
    }

    // 正常段落累积
    if (currentLen + p.length > maxChunkSize && current.length > 0) {
      chunks.push({
        content: current.join('\n\n'),
        paragraphIndex: startParagraph,
        chapter: meta.title,
        chapterIndex: meta.chapterIndex,
        href: meta.href,
      });
      // overlap: 保留最后一段作为下一块开头
      const lastPara = current[current.length - 1];
      current = lastPara.length > overlap ? [lastPara.slice(-overlap)] : [lastPara];
      currentLen = current[0].length;
      startParagraph = i;
    }
    current.push(p);
    currentLen += p.length;
  }

  // flush剩余
  if (current.length > 0) {
    chunks.push({
      content: current.join('\n\n'),
      paragraphIndex: startParagraph,
      chapter: meta.title,
      chapterIndex: meta.chapterIndex,
      href: meta.href,
    });
  }

  return chunks;
}

// ==================== BM25 索引（按书缓存）====================

// BM25索引缓存: bookId -> { index, ready, timestamp, docCount }
const bm25Cache = new Map();
const BM25_CACHE_TTL = 60 * 60 * 1000; // 60分钟

function getCachedBM25(bookId) {
  const cached = bm25Cache.get(bookId);
  if (cached && Date.now() - cached.timestamp < BM25_CACHE_TTL) {
    return cached;
  }
  return null;
}

/**
 * 初始化BM25索引（按书隔离）
 */
function initBM25Index(db, bookId, callback) {
  const cached = getCachedBM25(bookId);
  if (cached && cached.ready) {
    callback(null, cached.index);
    return;
  }

  const bm25 = BM25();
  bm25.defineConfig(['content']);

  db.all(
    `SELECT id, chapter, chapter_index, href, paragraph_index, content FROM document_chunks WHERE book_id = ? ORDER BY chunk_index`,
    [bookId],
    (err, rows) => {
      if (err) {
        callback(err);
        return;
      }

      if (!rows || rows.length === 0) {
        bm25Cache.set(bookId, { index: bm25, ready: true, timestamp: Date.now(), docCount: 0 });
        callback(null, bm25);
        return;
      }

      rows.forEach((row, index) => {
        bm25.addDoc({
          id: row.id,
          chapter: row.chapter,
          chapter_index: row.chapter_index,
          href: row.href,
          paragraph_index: row.paragraph_index,
          content: row.content
        }, index);
      });

      bm25Cache.set(bookId, { index: bm25, ready: true, timestamp: Date.now(), docCount: rows.length });
      console.log(`✅ BM25索引构建完成: ${bookId}, ${rows.length} 个文档块`);
      callback(null, bm25);
    }
  );
}

/**
 * 轻量 rerank：基于查询词命中密度、向量分、章节邻近性
 */
function rerankResults(results, query, limit = 5) {
  const qTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);

  return results.map(r => {
    const content = (r.content || '').toLowerCase();
    let termHits = 0;
    qTerms.forEach(t => {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const m = content.match(re);
      if (m) termHits += m.length;
    });
    const hitDensity = qTerms.length > 0 ? termHits / qTerms.length : 0;
    const vectorScore = r.vectorScore || 0;
    const bm25Score = r.bm25Score || 0;

    // 综合分: 向量分权重0.45, BM25权重0.30, 词命中权重0.15, 章节邻近 bonus 0.10
    let score = vectorScore * 0.45 + Math.min(bm25Score, 1) * 0.30 + Math.min(hitDensity * 0.3, 1) * 0.15;

    // 章节邻近性 bonus：如果同章节有其他高排名结果，微弱加分（已在RRF中体现，这里简化）
    if (r.chapter_index !== undefined && r.chapter_index >= 0) {
      score += 0.02; // 有章节信息的微弱优势
    }

    return { ...r, rerankScore: score };
  }).sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit);
}

/**
 * 混合检索（BM25 + 向量 + RRF融合 + Rerank）
 * @param {Object} db - 数据库连接
 * @param {string} bookId - 书籍ID
 * @param {string} query - 查询文本
 * @param {string} selectedText - 用户选中的文本（可选，用于增强检索）
 * @param {number} limit - 返回结果数量
 * @param {Function} callback - 回调函数
 */
function hybridSearch(db, bookId, query, selectedText = '', limit = 5, callback) {
  // 如果用户有选中文本，拼接进检索query
  const searchQuery = selectedText
    ? `${selectedText.slice(0, 200)} ${query}`
    : query;

  // 1. BM25检索（按书隔离）
  const cached = getCachedBM25(bookId);
  let bm25Results = [];
  if (cached && cached.ready) {
    try {
      bm25Results = cached.index.search(searchQuery).slice(0, 40); // 先取40个给rerank留空间
    } catch (e) {
      console.warn('BM25检索失败:', e.message);
    }
  }

  // 2. 向量检索
  embeddingService.getEmbeddings([searchQuery], embeddingService.DEFAULT_DIMENSIONS)
    .then(queryEmbeddings => {
      const queryVector = queryEmbeddings[0];

      // 尝试向量缓存
      let cachedVectors = getCachedVectors(bookId);

      const doVectorSearch = (rows) => {
        const vectorResults = [];
        const vectorsToCache = cachedVectors || new Map();

        rows.forEach((row, index) => {
          if (!row.embedding) return;
          let docVector;
          if (cachedVectors && cachedVectors.has(row.id)) {
            docVector = cachedVectors.get(row.id);
          } else {
            try {
              docVector = JSON.parse(row.embedding);
              vectorsToCache.set(row.id, docVector);
            } catch (e) { return; }
          }
          const similarity = cosineSimilarity(queryVector, docVector);
          vectorResults.push({
            id: row.id,
            chapter: row.chapter,
            chapter_index: row.chapter_index,
            href: row.href,
            paragraph_index: row.paragraph_index,
            content: row.content,
            score: similarity,
            rank: index
          });
        });

        if (!cachedVectors) {
          setCachedVectors(bookId, vectorsToCache);
        }

        vectorResults.sort((a, b) => b.score - a.score);
        vectorResults.splice(limit * 4); // 保留前N*4个，给rerank留空间
        return vectorResults;
      };

      if (cachedVectors) {
        // 仍需读取 content 和 metadata，但可以跳过 embedding 解析
        db.all(
          `SELECT id, chapter, chapter_index, href, paragraph_index, content, embedding FROM document_chunks WHERE book_id = ?`,
          [bookId],
          (err, rows) => {
            if (err) { callback(err); return; }
            const vectorResults = doVectorSearch(rows);
            mergeAndRerank(bm25Results, vectorResults, query, limit, callback);
          }
        );
      } else {
        db.all(
          `SELECT id, chapter, chapter_index, href, paragraph_index, content, embedding FROM document_chunks WHERE book_id = ?`,
          [bookId],
          (err, rows) => {
            if (err) { callback(err); return; }
            const vectorResults = doVectorSearch(rows);
            mergeAndRerank(bm25Results, vectorResults, query, limit, callback);
          }
        );
      }
    })
    .catch(error => {
      console.error('向量检索失败:', error);
      const fallbackResults = bm25Results.slice(0, limit).map(result => ({
        id: result.doc.id,
        chapter: result.doc.chapter,
        chapter_index: result.doc.chapter_index,
        href: result.doc.href,
        content: result.doc.content,
        bm25Score: result.score
      }));
      callback(null, fallbackResults);
    });
}

/**
 * RRF融合 + Rerank + 低置信度检测
 */
function mergeAndRerank(bm25Results, vectorResults, query, limit, callback) {
  const rrfScores = new Map();
  const allDocMap = new Map();
  const RRF_K = 60;

  // BM25结果
  bm25Results.forEach((result, rank) => {
    const id = result.doc.id;
    if (!rrfScores.has(id)) {
      rrfScores.set(id, 0);
      allDocMap.set(id, {
        id,
        chapter: result.doc.chapter,
        chapter_index: result.doc.chapter_index,
        href: result.doc.href,
        paragraph_index: result.doc.paragraph_index,
        content: result.doc.content,
        bm25Score: result.score
      });
    }
    rrfScores.set(id, rrfScores.get(id) + 1 / (RRF_K + rank + 1));
  });

  // 向量结果
  vectorResults.forEach((result, rank) => {
    const id = result.id;
    if (!rrfScores.has(id)) {
      rrfScores.set(id, 0);
      allDocMap.set(id, {
        id,
        chapter: result.chapter,
        chapter_index: result.chapter_index,
        href: result.href,
        paragraph_index: result.paragraph_index,
        content: result.content,
        vectorScore: result.score
      });
    }
    rrfScores.set(id, rrfScores.get(id) + 1 / (RRF_K + rank + 1));
  });

  // 转换为数组
  let merged = Array.from(rrfScores.entries())
    .map(([id, rrfScore]) => ({ ...allDocMap.get(id), rrfScore }));

  // Rerank
  merged = rerankResults(merged, query, limit * 2);

  // 低置信度检测
  const topVector = vectorResults[0]?.score || 0;
  const hasBM25 = bm25Results.length > 0;
  const topRRF = merged[0]?.rrfScore || 0;

  const lowConfidence = !hasBM25 && topVector < 0.45 || topRRF < 0.015;

  callback(null, merged.slice(0, limit), { lowConfidence, topVectorScore: topVector, topRRFScore: topRRF, bm25HitCount: bm25Results.length });
}

function mapBookRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.id,
    title: row.title,
    author: row.author,
    fileName: row.file_name,
    cover: row.cover,
    toc: safeJsonParse(row.toc, []),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    progress: {
      cfi: row.cfi || null,
      chapter: row.progress_chapter || row.chapter || null,
      position: row.position || 0,
      percentage: row.percentage || 0,
      updatedAt: row.progress_updated_at || null
    },
    index: {
      totalChunks: row.total_chunks || 0,
      indexedAt: row.indexed_at || null
    }
  };
}

function mapNoteRow(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    chapter: row.chapter,
    cfi: row.cfi,
    quote: row.quote,
    content: row.content,
    body: row.content,
    color: row.color || 'yellow',
    contextBefore: row.context_before || '',
    contextAfter: row.context_after || '',
    tags: safeJsonParse(row.tags, []),
    time: row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBookmarkRow(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    chapter: row.chapter,
    cfi: row.cfi,
    label: row.label || row.chapter,
    position: row.position || 0,
    note: row.note || '',
    time: row.created_at,
    createdAt: row.created_at
  };
}

function mapHighlightRow(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    chapter: row.chapter,
    cfi: row.cfi,
    text: row.text,
    color: row.color || '#fbbf24',
    createdAt: row.created_at
  };
}

// ==================== API 路由 ====================

// 健康检查
app.get('/api/health', (req, res) => {
  const available = aiService.getAvailableProvider();
  const configured = aiService.getConfiguredProviders();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ai: {
      available: !!available,
      provider: available ? available.provider : null,
      name: available ? available.config.name : null,
      model: available ? available.config.model : null,
      configured: configured.length,
      providers: configured.map(p => ({ key: p.key, name: p.name, model: p.model }))
    }
  });
});

/**
 * GET /api/ai/config
 * 获取 AI 配置信息（不包含敏感信息）
 */
app.get('/api/ai/config', (req, res) => {
  const available = aiService.getAvailableProvider();
  const configured = aiService.getConfiguredProviders();
  
  res.json({
    available: !!available,
    defaultProvider: available ? available.provider : null,
    defaultName: available ? available.config.name : null,
    defaultModel: available ? available.config.model : null,
    providers: configured.map(p => ({ key: p.key, name: p.name, model: p.model }))
  });
});

// ==================== AI API 代理 ====================

/**
 * POST /api/chat
 * 代理 AI 聊天请求
 */
// ==================== Books / Library API ====================

app.post('/api/books/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '缺少 EPUB 文件' });
  }

  try {
    const hash = computeFileHash(req.file.path);
    const bookId = req.body.bookId || `book_${hash.slice(0, 16)}`;
    const title = (req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname)) || '未命名书籍').trim();
    const author = (req.body.author || '').trim();
    const cover = req.body.cover || null;
    const toc = req.body.toc || '[]';
    const bookDir = path.join(BOOKS_DIR, bookId);
    fs.mkdirSync(bookDir, { recursive: true });
    const fileName = `${sanitizeFileName(title)}.epub`;
    const finalPath = path.join(bookDir, 'source.epub');
    fs.copyFileSync(req.file.path, finalPath);
    fs.unlinkSync(req.file.path);

    db.run(
      `INSERT INTO books (id, title, author, file_name, file_path, cover, toc, content_hash, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         author = excluded.author,
         file_name = excluded.file_name,
         file_path = excluded.file_path,
         cover = excluded.cover,
         toc = excluded.toc,
         content_hash = excluded.content_hash,
         updated_at = CURRENT_TIMESTAMP,
         last_opened_at = CURRENT_TIMESTAMP`,
      [bookId, title, author, fileName, finalPath, cover, toc, hash],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ bookId, id: bookId, title, author, cover, contentHash: hash, fileName });
      }
    );
  } catch (error) {
    try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/books', (req, res) => {
  db.all(
    `SELECT b.*, p.cfi, p.chapter AS progress_chapter, p.position, p.percentage,
            p.updated_at AS progress_updated_at, im.total_chunks, im.indexed_at
     FROM books b
     LEFT JOIN reading_progress p ON p.book_id = b.id
     LEFT JOIN index_metadata im ON im.book_id = b.id
     ORDER BY COALESCE(b.last_opened_at, b.updated_at, b.created_at) DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ books: (rows || []).map(mapBookRow) });
    }
  );
});

app.get('/api/books/:bookId', (req, res) => {
  db.get(
    `SELECT b.*, p.cfi, p.chapter AS progress_chapter, p.position, p.percentage,
            p.updated_at AS progress_updated_at, im.total_chunks, im.indexed_at
     FROM books b
     LEFT JOIN reading_progress p ON p.book_id = b.id
     LEFT JOIN index_metadata im ON im.book_id = b.id
     WHERE b.id = ?`,
    [req.params.bookId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: '书籍不存在' });
      db.run('UPDATE books SET last_opened_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.bookId]);
      res.json(mapBookRow(row));
    }
  );
});

app.get('/api/books/:bookId/file', (req, res) => {
  db.get('SELECT file_path FROM books WHERE id = ?', [req.params.bookId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ error: 'EPUB 文件不存在' });
    }
    res.sendFile(path.resolve(row.file_path), { headers: { 'Content-Type': 'application/epub+zip' } });
  });
});

app.delete('/api/books/:bookId', (req, res) => {
  const { bookId } = req.params;
  db.serialize(() => {
    for (const table of ['notes', 'bookmarks', 'highlights', 'reading_progress', 'document_chunks', 'index_metadata', 'chat_history', 'evaluation_set', 'book_gists', 'concept_memories', 'conversation_sessions']) {
      db.run(`DELETE FROM ${table} WHERE book_id = ?`, [bookId]);
    }
    db.run('DELETE FROM books WHERE id = ?', [bookId], function(deleteErr) {
      if (deleteErr) return res.status(500).json({ error: deleteErr.message });
      invalidateVectorCache(bookId);
      bm25Cache.delete(bookId);
      const bookDir = path.join(BOOKS_DIR, bookId);
      if (bookDir.startsWith(BOOKS_DIR) && fs.existsSync(bookDir)) {
        fs.rmSync(bookDir, { recursive: true, force: true });
      }
      res.json({ success: true, deleted: this.changes });
    });
  });
});

app.get('/api/settings', (req, res) => {
  res.json({
    settings: {
      defaultProvider: process.env.DEFAULT_AI_PROVIDER || 'openai',
      openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      openaiModel: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      embeddingProvider: 'zhipu',
      obsidianVaultPath: '',
      ...readSettings()
    }
  });
});

app.put('/api/settings', (req, res) => {
  const current = readSettings();
  const allowed = ['defaultProvider', 'openaiBaseUrl', 'openaiModel', 'embeddingProvider', 'obsidianVaultPath'];
  const next = { ...current };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) next[key] = req.body[key];
  }
  writeSettings(next);
  res.json({ success: true, settings: next });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, temperature = 0.7, stream = false, provider } = req.body;
  
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages 参数不能为空' });
  }

  // 检查是否有可用的 AI 提供商
  const available = aiService.getAvailableProvider();
  if (!available) {
    // 如果没有配置 API Key，返回模拟回复（开发模式）
    console.log('⚠️ 未配置任何 AI API Key，返回模拟回复');
    const lastMessage = messages[messages.length - 1];
    return res.json({
      choices: [{
        message: {
          role: 'assistant',
          content: `[模拟回复] 收到消息："${lastMessage?.content?.slice(0, 50)}..."\n\n请在 .env 文件中配置真实的 AI API Key 以获得真实回复。`
        }
      }],
      model: 'mock-model',
      mock: true
    });
  }

  try {
    const data = await aiService.chat(messages, {
      model,
      temperature,
      stream,
      provider
    });
    res.json(data);
  } catch (error) {
    console.error('AI API 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取相邻chunk的上下文窗口
 */
function fetchNeighborChunks(db, chunkIds, callback) {
  if (!chunkIds || chunkIds.length === 0) { callback(null, {}); return; }
  const placeholders = chunkIds.map(() => '?').join(',');
  db.all(
    `SELECT c1.id, c1.chapter, c1.chapter_index, c1.href, c1.paragraph_index,
            c1.content, c1.chunk_index,
            prev.content as prev_content, next.content as next_content
     FROM document_chunks c1
     LEFT JOIN document_chunks prev ON c1.prev_chunk_id = prev.id
     LEFT JOIN document_chunks next ON c1.next_chunk_id = next.id
     WHERE c1.id IN (${placeholders})`,
    chunkIds,
    (err, rows) => {
      if (err) { callback(err); return; }
      const map = {};
      rows.forEach(r => {
        map[r.id] = {
          id: r.id,
          chapter: r.chapter,
          chapter_index: r.chapter_index,
          href: r.href,
          paragraph_index: r.paragraph_index,
          chunk_index: r.chunk_index,
          content: r.content,
          prevContent: r.prev_content,
          nextContent: r.next_content
        };
      });
      callback(null, map);
    }
  );
}

/**
 * POST /api/chat/book-context
 * 基于书籍内容的AI对话 - L0-L4 路由增强版
 *
 * L0 · 对话历史：本轮已回答过的概念 → 直接引用
 * L1 · 页面上下文：无需检索 → 直接回答
 * L2 · 书内 RAG：检索 + citation 标注
 * L3 · 网络搜索：暂未实现
 * L4 · 通识知识：降级回答
 *
 * 新增：记忆注入、语义上下文、chunk_id 引用标注
 */
function saveChatTurn(bookId, selectedText, question, answer, model = 'local') {
  const chatId = uuidv4();
  db.run(
    `INSERT INTO chat_history (id, book_id, selected_text, question, answer, model) VALUES (?, ?, ?, ?, ?, ?)`,
    [chatId, bookId, selectedText || null, question, answer, model],
    (err) => { if (err) console.error('Save chat history failed:', err); }
  );
  return chatId;
}

app.post('/api/chat/book-context', async (req, res) => {
  const { bookId, selectedText, question, chatHistory = [], provider, pageContext = null } = req.body;

  if (!bookId || !question) {
    return res.status(400).json({ error: '缺少 bookId 或 question 参数' });
  }

  try {
    console.log(`💬 AI对话请求 [L0-L4路由]: ${question.slice(0, 50)}...`);

    // ========== L0: 检查对话历史 ==========
    const historyResult = routingService.findHistoryAnswer(chatHistory, question, selectedText);
    if (historyResult) {
      console.log(`✅ L0命中: 复用历史回答 (round ${historyResult.round})`);
      return res.json({
        ...routingService.buildHistoryAnswer(historyResult, question, selectedText),
        citations: [],
        chatId: null
      });
    }

    // ========== L1: 检查页面上下文是否足够 ==========
    if (pageContext && pageContext.trim().length >= 30) {
      const pageSufficient = await routingService.determinePageContextSufficiency(
        aiService, question, selectedText, pageContext, { provider }
      );
      if (pageSufficient.sufficient) {
        console.log(`✅ L1命中: 页面上下文直接回答`);
        const l1Answer = await routingService.buildPageAnswer(pageContext, question, aiService, { provider, temperature: 0.7 });
        return res.json({
          ...l1Answer,
          citations: [],
          chatId: null
        });
      }
    }

    // ========== L2: 书内 RAG（默认路径）==========
    console.log(`🔄 降级到L2: 书内RAG检索`);

    // 获取三层记忆（注入 prompt）
    const session = await new Promise((resolve, reject) => {
      memoryService.getOrCreateSession(db, bookId, 'default', (err, s) => err ? reject(err) : resolve(s));
    });
    const memory = await new Promise((resolve, reject) => {
      memoryService.getInjectableMemory(db, bookId, 'default', (err, m) => err ? reject(err) : resolve(m));
    });
    const memoryPrompt = memoryService.formatMemoryForPrompt(memory);
    await new Promise((resolve, reject) => {
      memoryService.incrementTurnCount(db, session.id, err => err ? reject(err) : resolve());
    });

    // 增加对话轮次计数
    memoryService.shouldExtractMemory(db, session.id, 5, async (err, shouldExtract) => {
      if (shouldExtract) {
        console.log(`📝 达到5轮对话，触发记忆提取（异步，不阻塞回答）`);
        // 异步触发记忆提取，不阻塞主流程
        triggerMemoryExtraction(db, aiService, bookId, session.id, chatHistory, question).catch(e =>
          console.warn('记忆提取失败:', e.message)
        );
      }
    });

    // 1. 混合检索获取相关文档块
    const { results: relevantChunks, meta: searchMeta } = await new Promise((resolve, reject) => {
      hybridSearch(db, bookId, question, selectedText || '', 5, (err, results, meta) => {
        if (err) {
          console.warn('混合检索失败，使用降级方案:', err.message);
          db.all(
            `SELECT id, chapter, chapter_index, href, paragraph_index, content,
                    chunk_index, prev_chunk_id, next_chunk_id, source_type
             FROM document_chunks
             WHERE book_id = ? AND content LIKE ?
             ORDER BY chunk_index LIMIT ?`,
            [bookId, `%${(selectedText || question).slice(0, 20)}%`, 5],
            (err2, rows) => {
              if (err2) reject(err2);
              else resolve({ results: rows || [], meta: { lowConfidence: true } });
            }
          );
        } else {
          resolve({ results: results || [], meta: meta || {} });
        }
      });
    });

    console.log(`✅ L2检索到 ${relevantChunks.length} 个相关片段, lowConfidence=${searchMeta.lowConfidence}`);

    // 2. 低置信度 + 无结果：返回明确提示
    if (searchMeta.lowConfidence && relevantChunks.length === 0) {
      return res.json({
        answer: `抱歉，我在书中未能检索到与这个问题相关的明确依据。\n\n可能的原因：\n1. 书中确实没有涉及此话题的内容\n2. 您的问题与书中内容的表述方式差异较大\n\n建议您：\n- 换用书中出现过的关键词重新提问\n- 先选中一段相关文字，再基于它提问\n- 提问更具体一些，缩小范围`,
        sources: [],
        citations: [],
        lowConfidence: true,
        ragEnabled: true,
        routing: { level: 2, reasoning: '检索无结果' }
      });
    }

    // 3. 获取前后文窗口（增强上下文）
    const enrichedChunks = await new Promise((resolve, reject) => {
      const ids = relevantChunks.map(c => c.id).filter(Boolean);
      if (ids.length === 0) { resolve([]); return; }
      fetchNeighborChunks(db, ids, (err, neighborMap) => {
        if (err) { reject(err); return; }
        resolve(relevantChunks.map(c => ({ ...c, ...(neighborMap[c.id] || {}) })));
      });
    });

    // 4. 检查是否有可用的 AI 提供商
    const available = aiService.getAvailableProvider();
    if (!available) {
      const mockAnswer = `Mock RAG answer for: ${question}`;
      saveChatTurn(bookId, selectedText || null, question, mockAnswer, 'mock');
      return res.json({
        answer: `[模拟RAG回复] 基于书籍内容回答问题："${question}"\n\n${selectedText ? `你选中的文本："${selectedText.slice(0, 50)}..."\n\n` : ''}${enrichedChunks.length > 0 ? `找到 ${enrichedChunks.length} 个相关片段。` : '未找到相关内容。'}\n\n请在 .env 文件中配置真实的 AI API Key。`,
        sources: enrichedChunks,
        citations: citationService.buildCitations(enrichedChunks),
        mock: true,
        routing: { level: 2, reasoning: '无API Key模拟回复' }
      });
    }

    // 5. 生成语义上下文（异步，不阻塞）
    const semanticCtxPromise = semanticContextBuild(
      aiService, bookId, selectedText, question,
      enrichedChunks[0] || null, { provider }
    );

    // 6. 组装带 citation 的上下文
    const { formatted: context, citations } = citationService.formatContextWithCitations(enrichedChunks, 300);

    console.log(`📝 上下文长度: ${context.length} 字符, citations: ${citations.length} 个`);

    // 7. 构建增强版 systemPrompt（含 citation 规则 + 记忆）
    const lowConfHint = searchMeta.lowConfidence
      ? citationService.getLowConfidencePromptHint()
      : '';

    const routingHint = citationService.getRoutingLevelPrompt();

    const systemPrompt = `你是一个专业的阅读助手，正在帮助用户深度阅读一本书。
你必须严格基于我提供的书内文本片段回答，禁止编造或推测。${memoryPrompt}

${routingHint}

${citationService.getCitationPromptRule()}

【绝对禁止】
- 禁止编造书中没有的情节、对话、场景或解释
- 禁止用你自己的知识补充书中未提及的内容
- 禁止为了凑格式而分节、编造小标题
- 如果片段不足以回答，明确说"书中未找到明确依据"

【回答要求】
- 直接、简洁地回答，不要写冗长的总结结构
- 只引用实际在回答中用到片段，用 [编号] 格式
- 如果选中文本和问题相关，优先基于选中文本回答
${context ? '\n以下是检索到的相关文本片段：\n' + context : ''}
${lowConfHint}`;

    // 等待语义上下文生成
    const semanticCtx = await semanticCtxPromise;

    // 8. 调用 AI 服务
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(semanticCtx ? [{ role: 'system', content: `【当前阅读场景】${semanticCtx}` }] : []),
      ...(selectedText ? [{ role: 'user', content: `用户选中的段落："${selectedText}"` }] : []),
      { role: 'user', content: `用户问题：${question}` }
    ];

    const data = await aiService.chat(messages, { provider, temperature: 0.7 });
    const answer = data.choices[0]?.message?.content || '抱歉，无法生成回复';

    // 9. 验证回答中的引用
    const { validCitations } = citationService.parseAndValidateCitations(answer, citations);

    // 10. 保存对话历史
    const chatId = uuidv4();
    db.run(
      `INSERT INTO chat_history (id, book_id, selected_text, question, answer, model) VALUES (?, ?, ?, ?, ?, ?)`,
      [chatId, bookId, selectedText || null, question, answer, data.model],
      (err) => { if (err) console.error('保存对话历史失败:', err); }
    );

    console.log(`✅ L2 AI回复生成完成，citations引用: ${validCitations.length}/${citations.length}`);

    res.json({
      answer,
      citations: validCitations,
      sources: enrichedChunks,
      chatId,
      ragEnabled: true,
      lowConfidence: searchMeta.lowConfidence || false,
      semanticContext: semanticCtx,
      routing: { level: 2, reasoning: '书内RAG', citationUsed: validCitations.length }
    });
  } catch (error) {
    console.error('Book context chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 判断文本是否像非正文内容（版权页、目录页等）
 */
function looksLikeNonContent(text) {
  const t = text.trim();
  if (t.length < 30) return true;
  const patterns = [
    /^版权所有/i, /^All rights reserved/i, /^ISBN[\s:]/i,
    /^目录\s*$/i, /^Contents\s*$/i, /^Table of Contents/i,
    /^出版说明/i, /^编?辑?推荐/i, /^作者简介/i, /^关于作者/i,
    /^献词/i, /^Dedication/i, /^Acknowledgements/i,
    /^\d{4}年.*出版/i, /^定价[：:]/i, /^出版社[：:]/i
  ];
  return patterns.some(p => p.test(t));
}

/**
 * 检测章节的 sourceType
 * @param {string} chapterTitle - 章节标题
 * @param {string} chapterContent - 章节内容（前200字符）
 * @returns {string} body / preface / commentary / note / review / translator_note / guide / unknown
 */
function detectSourceType(chapterTitle, chapterContent) {
  const title = (chapterTitle || '').toLowerCase().trim();
  const contentPrefix = (chapterContent || '').toLowerCase().slice(0, 200);

  const rules = [
    { type: 'preface', patterns: [
      /^前言/, /^序/, /^引言/, /^foreword/i, /^preface/i, /^introduction/i,
      /^写在前面/, /^prelude/i, /^prologue/i
    ]},
    { type: 'commentary', patterns: [
      /^注释/, /^注疏/, /^笺注/, /^评注/, /^注$/, /^commentary/i,
      /^注解/i, /^说明/i
    ]},
    { type: 'review', patterns: [
      /^导读/, /^书评/, /^推荐序/, /^点评/, /^评介/, /^review/i,
      /^解读/, /^赏析/, /^鉴赏/, /^评论/
    ]},
    { type: 'translator_note', patterns: [
      /^译者/, /^翻译/, /^translator/i, /^译后记/, /^译序/,
      /^译注/, /^翻译说明/
    ]},
    { type: 'guide', patterns: [
      /^阅读指南/, /^使用说明/, /^how to read/i, /^guide/i,
      /^凡例/, /^体例说明/
    ]},
    { type: 'note', patterns: [
      /^附录/, /^参考/, /^参考文献/, /^索引/, /^后记/, /^跋/,
      /^致谢/, /^acknowledgement/i, /^copyright/i, /^版权/,
      /^后记/, /^epilogue/i, /^afterword/i
    ]}
  ];

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(title) || pattern.test(contentPrefix)) {
        return rule.type;
      }
    }
  }

  return 'body';
}

/**
 * 智能组装上下文（控制token数量，含前后文窗口，给片段编号）
 * @param {Array} chunks - 相关文档块
 * @param {number} maxTokens - 最大token数量
 */
function assembleContext(chunks, maxTokens = 2500) {
  if (!chunks || chunks.length === 0) return '';

  const maxChars = maxTokens * 1.5;
  let context = '';
  let currentLength = 0;
  let snippetNum = 1;

  const sortedChunks = chunks.sort((a, b) => {
    if (a.rerankScore && b.rerankScore) return b.rerankScore - a.rerankScore;
    if (a.rrfScore && b.rrfScore) return b.rrfScore - a.rrfScore;
    if (a.score && b.score) return b.score - a.score;
    return 0;
  });

  for (const chunk of sortedChunks) {
    const chunkText = (chunk.content || chunk).trim();
    // 过滤掉明显非正文和过短的片段
    if (looksLikeNonContent(chunkText)) continue;
    if (chunkText.length < 20) continue;

    const chapterInfo = chunk.chapter ? `【${chunk.chapter}】` : '';

    let fullText = `[${snippetNum}]${chapterInfo}\n`;
    if (chunk.prevContent) {
      const prev = chunk.prevContent.trim().slice(-60);
      if (prev) fullText += `…${prev}\n`;
    }
    fullText += `${chunkText}\n`;
    if (chunk.nextContent) {
      const next = chunk.nextContent.trim().slice(0, 60);
      if (next) fullText += `${next}…\n`;
    }
    fullText += '\n';

    if (currentLength + fullText.length > maxChars) break;
    context += fullText;
    currentLength += fullText.length;
    snippetNum++;
  }

  return context.trim();
}

// ==================== 文学深读模式 ====================

/**
 * 定位选中文本在文档chunk中的精确位置（双段精确匹配 + N-gram模糊 fallback）
 * 优化点：
 * 1. 精确匹配：取首段+尾段双段匹配，解决长文本跨chunk边界问题
 * 2. 模糊匹配：改用6字符N-gram + 保留标点上下文 + 提高命中要求
 * 3. 诊断日志：打印匹配失败原因帮助定位chunk边界问题
 */
function locateSelectedChunk(db, bookId, selectedText, callback) {
  const trimmed = selectedText.trim();
  if (!trimmed || trimmed.length < 5) {
    callback(null, null);
    return;
  }

  // ========== 优化一：双段精确匹配 ==========
  // 取首80 + 尾80字符，确保长文本跨chunk边界时也能命中
  const segLen = Math.min(80, Math.floor(trimmed.length / 2));
  const frontSeg = trimmed.slice(0, segLen);
  const backSeg = trimmed.slice(-segLen);
  const midStart = Math.floor(trimmed.length / 2) - Math.floor(segLen / 2);
  const midSeg = trimmed.slice(midStart, midStart + segLen);

  // 动态构造SQL：各段独立 LIKE，统计命中段数
  const segments = [frontSeg, backSeg, midSeg].filter(s => s.length >= 5);
  const segmentConditions = segments.map(() => `content LIKE ?`).join(' AND ');
  const segmentParams = segments.map(s => `%${s}%`);

  db.all(
    `SELECT id, book_id, chapter, chapter_index, href, paragraph_index, content,
            chunk_index, prev_chunk_id, next_chunk_id, source_type,
            LENGTH(content) as content_len
     FROM document_chunks
     WHERE book_id = ? AND (${segmentConditions})
     ORDER BY chunk_index LIMIT 10`,
    [bookId, ...segmentParams],
    (err, multiMatches) => {
      if (err) { callback(err); return; }

      if (multiMatches && multiMatches.length > 0) {
        // 计算每个chunk被多少个段命中
        const scored = multiMatches.map(chunk => {
          let hits = 0;
          for (const seg of segments) {
            if (chunk.content.includes(seg)) hits++;
          }
          // 得分 = 命中段数 / 总段数，同时惩罚过长的chunk（避免整章作为chunk时的高分）
          const coverage = hits / segments.length;
          const lenPenalty = Math.min(1.0, 500 / Math.max(chunk.content_len, 100));
          return { chunk, score: coverage * lenPenalty, hits };
        });
        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];
        if (best && best.hits >= 2) {
          console.log(`✅ 双段精确匹配成功: chunk ${best.chunk.chunk_index}, 命中 ${best.hits}/${segments.length} 段, 得分 ${best.score.toFixed(3)}`);
          callback(null, best.chunk);
          return;
        }
      }

      // ========== 优化二：N-gram 模糊匹配 ==========
      // 诊断日志
      console.log(`⚠️ 双段精确匹配未命中(${segments.length}段)，降级到N-gram模糊匹配`);

      // 保留标点+空格，生成6字符N-gram（比4-char更有区分度）
      const cleanText = trimmed;
      const ngramSize = 6;
      const ngrams = [];
      for (let i = 0; i < cleanText.length - ngramSize + 1; i++) {
        const gram = cleanText.slice(i, i + ngramSize);
        // 跳过全空格/全标点的片段
        if (!/^[，。？！、；：""''（）【】《》\s]+$/.test(gram)) {
          ngrams.push(gram);
        }
      }
      // 去重，取最多12个（覆盖更多位置，避免只取前5个导致特征丢失）
      const uniqueTerms = [...new Set(ngrams)].slice(0, 12);

      if (uniqueTerms.length < 3) {
        console.log('❌ N-gram词数不足，降级到混合检索');
        callback(null, null);
        return;
      }

      const conditions = uniqueTerms.map(() => `content LIKE ?`).join(' OR ');
      const params = uniqueTerms.map(t => `%${t}%`);

      db.all(
        `SELECT id, book_id, chapter, chapter_index, href, paragraph_index, content,
                chunk_index, prev_chunk_id, next_chunk_id, source_type,
                LENGTH(content) as content_len
         FROM document_chunks
         WHERE book_id = ? AND (${conditions})
         ORDER BY chunk_index LIMIT 10`,
        [bookId, ...params],
        (err2, fuzzyMatches) => {
          if (err2) { callback(err2); return; }
          if (!fuzzyMatches || fuzzyMatches.length === 0) {
            console.log('❌ N-gram匹配无结果，降级到混合检索');
            callback(null, null);
            return;
          }

          // 优化：提高命中要求（至少命中3个N-gram才认为相关）+ 长度惩罚
          const scored = fuzzyMatches.map(chunk => {
            let hits = 0;
            for (const t of uniqueTerms) {
              if (chunk.content.includes(t)) hits++;
            }
            // 得分 = 命中率 * 长度惩罚（短chunk优先，因为更精准）
            const hitRate = hits / uniqueTerms.length;
            const lenBonus = Math.max(0.5, 1.0 - (chunk.content_len - 200) / 1000);
            return { chunk, score: hitRate * lenBonus, hits };
          });
          scored.sort((a, b) => b.score - a.score);

          const best = scored[0];
          if (best && best.hits >= 3) {
            console.log(`✅ N-gram模糊匹配成功: chunk ${best.chunk.chunk_index}, 命中 ${best.hits}/${uniqueTerms.length} 个, 得分 ${best.score.toFixed(3)}`);
            callback(null, best.chunk);
          } else {
            console.log(`❌ N-gram匹配得分过低(${best ? best.hits : 0}/${uniqueTerms.length}词)，降级到混合检索`);
            callback(null, null);
          }
        }
      );
    }
  );
}

/**
 * 获取选中文本的上下文窗口（前后chunk + 章节信息）
 */
function getDeepContext(db, currentChunk, bookId, contextSize = 2, callback) {
  const chunkIndex = currentChunk.chunk_index;
  const prevCount = contextSize;
  const nextCount = contextSize;

  db.all(
    `SELECT id, book_id, chapter, chapter_index, href, paragraph_index, content,
            chunk_index, prev_chunk_id, next_chunk_id, source_type
     FROM document_chunks
     WHERE book_id = ? AND chunk_index >= ? AND chunk_index <= ?
     ORDER BY chunk_index`,
    [bookId, Math.max(0, chunkIndex - prevCount), chunkIndex + nextCount],
    (err, rows) => {
      if (err) { callback(err); return; }

      const currentIdx = rows.findIndex(r => r.id === currentChunk.id);
      const prevChunks = currentIdx > 0 ? rows.slice(0, currentIdx) : [];
      const nextChunks = currentIdx < rows.length - 1 ? rows.slice(currentIdx + 1) : [];

      callback(null, {
        currentChunk,
        prevChunks,
        nextChunks,
        allContextChunks: rows,
        chapterInfo: {
          title: currentChunk.chapter,
          index: currentChunk.chapter_index
        }
      });
    }
  );
}

// ==================== 跨章节检索工具 ====================

/**
 * ragRange: 基于全局段落索引范围获取连续多个 chunk
 * 对齐 deepreader 的 ragRange 工具，支持跨章节连续内容读取
 *
 * @param {object} db - 数据库实例
 * @param {string} bookId - 书籍ID
 * @param {number} startParaIdx - 起始段落全局索引
 * @param {number} endParaIdx - 结束段落全局索引
 * @param {function} callback
 */
function ragRange(db, bookId, startParaIdx, endParaIdx, callback) {
  if (endParaIdx < startParaIdx) {
    [startParaIdx, endParaIdx] = [endParaIdx, startParaIdx];
  }
  const limit = Math.min(endParaIdx - startParaIdx + 1, 50);

  db.all(
    `SELECT id, book_id, chapter, chapter_index, href, paragraph_index, content,
            chunk_index, prev_chunk_id, next_chunk_id, source_type
     FROM document_chunks
     WHERE book_id = ?
       AND paragraph_index >= ?
       AND paragraph_index <= ?
       AND (source_type = 'body' OR source_type IS NULL OR source_type = '')
     ORDER BY chunk_index
     LIMIT ?`,
    [bookId, startParaIdx, endParaIdx, limit],
    (err, rows) => {
      if (err) { callback(err); return; }
      callback(null, {
        chunks: rows,
        meta: {
          type: 'ragRange',
          start: startParaIdx,
          end: endParaIdx,
          count: rows.length,
          crossChapter: rows.length > 1 && new Set(rows.map(r => r.chapter)).size > 1
        }
      });
    }
  );
}

/**
 * ragToc: 基于章节标题获取整章内容
 * 对齐 deepreader 的 ragToc 工具，匹配整章内容用于全局理解
 *
 * @param {object} db - 数据库实例
 * @param {string} bookId - 书籍ID
 * @param {string} chapterTitle - 章节标题（支持模糊匹配）
 * @param {number} maxChunks - 最大返回 chunk 数（防止整章过大）
 * @param {function} callback
 */
function ragToc(db, bookId, chapterTitle, maxChunks = 30, callback) {
  if (!chapterTitle || chapterTitle.trim().length < 1) {
    callback(new Error('章节标题不能为空'), null);
    return;
  }

  const searchTitle = chapterTitle.trim();

  // 先找对应章节
  db.get(
    `SELECT chapter, chapter_index, MIN(chunk_index) as first_chunk
     FROM document_chunks
     WHERE book_id = ? AND chapter = ?
     GROUP BY chapter`,
    [bookId, searchTitle],
    (err, chapterRow) => {
      if (err) { callback(err); return; }

      if (!chapterRow) {
        // 模糊匹配：尝试匹配包含标题关键词的章节
        db.all(
          `SELECT DISTINCT chapter, chapter_index, MIN(chunk_index) as first_chunk
           FROM document_chunks
           WHERE book_id = ? AND chapter LIKE ?
           GROUP BY chapter
           ORDER BY chapter_index
           LIMIT 5`,
          [bookId, `%${searchTitle}%`],
          (err2, fuzzyMatches) => {
            if (err2) { callback(err2); return; }
            if (fuzzyMatches.length === 0) {
              callback(null, { chunks: [], meta: { type: 'ragToc', matched: 'none', searchTitle } });
              return;
            }
            // 取第一个匹配章节
            const best = fuzzyMatches[0];
            fetchChapterChunks(db, bookId, best.chapter, best.chapter_index, maxChunks, callback);
          }
        );
        return;
      }

      // 精确匹配，直接获取整章
      fetchChapterChunks(db, bookId, chapterRow.chapter, chapterRow.chapter_index, maxChunks, callback);
    }
  );
}

/**
 * ragToc 的辅助函数：获取指定章节的所有 body chunks
 */
function fetchChapterChunks(db, bookId, chapter, chapterIndex, maxChunks, callback) {
  db.all(
    `SELECT id, book_id, chapter, chapter_index, href, paragraph_index, content,
            chunk_index, prev_chunk_id, next_chunk_id, source_type
     FROM document_chunks
     WHERE book_id = ? AND chapter = ? AND chapter_index = ?
       AND (source_type = 'body' OR source_type IS NULL OR source_type = '')
     ORDER BY chunk_index
     LIMIT ?`,
    [bookId, chapter, chapterIndex, maxChunks],
    (err, rows) => {
      if (err) { callback(err); return; }
      callback(null, {
        chunks: rows,
        meta: {
          type: 'ragToc',
          matched: 'exact',
          chapter,
          chapterIndex,
          count: rows.length,
          hasMore: rows.length >= maxChunks
        }
      });
    }
  );
}

/**
 * semanticContextBuild: 语义上下文生成
 * 在 L1/L2 路由前调用小模型生成当前阅读场景的语义描述
 * 对齐 deepreader 的 semanticContext 理念
 */
async function semanticContextBuild(aiService, bookId, selectedText, question, currentChunk, options = {}) {
  const context = currentChunk ? {
    chapter: currentChunk.chapter,
    chunkIndex: currentChunk.chunk_index,
    contentPreview: (currentChunk.content || '').slice(0, 200)
  } : null;

  const prompt = `你是一个阅读助手的语义上下文生成器。请根据以下信息，生成一段简洁的阅读场景描述。

请生成一段50字以内的中文描述，说明：
1. 用户当前在读哪本书（如果知道的话）
2. 用户正在阅读哪个章节/位置
3. 用户的问题聚焦在什么方面

信息：
- 书籍ID: ${bookId}
${context ? `- 当前章节: ${context.chapter}\n- 章节位置: 第${context.chunkIndex}个片段\n- 内容预览: ${context.contentPreview}` : '（无当前章节信息）'}
- 用户选中文本: ${selectedText || '（无）'}
- 用户问题: ${question}

请只输出描述文本，不要输出其他内容，控制在50字以内。`;

  try {
    const result = await aiService.chat(
      [{ role: 'system', content: prompt }],
      { temperature: 0.3, maxTokens: 100, provider: options.provider || 'zhipu' }
    );
    const semanticCtx = (result.choices?.[0]?.message?.content || '').trim();
    return semanticCtx.length > 0 ? semanticCtx : null;
  } catch (error) {
    console.warn('语义上下文生成失败:', error.message);
    return null;
  }
}

/**
 * 深度阅读检索：精确定位 → 获取前后文 → 可选补充主题检索
 */
function deepReadingSearch(db, bookId, selectedText, question, options = {}, callback) {
  const contextSize = options.contextSize || 2;
  const enableSupplement = options.enableSupplement !== false;

  locateSelectedChunk(db, bookId, selectedText, (err, currentChunk) => {
    if (err) { callback(err); return; }

    if (!currentChunk) {
      // 降级到 hybrid search
      console.log('⚠️ 无法精确定位选中文本，降级到混合检索');
      hybridSearch(db, bookId, `${selectedText.slice(0, 100)} ${question}`, selectedText, 8, callback);
      return;
    }

    console.log(`🎯 精确定位到 chunk: ${currentChunk.chunk_index} (${currentChunk.chapter})`);

    getDeepContext(db, currentChunk, bookId, contextSize, (err2, context) => {
      if (err2) { callback(err2); return; }

      // 收集所有上下文chunks
      let allChunks = [...context.prevChunks, context.currentChunk, ...context.nextChunks];

      // 过滤：只保留 body 类型
      const bodyChunks = allChunks.filter(c => c.source_type === 'body' || !c.source_type);

      // 如果需要主题补充检索
      if (enableSupplement && question) {
        hybridSearch(db, bookId, `${selectedText.slice(0, 100)} ${question}`, selectedText, 4, (err3, supplementResults) => {
          if (err3) {
            callback(null, { contextChunks: bodyChunks, deepContext: context, supplementChunks: [] });
            return;
          }

          // 过滤掉已存在的chunk，只补充不在上下文中的
          const existingIds = new Set(allChunks.map(c => c.id));
          const newChunks = (supplementResults || []).filter(c => !existingIds.has(c.id));

          callback(null, {
            contextChunks: bodyChunks,
            deepContext: context,
            supplementChunks: newChunks
          });
        });
      } else {
        callback(null, {
          contextChunks: bodyChunks,
          deepContext: context,
          supplementChunks: []
        });
      }
    });
  });
}

/**
 * 检测用户问题是否应使用 deep_reading_mode
 */
function shouldUseDeepReading(selectedText, question) {
  if (!selectedText || selectedText.trim().length < 5) return false;

  const deepKeywords = [
    '上下文', '表达了', '含义', '艺术效果', '为什么这么写',
    '怎么理解', '什么意思', '暗示', '隐喻', '象征', '伏笔', '铺垫',
    '前后', '关系', '情绪', '心理', '意图', '手法', '作用', '效果',
    '背景', '为什么', '说明什么', '体现', '反映', '表达', '表现',
    '解读', '赏析', '品味', '体会', '感触', '感', '想', 'deep',
    'meaning', 'implication', 'symbolism', 'context', 'significance'
  ];

  const q = question.toLowerCase();
  return deepKeywords.some(kw => q.includes(kw));
}

/**
 * 轻量证据筛选（判断检索片段是否足以回答）
 */
async function evidenceFilter(aiServiceInstance, question, contextChunks, supplementChunks) {
  const formattedChunks = [...contextChunks, ...supplementChunks].map((c, i) => {
    return `[${i + 1}] ${c.chapter ? `【${c.chapter}】` : ''}\n${c.content.slice(0, 300)}`;
  }).join('\n\n---\n\n');

  const prompt = `你是一个阅读助手的证据评估模块。请判断以下检索片段是否足以回答用户的问题。

用户问题：${question}

检索到的文本片段：
${formattedChunks}

请输出以下JSON格式（只输出JSON，不要有其他文字）：
{
  "answerable": true/false,
  "relevantChunkIds": ["最相关的片段编号，如1、2等"],
  "missingContext": "如果证据不足，说明缺什么信息；如果足够，写null",
  "reason": "一句话说明为什么这些片段相关或不相关"
}`;

  try {
    const result = await aiServiceInstance.chat(
      [{ role: 'system', content: prompt }],
      { temperature: 0, maxTokens: 300 }
    );
    const text = result.choices?.[0]?.message?.content || '';
    // 提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { answerable: false, relevantChunkIds: [], missingContext: '证据评估失败，无法解析输出', reason: '评估模块返回格式异常' };
  } catch (error) {
    console.warn('证据筛选调用失败:', error.message);
    return { answerable: true, relevantChunkIds: [], missingContext: null, reason: '无法执行证据筛选，默认通过' };
  }
}

// ==================== RAG 向量存储管理 ====================

/**
 * POST /api/rag/index
 * 索引书籍内容（段落优先分块，支持hash检查避免重复索引）
 */
app.post('/api/rag/index', async (req, res) => {
  const { bookId, chapters, force = false } = req.body;

  if (!bookId || !chapters || !Array.isArray(chapters)) {
    return res.status(400).json({ error: '缺少 bookId 或 chapters 参数' });
  }

  try {
    // 计算内容hash
    const contentHash = computeContentHash(chapters);
    const embeddingModel = embeddingService.DEFAULT_DIMENSIONS || 'default';
    const chunkStrategy = 'paragraph_priority';
    const chunkSize = 800;
    const chunkOverlap = 150;

    // 检查是否需要重建索引
    if (!force) {
      const existing = await new Promise((resolve) => {
        db.get(
          `SELECT content_hash, embedding_model, chunk_strategy, chunk_size, chunk_overlap FROM index_metadata WHERE book_id = ?`,
          [bookId],
          (err, row) => resolve(row || null)
        );
      });

      if (existing) {
        const sameHash = existing.content_hash === contentHash;
        const sameModel = existing.embedding_model === String(embeddingModel);
        const sameStrategy = existing.chunk_strategy === chunkStrategy;
        const sameSize = existing.chunk_size === chunkSize;
        const sameOverlap = existing.chunk_overlap === chunkOverlap;

        if (sameHash && sameModel && sameStrategy && sameSize && sameOverlap) {
          console.log(`⏭️ 书籍 ${bookId} 索引未变更，跳过重建`);
          return res.json({ success: true, bookId, skipped: true, reason: '索引已存在且未变更' });
        }
      }
    }

    console.log(`📚 开始索引书籍: ${bookId}`);

    // 删除旧的索引
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM document_chunks WHERE book_id = ?`, [bookId], function(err) {
        if (err) reject(err); else resolve();
      });
    });
    invalidateVectorCache(bookId);
    bm25Cache.delete(bookId);

    // 使用改进的分块策略
    const allChunks = [];
    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      const { title, content, href } = chapter;
      if (!content) continue;

      const meta = { title, href: href || '', chapterIndex: ci };
      const sourceType = detectSourceType(title, content);
      const chunks = chunkTextByParagraphs(content, meta, chunkSize, chunkOverlap);
      chunks.forEach((chunk, i) => {
        allChunks.push({
          id: uuidv4(),
          bookId,
          title,
          content: chunk.content,
          chapterIndex: chunk.chapterIndex,
          href: chunk.href,
          paragraphIndex: chunk.paragraphIndex,
          index: allChunks.length,
          sourceType
        });
      });
    }

    // 建立 prev/next 关联
    for (let i = 0; i < allChunks.length; i++) {
      if (i > 0) allChunks[i].prevChunkId = allChunks[i - 1].id;
      if (i < allChunks.length - 1) allChunks[i].nextChunkId = allChunks[i + 1].id;
    }

    console.log(`📊 共 ${allChunks.length} 个文本块，开始生成向量...`);

    // 批量生成embedding（分批，避免单次请求过大）
    const BATCH_SIZE = 32;
    const embeddings = [];
    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE);
      const batchEmb = await embeddingService.getEmbeddings(
        batch.map(c => c.content),
        embeddingService.DEFAULT_DIMENSIONS
      );
      embeddings.push(...batchEmb);
      console.log(`   向量进度: ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}`);
    }

    console.log(`✅ 向量生成完成，开始存储到数据库...`);

    // 插入数据库
    for (let i = 0; i < allChunks.length; i++) {
      const chunk = allChunks[i];
      const embedding = embeddings[i];
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO document_chunks
           (id, book_id, chapter, chapter_index, href, paragraph_index, content, embedding, chunk_index, prev_chunk_id, next_chunk_id, source_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [chunk.id, chunk.bookId, chunk.title, chunk.chapterIndex, chunk.href,
           chunk.paragraphIndex, chunk.content, JSON.stringify(embedding), chunk.index,
           chunk.prevChunkId || null, chunk.nextChunkId || null, chunk.sourceType || 'body'],
          function(err) {
            if (err) reject(err); else resolve();
          }
        );
      });
    }

    // 更新元数据
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO index_metadata (book_id, content_hash, embedding_model, chunk_strategy, chunk_size, chunk_overlap, total_chunks)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           embedding_model = excluded.embedding_model,
           chunk_strategy = excluded.chunk_strategy,
           chunk_size = excluded.chunk_size,
           chunk_overlap = excluded.chunk_overlap,
           total_chunks = excluded.total_chunks,
           indexed_at = CURRENT_TIMESTAMP`,
        [bookId, contentHash, String(embeddingModel), chunkStrategy, chunkSize, chunkOverlap, allChunks.length],
        function(err) {
          if (err) reject(err); else resolve();
        }
      );
    });

    console.log(`✅ 数据库存储完成，开始构建BM25索引...`);

    initBM25Index(db, bookId, (err) => {
      if (err) console.error('BM25索引构建失败:', err);
      else console.log(`✅ BM25索引构建完成`);
      console.log(`✅ 书籍 ${bookId} 索引完成，共 ${allChunks.length} 个文档块`);
      res.json({ success: true, bookId, totalChunks: allChunks.length });
    });

  } catch (error) {
    console.error('Index error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/rag/status/:bookId
 * 查询书籍索引状态
 */
app.get('/api/rag/status/:bookId', (req, res) => {
  const { bookId } = req.params;
  db.get(
    `SELECT book_id, content_hash, embedding_model, chunk_strategy, total_chunks, indexed_at
     FROM index_metadata WHERE book_id = ?`,
    [bookId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        bookId,
        indexed: !!row,
        metadata: row || null
      });
    }
  );
});

/**
 * POST /api/rag/search
 * 在书籍中搜索相关内容（混合检索 + Rerank + 低置信度标识）
 */
app.post('/api/rag/search', async (req, res) => {
  const { bookId, query, selectedText, limit = 5 } = req.body;

  if (!bookId || !query) {
    return res.status(400).json({ error: '缺少 bookId 或 query 参数' });
  }

  try {
    hybridSearch(db, bookId, query, selectedText || '', limit, (err, results, meta) => {
      if (err) {
        console.error('混合检索失败:', err);
        const keywords = query.split(/\s+/).filter(k => k.length > 1);
        if (!keywords.length && query.trim()) keywords.push(query.trim().slice(0, 20));
        const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
        const params = keywords.map(k => `%${k}%`);

        db.all(
          `SELECT id, chapter, chapter_index, href, paragraph_index, content, chunk_index
           FROM document_chunks
           WHERE book_id = ? AND (${conditions})
           ORDER BY chunk_index
           LIMIT ?`,
          [bookId, ...params, limit],
          (err2, rows) => {
            if (err2) {
              res.status(500).json({ error: err2.message });
            } else {
              res.json({
                bookId, query,
                results: rows || [],
                total: (rows || []).length,
                fallback: true
              });
            }
          }
        );
        return;
      }

      res.json({
        bookId, query,
        results,
        total: results.length,
        searchType: 'hybrid+rerank',
        lowConfidence: meta?.lowConfidence || false,
        meta: {
          topVectorScore: meta?.topVectorScore,
          topRRFScore: meta?.topRRFScore,
          bm25HitCount: meta?.bm25HitCount
        }
      });
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/rag/index/:bookId
 * 删除书籍索引（同时清理缓存）
 */
app.delete('/api/rag/index/:bookId', async (req, res) => {
  const { bookId } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM document_chunks WHERE book_id = ?`, [bookId], function(err) {
        if (err) reject(err); else resolve(this.changes);
      });
    });
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM index_metadata WHERE book_id = ?`, [bookId], function(err) {
        if (err) reject(err); else resolve();
      });
    });

    invalidateVectorCache(bookId);
    bm25Cache.delete(bookId);

    res.json({ success: true, message: `书籍 ${bookId} 的索引已删除` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 文学深读 API ====================

/**
 * POST /api/chat/book-context-deep
 * 文学深读模式：精确定位选中文本 → 获取前后文 → 证据筛选 → 文学解读回答
 */
app.post('/api/chat/book-context-deep', async (req, res) => {
  const { bookId, selectedText, question, contextSize = 2, format = 'deep', provider } = req.body;

  if (!bookId || !selectedText || !question) {
    return res.status(400).json({ error: '缺少 bookId、selectedText 或 question 参数' });
  }

  try {
    console.log(`📚 文学深读请求: "${selectedText.slice(0, 40)}..." + "${question.slice(0, 40)}..."`);

    // 1. 深度阅读检索（精确定位 + 前后文 + 可选主题补充）
    const searchResult = await new Promise((resolve, reject) => {
      deepReadingSearch(db, bookId, selectedText, question, { contextSize, enableSupplement: true }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    if (!searchResult || !searchResult.contextChunks || searchResult.contextChunks.length === 0) {
      // 降级到普通 book-context
      console.log('⚠️ 深读检索无结果，降级到普通模式');
      const reqBody = { bookId, selectedText, question, provider };
      const origRes = await fetch(`http://localhost:${PORT}/api/chat/book-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
      const origData = await origRes.json();
      return res.json({ ...origData, deepModeDegraded: true });
    }

    const { contextChunks, supplementChunks, deepContext } = searchResult;

    // 2. 检查 AI 是否可用
    const available = aiService.getAvailableProvider();
    if (!available) {
      const mockAnswer = `Mock deep-reading answer for: ${question}`;
      saveChatTurn(bookId, selectedText || null, question, mockAnswer, 'mock-deep');
      return res.json({
        answer: `[模拟深读回复] 关于 "${selectedText.slice(0, 40)}..." 的文学解读\n\n找到 ${contextChunks.length} 个上下文片段。请在 .env 中配置 AI API Key。`,
        sources: contextChunks,
        mock: true,
        deepMode: true
      });
    }

    // 3. 证据筛选
    const evidence = await evidenceFilter(aiService, question, contextChunks, supplementChunks);

    if (!evidence.answerable) {
      return res.json({
        answer: `当前检索片段不足以支持可靠解读，建议扩大前后文范围。\n\n原因：${evidence.missingContext || '缺少足够的相关上下文'}`,
        sources: contextChunks,
        deepMode: true,
        evidenceFiltered: true,
        evidence
      });
    }

    // 4. 组装上下文
    const contextLines = [];
    contextChunks.forEach((c, i) => {
      const tag = `[${i + 1}]`;
      const chInfo = c.chapter ? `【${c.chapter}】` : '';
      const isCurrent = c.id === deepContext?.currentChunk?.id ? ' ← 用户选中的句子所在的片段' : '';
      contextLines.push(`${tag}${chInfo}${isCurrent}\n${c.content}`);
    });

    supplementChunks.forEach((c, i) => {
      const tag = `[${contextChunks.length + i + 1}]`;
      const chInfo = c.chapter ? `【${c.chapter}】` : '';
      contextLines.push(`${tag}${chInfo}\n${c.content}`);
    });

    const assembledContext = contextLines.join('\n\n---\n\n');

    // 5. 构建文学深读 Prompt
    const isBrief = format === 'brief';
    const maxLen = isBrief ? '100-150字' : '300-600字';
    const formatInstructions = isBrief
      ? `【格式要求】
- 直接回答，不要写小标题
- 简洁明了，控制在${maxLen}`
      : `【格式要求】
回答请控制在${maxLen}，可以分以下角度（但不要写死板的小标题，要像共读时的自然讲解）：
1. 前后文：这句话前后发生了什么
2. 情绪与关系：人物此刻的心理和情绪状态
3. 更深一层的含义：关键词/意象的作用，与人物关系或全书主题的联系`;

    const systemPrompt = `你是一个专业的文学阅读伙伴，正在和用户一起共读一本书。

用户选中的句子："${selectedText}"
用户的问题：${question}

我已经定位到这句话在原文中的准确位置，并提取了它的前后文段落以及相关的主题片段。以下是完整的上下文：

${assembledContext}

请基于以上上下文进行文学解读，严格遵守以下规则：

【核心原则】
- 先理解这句话在前后文中发生了什么，再解释含义
- 注意人物的心理状态和情绪变化
- 关注关键词语和意象的作用
- 如果涉及推断，使用"可以理解为""这里暗示""似乎暗示""隐约透露出"等表达，不要说成绝对事实
- 永远不要编造原文没有的情节、对话或解释
- 如果确实无法根据上下文解读，要坦诚说明

${formatInstructions}

${citationService.getCitationPromptRule()}`;

    // 6. 调用 AI
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    const data = await aiService.chat(messages, {
      provider,
      temperature: isBrief ? 0.2 : 0.3,
      maxTokens: isBrief ? 600 : 1200
    });

    const answer = data.choices?.[0]?.message?.content || '抱歉，无法生成解读';

    // 7. 保存对话历史
    const chatId = uuidv4();
    db.run(
      `INSERT INTO chat_history (id, book_id, selected_text, question, answer, model) VALUES (?, ?, ?, ?, ?, ?)`,
      [chatId, bookId, selectedText, question, answer, data.model],
      (err) => { if (err) console.error('保存对话历史失败:', err); }
    );

    console.log(`✅ 文学深读回复生成完成 (${format})`);

    // 验证回答中的引用
    const allCitations = citationService.buildCitations([...contextChunks, ...supplementChunks]);
    const { validCitations } = citationService.parseAndValidateCitations(answer, allCitations);

    res.json({
      answer,
      citations: validCitations,
      sources: [...contextChunks, ...supplementChunks],
      chatId,
      deepMode: true,
      evidence,
      routing: { level: 2, reasoning: '文学深读RAG', citationUsed: validCitations.length }
    });

  } catch (error) {
    console.error('Deep reading error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 数据持久化 API ====================

/**
 * 笔记 CRUD
 */
app.get('/api/notes', (req, res) => {
  const { bookId } = req.query;
  let sql = 'SELECT * FROM notes';
  const params = [];
  if (bookId) {
    sql += ' WHERE book_id = ?';
    params.push(bookId);
  }
  sql += ' ORDER BY created_at DESC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map(mapNoteRow));
  });
});

app.post('/api/notes', (req, res) => {
  const { bookId, chapter, cfi, quote, content, body, color, contextBefore, contextAfter, tags } = req.body;
  if (!bookId || !quote) return res.status(400).json({ error: '缺少 bookId 或 quote' });
  const id = req.body.id || uuidv4();
  const noteContent = content ?? body ?? '';
  db.run(
    `INSERT INTO notes (id, book_id, chapter, cfi, quote, content, color, context_before, context_after, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       chapter = excluded.chapter,
       cfi = excluded.cfi,
       quote = excluded.quote,
       content = excluded.content,
       color = excluded.color,
       context_before = excluded.context_before,
       context_after = excluded.context_after,
       tags = excluded.tags,
       updated_at = CURRENT_TIMESTAMP`,
    [id, bookId, chapter, cfi, quote, noteContent, color || 'yellow', contextBefore || '', contextAfter || '', JSON.stringify(tags || [])],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, success: true });
    }
  );
});

app.put('/api/notes/:id', (req, res) => {
  const { chapter, cfi, quote, content, body, color, contextBefore, contextAfter, tags } = req.body;
  db.run(
    `UPDATE notes SET
       chapter = COALESCE(?, chapter),
       cfi = COALESCE(?, cfi),
       quote = COALESCE(?, quote),
       content = COALESCE(?, content),
       color = COALESCE(?, color),
       context_before = COALESCE(?, context_before),
       context_after = COALESCE(?, context_after),
       tags = COALESCE(?, tags),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [chapter, cfi, quote, content ?? body, color, contextBefore, contextAfter, tags ? JSON.stringify(tags) : null, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, updated: this.changes });
    }
  );
});

app.delete('/api/notes/:id', (req, res) => {
  db.run('DELETE FROM notes WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

/**
 * 书签 CRUD
 */
app.get('/api/bookmarks', (req, res) => {
  const { bookId } = req.query;
  let sql = 'SELECT * FROM bookmarks';
  const params = [];
  if (bookId) {
    sql += ' WHERE book_id = ?';
    params.push(bookId);
  }
  sql += ' ORDER BY created_at DESC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map(mapBookmarkRow));
  });
});

app.post('/api/bookmarks', (req, res) => {
  const { bookId, chapter, cfi, label, position, note } = req.body;
  if (!bookId || !cfi) return res.status(400).json({ error: '缺少 bookId 或 cfi' });
  const id = req.body.id || uuidv4();
  db.run(
    `INSERT INTO bookmarks (id, book_id, chapter, cfi, label, position, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       chapter = excluded.chapter,
       cfi = excluded.cfi,
       label = excluded.label,
       position = excluded.position,
       note = excluded.note`,
    [id, bookId, chapter, cfi, label || chapter, position || 0, note || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, success: true });
    }
  );
});

app.delete('/api/bookmarks/:id', (req, res) => {
  db.run('DELETE FROM bookmarks WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.get('/api/highlights', (req, res) => {
  const { bookId } = req.query;
  let sql = 'SELECT * FROM highlights';
  const params = [];
  if (bookId) {
    sql += ' WHERE book_id = ?';
    params.push(bookId);
  }
  sql += ' ORDER BY created_at DESC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map(mapHighlightRow));
  });
});

app.post('/api/highlights', (req, res) => {
  const { bookId, chapter, cfi, text, color } = req.body;
  if (!bookId || !cfi || !text) return res.status(400).json({ error: '缺少 bookId、cfi 或 text' });
  const id = req.body.id || uuidv4();
  db.run(
    `INSERT INTO highlights (id, book_id, chapter, cfi, text, color)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       chapter = excluded.chapter,
       cfi = excluded.cfi,
       text = excluded.text,
       color = excluded.color`,
    [id, bookId, chapter, cfi, text, color || '#fbbf24'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, success: true });
    }
  );
});

app.delete('/api/highlights/:id', (req, res) => {
  db.run('DELETE FROM highlights WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

/**
 * 阅读进度
 */
app.get('/api/chat/history/:bookId', (req, res) => {
  db.all(
    `SELECT id, selected_text, question, answer, model, created_at
     FROM chat_history
     WHERE book_id = ?
     ORDER BY created_at ASC
     LIMIT 100`,
    [req.params.bookId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const messages = [];
      for (const row of rows || []) {
        messages.push({
          role: 'user',
          content: row.selected_text
            ? `${row.question}\n\nSelected text: ${row.selected_text}`
            : row.question,
          createdAt: row.created_at
        });
        messages.push({
          role: 'assistant',
          content: row.answer,
          model: row.model,
          createdAt: row.created_at
        });
      }
      res.json({ bookId: req.params.bookId, messages });
    }
  );
});

app.delete('/api/chat/history/:bookId', (req, res) => {
  db.run('DELETE FROM chat_history WHERE book_id = ?', [req.params.bookId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.get('/api/progress/:bookId', (req, res) => {
  db.get('SELECT * FROM reading_progress WHERE book_id = ?', [req.params.bookId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row ? {
      bookId: row.book_id,
      chapter: row.chapter,
      cfi: row.cfi,
      position: row.position || 0,
      percentage: row.percentage || 0,
      totalChars: row.total_chars || 0,
      updatedAt: row.updated_at
    } : { bookId: req.params.bookId, position: 0, percentage: 0 });
  });
});

app.post('/api/progress', (req, res) => {
  const { bookId, chapter, cfi, position, percentage, totalChars } = req.body;
  if (!bookId) return res.status(400).json({ error: '缺少 bookId' });
  
  db.run(
    `INSERT INTO reading_progress (book_id, chapter, cfi, position, percentage, total_chars)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET 
     chapter = excluded.chapter, 
     cfi = excluded.cfi,
     position = excluded.position, 
     percentage = excluded.percentage,
     total_chars = excluded.total_chars,
     updated_at = CURRENT_TIMESTAMP`,
    [bookId, chapter, cfi, position || 0, percentage || 0, totalChars || 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run('UPDATE books SET last_opened_at = CURRENT_TIMESTAMP WHERE id = ?', [bookId]);
      res.json({ success: true });
    }
  );
});

app.get('/api/stats/:bookId', (req, res) => {
  const { bookId } = req.params;
  const stats = { bookId, notes: 0, highlights: 0, bookmarks: 0, chats: 0, concepts: 0, progress: null };
  const tasks = [
    cb => db.get('SELECT COUNT(*) AS count FROM notes WHERE book_id = ?', [bookId], (err, row) => { if (!err) stats.notes = row.count; cb(err); }),
    cb => db.get('SELECT COUNT(*) AS count FROM highlights WHERE book_id = ?', [bookId], (err, row) => { if (!err) stats.highlights = row.count; cb(err); }),
    cb => db.get('SELECT COUNT(*) AS count FROM bookmarks WHERE book_id = ?', [bookId], (err, row) => { if (!err) stats.bookmarks = row.count; cb(err); }),
    cb => db.get('SELECT COUNT(*) AS count FROM chat_history WHERE book_id = ?', [bookId], (err, row) => { if (!err) stats.chats = row.count; cb(err); }),
    cb => db.get('SELECT COUNT(*) AS count FROM concept_memories WHERE book_id = ?', [bookId], (err, row) => { if (!err) stats.concepts = row.count; cb(err); }),
    cb => db.get('SELECT chapter, cfi, position, percentage, updated_at FROM reading_progress WHERE book_id = ?', [bookId], (err, row) => { if (!err) stats.progress = row || null; cb(err); })
  ];
  let done = 0;
  let failed = null;
  tasks.forEach(task => task((err) => {
    if (err && !failed) failed = err;
    if (++done === tasks.length) {
      if (failed) return res.status(500).json({ error: failed.message });
      res.json(stats);
    }
  }));
});

app.post('/api/export/obsidian', (req, res) => {
  const { bookId } = req.body;
  if (!bookId) return res.status(400).json({ error: '缺少 bookId' });

  db.get('SELECT * FROM books WHERE id = ?', [bookId], (bookErr, book) => {
    if (bookErr) return res.status(500).json({ error: bookErr.message });
    if (!book) return res.status(404).json({ error: '书籍不存在' });

    db.all('SELECT * FROM notes WHERE book_id = ? ORDER BY created_at', [bookId], (notesErr, notes) => {
      if (notesErr) return res.status(500).json({ error: notesErr.message });
      db.all('SELECT question, answer, created_at FROM chat_history WHERE book_id = ? ORDER BY created_at', [bookId], (chatErr, chats) => {
        if (chatErr) return res.status(500).json({ error: chatErr.message });
        db.all('SELECT concept, definition, first_mentioned_chapter FROM concept_memories WHERE book_id = ? ORDER BY updated_at DESC LIMIT 30', [bookId], (conceptErr, concepts) => {
          if (conceptErr) return res.status(500).json({ error: conceptErr.message });

          const lines = [];
          lines.push(`# ${book.title}`);
          if (book.author) lines.push(`\n> 作者：${book.author}`);
          lines.push(`\n> 导出时间：${new Date().toLocaleString('zh-CN')}`);
          lines.push('\n## 阅读笔记');
          if (!notes.length) lines.push('\n暂无笔记。');
          for (const note of notes) {
            lines.push(`\n### ${note.chapter || '未命名章节'}`);
            if (note.context_before) lines.push(`\n_${note.context_before}_`);
            if (note.quote) lines.push(`\n> ${note.quote.replace(/\n/g, '\n> ')}`);
            if (note.context_after) lines.push(`\n_${note.context_after}_`);
            if (note.content) lines.push(`\n${note.content}`);
            const tags = safeJsonParse(note.tags, []);
            if (tags?.length) lines.push(`\n标签：${tags.map(t => `#${t}`).join(' ')}`);
          }
          lines.push('\n## AI 对话摘录');
          if (!chats.length) lines.push('\n暂无 AI 对话。');
          for (const chat of chats.slice(-20)) {
            lines.push(`\n### ${chat.created_at}`);
            lines.push(`\n**Q:** ${chat.question}`);
            lines.push(`\n**A:** ${chat.answer}`);
          }
          lines.push('\n## 概念记忆');
          if (!concepts.length) lines.push('\n暂无概念记忆。');
          for (const concept of concepts) {
            lines.push(`\n- **${concept.concept}**：${concept.definition}${concept.first_mentioned_chapter ? `（${concept.first_mentioned_chapter}）` : ''}`);
          }

          const markdown = lines.join('\n');
          const settings = readSettings();
          let writtenPath = null;
          if (settings.obsidianVaultPath) {
            const fileName = `${sanitizeFileName(book.title)}.md`;
            writtenPath = path.join(settings.obsidianVaultPath, fileName);
            fs.mkdirSync(path.dirname(writtenPath), { recursive: true });
            fs.writeFileSync(writtenPath, markdown, 'utf8');
          }
          res.json({ success: true, markdown, writtenPath });
        });
      });
    });
  });
});

// ==================== 评测集 API ====================

/**
 * GET /api/eval/:bookId
 * 获取某书的评测集
 */
app.get('/api/eval/:bookId', (req, res) => {
  const { bookId } = req.params;
  db.all(
    `SELECT id, book_id, question, expected_answer, question_type, expected_chunks, created_at
     FROM evaluation_set WHERE book_id = ? ORDER BY created_at`,
    [bookId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ bookId, questions: rows || [] });
    }
  );
});

/**
 * POST /api/eval
 * 添加/更新评测问题
 */
app.post('/api/eval', (req, res) => {
  const { bookId, question, expectedAnswer, questionType, expectedChunks, id } = req.body;
  if (!bookId || !question) {
    return res.status(400).json({ error: '缺少 bookId 或 question' });
  }
  const evalId = id || uuidv4();
  db.run(
    `INSERT INTO evaluation_set (id, book_id, question, expected_answer, question_type, expected_chunks)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       question = excluded.question,
       expected_answer = excluded.expected_answer,
       question_type = excluded.question_type,
       expected_chunks = excluded.expected_chunks`,
    [evalId, bookId, question, expectedAnswer || null, questionType || 'fact', JSON.stringify(expectedChunks || [])],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: evalId, success: true });
    }
  );
});

/**
 * POST /api/eval/run/:bookId
 * 运行评测：对评测集中的每个问题执行检索，记录命中结果
 */
app.post('/api/eval/run/:bookId', async (req, res) => {
  const { bookId } = req.params;
  const { limit = 5 } = req.body;

  try {
    const questions = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, question, expected_answer, question_type, expected_chunks FROM evaluation_set WHERE book_id = ?`,
        [bookId],
        (err, rows) => {
          if (err) reject(err); else resolve(rows || []);
        }
      );
    });

    if (questions.length === 0) {
      return res.json({ bookId, results: [], summary: { total: 0, hit: 0 } });
    }

    const results = [];
    for (const q of questions) {
      const retrieved = await new Promise((resolve) => {
        hybridSearch(db, bookId, q.question, '', limit, (err, res) => {
          resolve(err ? [] : (res || []));
        });
      });

      const expected = JSON.parse(q.expected_chunks || '[]');
      const retrievedIds = retrieved.map(r => r.id);
      const hitChunks = expected.filter(id => retrievedIds.includes(id));
      const hit = hitChunks.length > 0 || retrieved.length > 0;

      results.push({
        questionId: q.id,
        question: q.question,
        questionType: q.question_type,
        retrievedCount: retrieved.length,
        hitChunkCount: hitChunks.length,
        expectedChunkCount: expected.length,
        hit,
        retrievedIds,
        topChunk: retrieved[0] || null
      });
    }

    const summary = {
      total: results.length,
      hit: results.filter(r => r.hit).length,
      hitRate: (results.filter(r => r.hit).length / results.length * 100).toFixed(1) + '%'
    };

    res.json({ bookId, results, summary });

  } catch (error) {
    console.error('评测运行失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/eval/:id
 * 删除评测问题
 */
app.delete('/api/eval/:id', (req, res) => {
  db.run('DELETE FROM evaluation_set WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// ==================== 启动服务器 ====================

app.listen(PORT, () => {
  // 获取 AI 配置信息
  const availableProvider = aiService.getAvailableProvider();
  const configuredProviders = aiService.getConfiguredProviders();

  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║     📚 ReadFlow 后端服务已启动                         ║
║                                                        ║
║     地址: http://localhost:${PORT}                       ║
║     API文档: http://localhost:${PORT}/api/health         ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
  console.log('环境检查:');
  
  // 调试：显示环境变量读取情况
  console.log('  - 环境变量检查:');
  console.log(`      ZHIPU_API_KEY: ${process.env.ZHIPU_API_KEY ? '✅ 已设置 (' + process.env.ZHIPU_API_KEY.slice(0, 10) + '...)' : '❌ 未设置'}`);
  console.log(`      ZHIPU_MODEL: ${process.env.ZHIPU_MODEL || '未设置'}`);
  console.log(`      DEFAULT_AI_PROVIDER: ${process.env.DEFAULT_AI_PROVIDER || '未设置'}`);
  
  if (configuredProviders.length > 0) {
    console.log(`  - AI 提供商: ✅ 已配置 ${configuredProviders.length} 个`);
    configuredProviders.forEach(p => {
      const isDefault = availableProvider && availableProvider.provider === p.key;
      console.log(`      ${isDefault ? '▶' : '  '} ${p.name}: ${p.model}`);
    });
  } else {
    console.log(`  - AI 提供商: ⚠️ 未配置（使用模拟回复）`);
  }
  
  console.log(`  - 数据库: ✅ ${DB_PATH}`);
  console.log('');
  console.log('可用端点:');
  console.log('  POST /api/chat            - AI 对话');
  console.log('  POST /api/chat/book-context - 基于书籍内容的AI对话');
  console.log('  POST /api/rag/index       - 索引书籍内容');
  console.log('  POST /api/rag/search      - 搜索书籍内容');
  console.log('  GET  /api/notes           - 获取笔记');
  console.log('  POST /api/notes           - 创建笔记');
  console.log('');
  console.log('配置说明:');
  console.log('  1. 复制 .env.example 为 .env');
  console.log('  2. 在 .env 中填写你的 AI API Key');
  console.log('  3. 支持 OpenAI、通义千问、文心一言、智谱、DeepSeek、Claude');
  console.log('');
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n正在关闭数据库连接...');
  db.close(() => {
    console.log('数据库已关闭，服务停止');
    process.exit(0);
  });
});
