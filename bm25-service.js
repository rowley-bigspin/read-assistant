/**
 * BM25 检索服务
 * 基于 wink-bm25-text-search 实现关键词检索
 */

const BM25 = require('wink-bm25-text-search');

// BM25索引实例（全局，避免每次重建）
let bm25Index = null;
let bm25Ready = false;
let dbInstance = null; // 数据库连接，将在初始化时设置

/**
 * 初始化BM25索引
 * @param {Object} db - 数据库连接对象
 * @param {string} bookId - 书籍ID
 * @returns {Promise<Object>} - BM25索引实例
 */
async function initBM25Index(db, bookId) {
  return new Promise((resolve, reject) => {
    const bm25 = BM25();
    
    // 配置：使用文本字段
    bm25.defineConfig([ 'content' ]);
    
    // 从数据库加载该书籍的所有文档块
    db.all(
      `SELECT id, chapter, content FROM document_chunks WHERE book_id = ? ORDER BY chunk_index`,
      [bookId],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!rows || rows.length === 0) {
          console.warn(`⚠️ 书籍 ${bookId} 没有文档块，BM25索引为空`);
          bm25Index = bm25;
          bm25Ready = true;
          resolve(bm25);
          return;
        }
        
        // 添加文档到BM25索引
        rows.forEach((row, index) => {
          bm25.addDoc(
            { id: row.id, chapter: row.chapter, content: row.content },
            index // 使用数组索引作为docId
          );
        });
        
        console.log(`✅ BM25索引构建完成: ${rows.length} 个文档块`);
        
        // 更新全局索引
        bm25Index = bm25;
        bm25Ready = true;
        
        resolve(bm25);
      }
    );
  });
}

/**
 * BM25检索
 * @param {string} query - 查询文本
 * @param {number} limit - 返回结果数量
 * @returns {Promise<Array<{id: string, chapter: string, content: string, score: number}>>}
 */
async function bm25Search(query, limit = 20) {
  return new Promise((resolve, reject) => {
    if (!bm25Ready || !bm25Index) {
      reject(new Error('BM25索引未初始化'));
      return;
    }
    
    try {
      // 执行BM25检索
      const results = bm25Index.search(query);
      
      // 限制返回数量并格式化结果
      const limitedResults = results.slice(0, limit).map(result => ({
        id: result.doc.id,
        chapter: result.doc.chapter,
        content: result.doc.content,
        score: result.score,
        rank: result.idx // BM25返回的排名
      }));
      
      resolve(limitedResults);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 添加单个文档到BM25索引（用于增量更新）
 * @param {Object} doc - 文档对象 {id, chapter, content}
 * @param {number} docIndex - 文档索引
 */
function addDocumentToIndex(doc, docIndex) {
  if (!bm25Index) {
    throw new Error('BM25索引未初始化');
  }
  
  bm25Index.addDoc(doc, docIndex);
  console.log(`📄 已添加文档到BM25索引: ${doc.id}`);
}

/**
 * 清空BM25索引
 */
function clearIndex() {
  bm25Index = null;
  bm25Ready = false;
  console.log('🗑️ BM25索引已清空');
}

/**
 * 检查BM25索引是否就绪
 */
function isReady() {
  return bm25Ready;
}

/**
 * 获取BM25索引统计信息
 */
function getStats() {
  if (!bm25Index) {
    return { ready: false, docsCount: 0 };
  }
  
  return {
    ready: bm25Ready,
    docsCount: bm25Index.getDocsCount ? bm25Index.getDocsCount() : 'unknown'
  };
}

module.exports = {
  initBM25Index,
  bm25Search,
  addDocumentToIndex,
  clearIndex,
  isReady,
  getStats
};
