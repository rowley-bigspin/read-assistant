/**
 * ReadFlow API 客户端
 * 
 * 封装所有后端 API 调用，处理 AI 对话、RAG 检索、数据持久化
 */

const API_BASE = 'http://localhost:3000/api';

// ==================== 工具函数 ====================

async function fetchAPI(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };
  
  if (config.body && typeof config.body === 'object') {
    config.body = JSON.stringify(config.body);
  }

  try {
    const response = await fetch(url, config);
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: '请求失败' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`API 请求失败 (${endpoint}):`, error);
    throw error;
  }
}

// ==================== AI 对话 API ====================

/**
 * 通用 AI 对话
 * @param {Array} messages - 消息列表 [{role, content}]
 * @param {Object} options - 配置选项
 */
export async function chatWithAI(messages, options = {}) {
  return fetchAPI('/chat', {
    method: 'POST',
    body: {
      messages,
      model: options.model || 'gpt-3.5-turbo',
      temperature: options.temperature || 0.7,
      stream: options.stream || false
    }
  });
}

/**
 * 基于书籍内容的 AI 对话（RAG）
 * @param {string} bookId - 书籍ID
 * @param {string} question - 问题
 * @param {string} selectedText - 当前选中的文本（可选）
 * @param {Array} chatHistory - 对话历史（可选）
 */
export async function chatWithBookContext(bookId, question, selectedText = null, chatHistory = []) {
  return fetchAPI('/chat/book-context', {
    method: 'POST',
    body: {
      bookId,
      question,
      selectedText,
      chatHistory
    }
  });
}

/**
 * 生成 AI 回复（兼容原有接口）
 * @param {string} selectedText - 选中的文本
 * @param {string} question - 问题
 * @param {string} bookId - 书籍ID（用于上下文）
 */
export async function generateAIReply(selectedText, question, bookId = null) {
  // 如果没有配置后端或 bookId，使用模拟回复
  if (!bookId) {
    return generateMockReply(selectedText, question);
  }

  try {
    // 先检查后端是否可用
    const health = await checkHealth().catch(() => null);
    if (!health) {
      console.warn('后端服务未启动，使用模拟回复');
      return generateMockReply(selectedText, question);
    }

    // 调用后端API
    const response = await chatWithBookContext(bookId, question, selectedText);
    
    if (response.mock) {
      console.log('⚠️ 后端使用模拟模式，请在 .env 中配置真实 API Key');
    }
    
    return response.answer;
  } catch (error) {
    console.error('AI 请求失败:', error);
    return generateMockReply(selectedText, question) + '\n\n[系统提示：后端服务连接失败，显示模拟回复]';
  }
}

/**
 * 模拟回复（本地备用）
 */
function generateMockReply(selectedText, question) {
  const q = question.toLowerCase();
  const text = selectedText ? selectedText.slice(0, 50) : '这段内容';
  
  if (q.includes('意思') || q.includes('含义') || q.includes('解释')) {
    return `这段话的核心意思是：作者在这里想表达的是关于"${text}..."的深层思考。\n\n（当前为演示回复，请在 .env 文件中配置真实的 AI API Key）`;
  }
  if (q.includes('为什么') || q.includes('原因')) {
    return `这是因为：在当时的语境下，"${text}..." 反映了某种特定的观点或立场。\n\n（当前为演示回复，请在 .env 文件中配置真实的 AI API Key）`;
  }
  if (q.includes('怎么') || q.includes('如何')) {
    return `建议可以从以下几个角度理解：\n1. 结合上下文语境\n2. 关注关键词的用法\n3. 思考作者的写作意图\n\n（当前为演示回复，请在 .env 文件中配置真实的 AI API Key）`;
  }
  if (q.includes('例子') || q.includes('举例')) {
    return `这段话可以举例说明：比如在实际阅读场景中，当我们遇到"${text}..."这样的表达时，可以尝试...\n\n（当前为演示回复，请在 .env 文件中配置真实的 AI API Key）`;
  }
  
  return `关于"${text}..."，这是一个很好的问题。\n\n我的看法是：这段话值得深入思考。建议你可以结合上下文来理解作者的意图，同时也可以参考相关的背景资料。\n\n（当前为演示回复，请在 .env 文件中配置真实的 AI API Key）`;
}

// ==================== RAG API ====================

/**
 * 索引书籍内容（将书籍文本分块存入向量数据库）
 * @param {string} bookId - 书籍ID
 * @param {Array} chapters - 章节列表 [{title, content}]
 */
export async function indexBookContent(bookId, chapters) {
  return fetchAPI('/rag/index', {
    method: 'POST',
    body: { bookId, chapters }
  });
}

/**
 * 在书籍中搜索相关内容
 * @param {string} bookId - 书籍ID
 * @param {string} query - 搜索查询
 * @param {number} limit - 返回结果数量
 */
export async function searchBookContent(bookId, query, limit = 5) {
  return fetchAPI('/rag/search', {
    method: 'POST',
    body: { bookId, query, limit }
  });
}

/**
 * 删除书籍索引
 * @param {string} bookId - 书籍ID
 */
export async function deleteBookIndex(bookId) {
  return fetchAPI(`/rag/index/${bookId}`, {
    method: 'DELETE'
  });
}

// ==================== 数据持久化 API ====================

/**
 * 笔记相关
 */
export const notesAPI = {
  getAll(bookId) {
    const query = bookId ? `?bookId=${encodeURIComponent(bookId)}` : '';
    return fetchAPI(`/notes${query}`);
  },
  
  create(note) {
    return fetchAPI('/notes', {
      method: 'POST',
      body: note
    });
  },
  
  delete(id) {
    return fetchAPI(`/notes/${id}`, {
      method: 'DELETE'
    });
  }
};

/**
 * 书签相关
 */
export const bookmarksAPI = {
  getAll(bookId) {
    const query = bookId ? `?bookId=${encodeURIComponent(bookId)}` : '';
    return fetchAPI(`/bookmarks${query}`);
  },
  
  create(bookmark) {
    return fetchAPI('/bookmarks', {
      method: 'POST',
      body: bookmark
    });
  }
};

/**
 * 阅读进度相关
 */
export const progressAPI = {
  get(bookId) {
    return fetchAPI(`/progress/${bookId}`);
  },
  
  save(progress) {
    return fetchAPI('/progress', {
      method: 'POST',
      body: progress
    });
  }
};

// ==================== 健康检查 ====================

/**
 * 检查后端服务状态
 */
export async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return await response.json();
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

/**
 * 获取 AI 配置信息
 */
export async function getAIConfig() {
  return fetchAPI('/ai/config');
}

// ==================== 默认导出 ====================

export default {
  chatWithAI,
  chatWithBookContext,
  generateAIReply,
  indexBookContent,
  searchBookContent,
  deleteBookIndex,
  notes: notesAPI,
  bookmarks: bookmarksAPI,
  progress: progressAPI,
  checkHealth,
  getAIConfig
};
