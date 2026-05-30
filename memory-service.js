/**
 * 记忆服务模块 (Memory Service)
 *
 * 实现三层记忆体系，对齐 deepreader 的设计：
 * - user_profile: 用户偏好、沟通风格、阅读习惯
 * - book_gist: 书籍核心论点、章节要点、阅读进度
 * - concept: 重要概念的定义、书中出现的解释
 *
 * 每 5 轮对话自动触发记忆提取，持久化到 SQLite
 */

const DB_SCHEMA = `
  -- 用户画像记忆表
  CREATE TABLE IF NOT EXISTS user_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    profile_key TEXT NOT NULL,
    profile_value TEXT NOT NULL,
    importance INTEGER DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, profile_key)
  );

  -- 书籍要点记忆表
  CREATE TABLE IF NOT EXISTS book_gists (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    gist_type TEXT NOT NULL,
    content TEXT NOT NULL,
    chapter TEXT,
    chapter_index INTEGER,
    importance INTEGER DEFAULT 3,
    conversation_count INTEGER DEFAULT 0,
    last_mentioned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 概念定义记忆表
  CREATE TABLE IF NOT EXISTS concept_memories (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    concept TEXT NOT NULL,
    definition TEXT NOT NULL,
    source_chunk_id TEXT,
    source_content TEXT,
    first_mentioned_chapter TEXT,
    mention_count INTEGER DEFAULT 1,
    last_mentioned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 对话会话表（用于追踪对话轮次）
  CREATE TABLE IF NOT EXISTS conversation_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'default',
    turn_count INTEGER DEFAULT 0,
    last_turn_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

/**
 * 初始化记忆表（自动建表）
 */
function initMemoryTables(db) {
  const statements = DB_SCHEMA.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    db.run(stmt + ';', err => {
      if (err) console.warn('记忆表初始化警告:', err.message);
    });
  }
}

// ==================== 用户画像 (user_profile) CRUD ====================

/**
 * 获取用户画像
 */
function getUserProfile(db, userId = 'default', callback) {
  db.all(
    `SELECT profile_key, profile_value, importance FROM user_memories
     WHERE user_id = ? ORDER BY importance DESC`,
    [userId],
    (err, rows) => {
      if (err) { callback(err); return; }
      const profile = {};
      for (const row of rows) {
        profile[row.profile_key] = { value: row.profile_value, importance: row.importance };
      }
      callback(null, profile);
    }
  );
}

/**
 * 设置用户画像项
 */
function setUserProfile(db, userId, key, value, importance = 3, callback) {
  db.run(
    `INSERT INTO user_memories (id, user_id, profile_key, profile_value, importance)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, profile_key) DO UPDATE SET
       profile_value = excluded.profile_value,
       importance = excluded.importance,
       updated_at = CURRENT_TIMESTAMP`,
    [require('uuid').v4(), userId, key, value, importance],
    callback
  );
}

/**
 * 批量更新用户画像
 */
function setUserProfileBatch(db, userId, profileObj, callback) {
  const stmt = db.prepare(
    `INSERT INTO user_memories (id, user_id, profile_key, profile_value, importance)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, profile_key) DO UPDATE SET
       profile_value = excluded.profile_value,
       importance = excluded.importance,
       updated_at = CURRENT_TIMESTAMP`
  );
  const entries = Object.entries(profileObj);
  let completed = 0;
  if (entries.length === 0) { callback(null); return; }
  for (const [key, val] of entries) {
    stmt.run(require('uuid').v4(), userId, key, typeof val === 'string' ? val : val.value, val.importance || 3, err => {
      completed++;
      if (completed === entries.length) { stmt.finalize(); callback(err); }
    });
  }
}

// ==================== 书籍要点 (book_gist) CRUD ====================

/**
 * 获取书籍要点
 */
function getBookGists(db, bookId, gistType = null, limit = 10, callback) {
  let sql = `SELECT * FROM book_gists WHERE book_id = ?`;
  const params = [bookId];
  if (gistType) { sql += ` AND gist_type = ?`; params.push(gistType); }
  sql += ` ORDER BY importance DESC, mention_count DESC LIMIT ?`;
  params.push(limit);
  db.all(sql, params, callback);
}

/**
 * 添加/更新书籍要点
 */
function upsertBookGist(db, bookId, gistType, content, chapter = null, chapterIndex = null, importance = 3, callback) {
  // 先查找是否有相同的 gist
  db.get(
    `SELECT id, mention_count FROM book_gists WHERE book_id = ? AND gist_type = ? AND content = ?`,
    [bookId, gistType, content],
    (err, existing) => {
      if (err) { callback(err); return; }
      if (existing) {
        // 更新提及次数
        db.run(
          `UPDATE book_gists SET mention_count = mention_count + 1,
           last_mentioned_at = CURRENT_TIMESTAMP, importance = ?
           WHERE id = ?`,
          [importance, existing.id],
          err2 => callback(err2, existing.id)
        );
      } else {
        const id = require('uuid').v4();
        db.run(
          `INSERT INTO book_gists (id, book_id, gist_type, content, chapter, chapter_index, importance)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, bookId, gistType, content, chapter, chapterIndex, importance],
          err2 => callback(err2, id)
        );
      }
    }
  );
}

/**
 * 删除书籍要点
 */
function deleteBookGist(db, id, callback) {
  db.run(`DELETE FROM book_gists WHERE id = ?`, [id], callback);
}

// ==================== 概念定义 (concept) CRUD ====================

/**
 * 获取书籍相关概念
 */
