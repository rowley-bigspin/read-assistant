/**
 * 引用标注服务模块 (Citation Service)
 *
 * 对齐 deepreader 的 chunk_id 引用体系：
 * - 为每个检索到的 chunk 生成标准 citation 格式
 * - 格式化引用列表返回给前端
 * - 提供统一的引用标注 prompt 规则
 */

/**
 * 为单个 chunk 生成 citation 对象
 */
function buildCitation(chunk, index = null) {
  return {
    chunk_id: chunk.id,
    source: chunk.chapter || '未知章节',
    chapter_index: chunk.chapter_index || 0,
    position: chunk.paragraph_index != null ? `段落${chunk.paragraph_index}` : `chunk_${chunk.chunk_index}`,
    href: chunk.href || null,
    content_preview: (chunk.content || '').slice(0, 100),
    content: chunk.content || '',
    index: index
  };
}

/**
 * 为 chunk 列表批量生成 citations
 */
function buildCitations(chunks) {
  return chunks.map((chunk, i) => buildCitation(chunk, i));
}

/**
 * 过滤出需要引用标注的 chunks（去重 + 长度过滤）
 */
function filterCitableChunks(chunks, maxChunks = 8) {
  if (!chunks || chunks.length === 0) return [];

  const seen = new Set();
  const filtered = [];

  for (const chunk of chunks) {
    if (!chunk.id) continue;
    if (seen.has(chunk.id)) continue;
    // 内容太短的跳过（可能是标题或装饰性内容）
    if ((chunk.content || '').length < 20) continue;

    seen.add(chunk.id);
    filtered.push(chunk);
    if (filtered.length >= maxChunks) break;
  }

  return filtered;
}

/**
 * 组装带编号的上下文文本（用于 prompt）
 * 每个 chunk 前缀 [chunk_id] 编号，对齐 citation 列表
 */
function formatContextWithCitations(chunks, contextWindow = 300) {
  if (!chunks || chunks.length === 0) return '';

  const citableChunks = filterCitableChunks(chunks);
  const citations = [];
  const parts = [];

  citableChunks.forEach((chunk, i) => {
    const citation = buildCitation(chunk, i);
    citations.push(citation);

    const label = `[${i + 1}]`;
    const chapter = chunk.chapter ? `【${chunk.chapter}】` : '';
    const content = (chunk.content || '').slice(0, contextWindow);

    parts.push(`${label} ${chapter}\n${content}`);
  });

  return {
    formatted: parts.join('\n\n---\n\n'),
    citations
  };
}

/**
 * 生成引用约束的 prompt 片段
 */
function getCitationPromptRule() {
  return `【引用标注规则】
- 如果你引用了书中的原文或观点，必须用 [编号] 格式标注来源
- 编号对应上述上下文中每个片段前的编号，如：[1]、[2]
- 只标注你在回答中实际引用的片段，不要标注未使用的内容
- 如果某段内容与你的回答无关，不要标注
- 示例：「小王子说："对我而言，你只是一个小男孩。"[1]」`;
}

/**
 * 生成低置信度时的 prompt 提示
 */
function getLowConfidencePromptHint() {
  return `【低置信度警告】
本次检索结果置信度较低，书中可能没有直接答案。如果你要基于这些片段回答：
1. 明确说明"根据检索到的内容..."
2. 不要捏造或推测书中未明确记载的内容
3. 标注你的回答基于哪些编号的片段 [x]
4. 如果片段完全不相关，坦诚告知用户"书中未找到相关依据"`;
}

/**
 * 生成路由级别的 prompt 说明
 */
function getRoutingLevelPrompt() {
  return `【回答级别判断】
- L0（对话历史）：如果问题涉及本轮对话已回答过的内容，直接引用已有结论，不重复检索
- L1（页面上下文）：如果问题只需当前阅读页面内容即可回答，立即回答，不调用工具
- L2（书内RAG）：如果问题需要书内多个位置的信息，使用上述检索片段回答
- L3（网络搜索）：如果问题涉及时效性内容或书外知识，调用网络搜索
- L4（通识知识）：如果问题与书籍内容无关或无法确认，基于通识知识回答但明确标注「以下为通识回答，非书中内容」`;
}

/**
 * 解析回答中的引用标注，验证并补充
 */
function parseAndValidateCitations(answer, citations) {
  const usedNumbers = [];
  const numberPattern = /\[(\d+)\]/g;
  let match;

  while ((match = numberPattern.exec(answer)) !== null) {
    usedNumbers.push(parseInt(match[1], 10));
  }

  const validCitations = usedNumbers
    .filter((n, i) => n > 0 && n <= citations.length && usedNumbers.indexOf(n) === i)
    .map(n => citations[n - 1]);

  return {
    validCitations,
    hasCitations: validCitations.length > 0
  };
}

/**
 * 格式化返回给前端的结果（包含 citations 和标注后的回答）
 */
function formatResponse(answer, chunks, options = {}) {
  const { maxContextChars = 2500, includeCitations = true } = options;

  const { formatted, citations } = formatContextWithCitations(chunks, Math.floor(maxContextChars / chunks.length));

  return {
    answer,
    citations: includeCitations ? citations : [],
    context: formatted,
    chunkCount: chunks.length,
    citationCount: citations.length
  };
}

module.exports = {
  buildCitation,
  buildCitations,
  filterCitableChunks,
  formatContextWithCitations,
  getCitationPromptRule,
  getLowConfidencePromptHint,
  getRoutingLevelPrompt,
  parseAndValidateCitations,
  formatResponse
};
