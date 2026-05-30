/**
 * Embedding Service - 文本向量化服务
 * 调用智谱AI embedding-3 API将文本转换为向量
 */

const fetch = global.fetch || require('node-fetch');
require('dotenv').config();

// 智谱AI embedding API配置
const ZHIPU_EMBEDDING_API = 'https://open.bigmodel.cn/api/paas/v4/embeddings';
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;

// 默认向量维度（1024维，平衡性能和成本）
const DEFAULT_DIMENSIONS = 1024;

// 批量处理大小（智谱AI支持最多32个文本同时处理）
const BATCH_SIZE = 32;

// 重试配置
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1秒

/**
 * 调用智谱AI embedding-3 API
 * @param {Array<string>} texts - 要向量化的文本数组
 * @param {number} dimensions - 向量维度（256/512/1024/2048）
 * @returns {Promise<Array<Array<number>>>} - 向量数组
 */
async function getEmbeddings(texts, dimensions = DEFAULT_DIMENSIONS) {
  if (!ZHIPU_API_KEY) {
    throw new Error('未配置智谱AI API Key，请在.env文件中设置ZHIPU_API_KEY');
  }

  if (!texts || texts.length === 0) {
    return [];
  }

  // 分批处理（每批最多BATCH_SIZE个文本）
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const allEmbeddings = [];
  
  for (let i = 0; i < batches.length; i++) {
    console.log(`📊 向量化进度: ${i * BATCH_SIZE}/${texts.length}`);
    
    const batchEmbeddings = await getEmbeddingsBatch(batches[i], dimensions, i + 1);
    allEmbeddings.push(...batchEmbeddings);
    
    // 批次间延迟，避免API限流
    if (i < batches.length - 1) {
      await sleep(500);
    }
  }

  console.log(`✅ 向量化完成: ${allEmbeddings.length} 个文本块`);
  return allEmbeddings;
}

/**
 * 单个批次的embedding请求（带重试）
 */
async function getEmbeddingsBatch(texts, dimensions, batchNum, retryCount = 0) {
  try {
    const response = await fetch(ZHIPU_EMBEDDING_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ZHIPU_API_KEY}`
      },
      body: JSON.stringify({
        model: 'embedding-3',
        input: texts,
        dimensions: dimensions
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      
      // 如果是429限流错误，等待后重试
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAY * Math.pow(2, retryCount); // 指数退避
        console.log(`⏳ API限流，等待 ${delay}ms 后重试...`);
        await sleep(delay);
        return await getEmbeddingsBatch(texts, dimensions, batchNum, retryCount + 1);
      }
      
      throw new Error(`智谱AI API错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    // 提取向量（按输入顺序）
    const embeddings = data.data
      .sort((a, b) => a.index - b.index) // 确保顺序正确
      .map(item => item.embedding);

    return embeddings;

  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`⚠️ 请求失败，${delay}ms 后重试... (${retryCount + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return await getEmbeddingsBatch(texts, dimensions, batchNum, retryCount + 1);
    }
    throw error;
  }
}

/**
 * 计算两个向量的余弦相似度
 * @param {Array<number>} vecA - 向量A
 * @param {Array<number>} vecB - 向量B
 * @returns {number} - 相似度（0-1之间）
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    throw new Error('向量维度不匹配');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * 批量计算查询向量与多个文档向量的相似度
 * @param {Array<number>} queryVector - 查询向量
 * @param {Array<Array<number>>} docVectors - 文档向量数组
 * @returns {Array<{index: number, similarity: number}>} - 相似度结果（按相似度降序）
 */
function batchCosineSimilarity(queryVector, docVectors) {
  const results = docVectors.map((docVec, index) => ({
    index,
    similarity: cosineSimilarity(queryVector, docVec)
  }));

  // 按相似度降序排序
  results.sort((a, b) => b.similarity - a.similarity);

  return results;
}

/**
 * 将向量转换为JSON字符串（用于SQLite存储）
 */
function vectorToJSON(vector) {
  return JSON.stringify(vector);
}

/**
 * 从JSON字符串解析向量（从SQLite读取）
 */
function jsonToVector(jsonString) {
  return JSON.parse(jsonString);
}

/**
 * 辅助函数：延迟执行
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 测试API连接
 */
async function testConnection() {
  try {
    const testEmbeddings = await getEmbeddings(['测试文本'], 256);
    return {
      success: true,
      dimensions: testEmbeddings[0].length,
      message: 'Embedding API连接正常'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  getEmbeddings,
  cosineSimilarity,
  batchCosineSimilarity,
  vectorToJSON,
  jsonToVector,
  testConnection,
  DEFAULT_DIMENSIONS,
  BATCH_SIZE
};