function getConceptMemories(db, bookId, query = null, limit = 10, callback) {
  let sql = `SELECT * FROM concept_memories WHERE book_id = ?`;
  const params = [bookId];
  if (query) { sql += ` AND (concept LIKE ? OR definition LIKE ?)`; params.push(`%${query}%`, `%${query}%`); }
  sql += ` ORDER BY mention_count DESC LIMIT ?`;
  params.push(limit);
  db.all(sql, params, callback);
}

/**
 * 添加/更新概念记忆
 */
function upsertConceptMemory(db, bookId, concept, definition, sourceChunkId = null, sourceContent = null, chapter = null, callback) {
  db.get(
    `SELECT id, mention_count FROM concept_memories WHERE book_id = ? AND concept = ?`,
    [bookId, concept],
    (err, existing) => {
      if (err) { callback(err); return; }
      if (existing) {
        db.run(
          `UPDATE concept_memories SET mention_count = mention_count + 1,
           definition = COALESCE(?, definition),
           last_mentioned_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [definition || null, existing.id],
          err2 => callback(err2, existing.id)
        );
      } else {
        const id = require('uuid').v4();
        db.run(
          `INSERT INTO concept_memories (id, book_id, concept, definition, source_chunk_id, source_content, first_mentioned_chapter)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, bookId, concept, definition, sourceChunkId, sourceContent, chapter],
          err2 => callback(err2, id)
        );
      }
    }
  );
}

// ==================== 对话会话管理 ====================

/**
 * 获取或创建会话
 */
function getOrCreateSession(db, bookId, userId = 'default', callback) {
  db.get(
    `SELECT * FROM conversation_sessions WHERE book_id = ? AND user_id = ? ORDER BY last_turn_at DESC LIMIT 1`,
    [bookId, userId],
    (err, session) => {
      if (err) { callback(err); return; }
      if (session) {
        callback(null, session);
      } else {
        const id = require('uuid').v4();
        db.run(
          `INSERT INTO conversation_sessions (id, book_id, user_id) VALUES (?, ?, ?)`,
          [id, bookId, userId],
          err2 => {
            if (err2) { callback(err2); return; }
            callback(null, { id, book_id: bookId, user_id: userId, turn_count: 0 });
          }
        );
      }
    }
  );
}

/**
 * 增加对话轮次
 */
function incrementTurnCount(db, sessionId, callback) {
  db.run(
    `UPDATE conversation_sessions SET turn_count = turn_count + 1, last_turn_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [sessionId],
    callback
  );
}

/**
 * 检查是否需要触发记忆提取（每5轮）
 */
function shouldExtractMemory(db, sessionId, threshold = 5, callback) {
  db.get(`SELECT turn_count FROM conversation_sessions WHERE id = ?`, [sessionId], (err, row) => {
    if (err) { callback(err); return; }
    callback(null, row ? (row.turn_count > 0 && row.turn_count % threshold === 0) : false);
  });
}

// ==================== 记忆检索（用于对话注入）====================

/**
 * 获取注入到 prompt 的记忆文本
 */
function getInjectableMemory(db, bookId, userId = 'default', callback) {
  const results = { userProfile: {}, bookGists: [], concepts: [] };

  const tasks = [
    cb => getUserProfile(db, userId, (err, profile) => {
      if (!err) results.userProfile = profile;
      cb();
    }),
    cb => getBookGists(db, bookId, null, 10, (err, gists) => {
      if (!err) results.bookGists = gists;
      cb();
    }),
    cb => getConceptMemories(db, bookId, null, 10, (err, concepts) => {
      if (!err) results.concepts = concepts;
      cb();
    })
  ];

  let completed = 0;
  for (const task of tasks) task(() => { if (++completed === tasks.length) callback(null, results); });
}

/**
 * 格式化记忆为 prompt 文本
 */
function formatMemoryForPrompt(memory) {
  const parts = [];

  const profileEntries = Object.entries(memory.userProfile).filter(([k]) =>
    ['communication_style', 'reading_preference', 'interest_topics', 'special_requirements'].includes(k)
  );
  if (profileEntries.length > 0) {
    const profileText = profileEntries.map(([k, v]) => `· ${k}: ${v.value}`).join('\n');
    parts.push(`【用户画像】\n${profileText}`);
  }

  if (memory.bookGists.length > 0) {
    const gistsByType = {};
    for (const g of memory.bookGists) {
      if (!gistsByType[g.gist_type]) gistsByType[g.gist_type] = [];
      gistsByType[g.gist_type].push(g.content);
    }
    const gistText = Object.entries(gistsByType).map(([type, items]) =>
      `· ${type}: ${items.slice(0, 3).join('；')}`
    ).join('\n');
    parts.push(`【书籍要点】\n${gistText}`);
  }

  if (memory.concepts.length > 0) {
    const conceptText = memory.concepts.slice(0, 5).map(c => `· ${c.concept}：${c.definition}`).join('\n');
    parts.push(`【重要概念】\n${conceptText}`);
  }

  return parts.length > 0 ? `\n\n以下是你之前对话中积累的关于用户和本书的记忆：\n${parts.join('\n\n')}` : '';
}

module.exports = {
  initMemoryTables,
  getUserProfile,
  setUserProfile,
  setUserProfileBatch,
  getBookGists,
  upsertBookGist,
  deleteBookGist,
  getConceptMemories,
  upsertConceptMemory,
  getOrCreateSession,
  incrementTurnCount,
  shouldExtractMemory,
  getInjectableMemory,
  formatMemoryForPrompt
};
