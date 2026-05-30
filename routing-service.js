/**
 * 路由服务模块 (Routing Service)
 *
 * 实现 L0-L4 查询路由策略，对齐 deepreader 的设计：
 * L0 · 对话历史：本轮 AI 已回答过的概念 → 直接引用，不重复检索
 * L1 · 页面上下文：【当前阅读页面内容】能答 → 立即答，不调工具
 * L2 · 书内 RAG：ragSearch → ragContext → ragToc/ragRange
 * L3 · 网络搜索：涉及时效性内容或书外知识
 * L4 · 通识知识：末尾标注「基于通识知识，非书中内容」
 *
 * 路由决策由 AI 小模型完成，确保判断准确
 */

const { shouldUseDeepReading } = require('./server-utility');

/**
 * 判断问题路由级别
 * 返回值：{ level: 0-4, reasoning: string, routingTarget: object }
 *
 * 使用轻量级 prompt + 快速模型判断，避免每次都走完整 RAG
 */
async function determineRoutingLevel(aiService, question, selectedText, pageContext, chatHistory, options = {}) {
  const { lowCostProvider = 'zhipu', temperature = 0, maxTokens = 200 } = options;

  // 如果 chatHistory 为空且 pageContext 也为空，直接 L2
  if ((!chatHistory || chatHistory.length === 0) && (!pageContext || pageContext.trim().length < 20)) {
    return { level: 2, reasoning: '无对话历史且无页面上下文，降级到书内RAG', routingTarget: null };
  }

  // 构建判断 prompt
  const historyText = chatHistory && chatHistory.length > 0
    ? `本轮对话历史（最近3轮）：\n${chatHistory.slice(-3).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n')}`
    : '（无对话历史）';

  const pageText = pageContext && pageContext.trim().length > 20
    ? `当前阅读页面内容（已加载到内存）：\n${pageContext.slice(0, 300)}`
    : '（无页面上下文或内容过短）';

  const routingPrompt = `你是一个阅读助手的路由决策模块。用户正在阅读一本书，请判断这个问题应该用什么级别的方式回答。

判断规则：
L0（对话历史）：用户的问题是追问、澄清、或重复确认本轮对话中已回答过的内容 → 直接引用已有回答
L1（页面上下文）：用户的问题只需要当前页面可见的内容就能回答，不需要书内其他位置的内容 → 立即回答
L2（书内RAG）：用户的问题需要书内多个位置的信息（跨段落/跨章节），需要检索增强生成 → 调用RAG
L3（网络搜索）：用户问题涉及时效性新闻、实时数据、作者生平等书外知识 → 调用网络搜索
L4（通识知识）：用户问题与当前书籍完全无关，或问的是一般性知识 → 基于通识知识回答

${historyText}

${pageText}

用户问题：「${question}」
${selectedText ? `用户选中的文本：「${selectedText.slice(0, 50)}...」` : '（无选中文本）'}

请输出以下JSON格式（只输出JSON，不要有其他文字）：
{
  "level": 0或1或2或3或4,
  "reasoning": "一句话说明为什么选择这个级别",
  "routingTarget": {
    "type": "history" | "page" | "rag" | "websearch" | "general",
    "detail": "具体描述，如：引用第2轮对话，或：无需检索直接回答"
  }
}`;

  try {
    const result = await aiService.chat(
      [{ role: 'system', content: routingPrompt }],
      { provider: lowCostProvider, temperature, maxTokens }
    );
    const text = result.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.warn('路由判断失败，降级到L2:', error.message);
  }

  // 默认降级到 L2
  return { level: 2, reasoning: '路由判断异常，降级到书内RAG', routingTarget: { type: 'rag', detail: '默认RAG检索' } };
}

/**
 * 从对话历史中查找是否有相关已回答内容（L0）
 */
function findHistoryAnswer(chatHistory, question, selectedText) {
  if (!chatHistory || chatHistory.length === 0) return null;

  // 简单的关键词匹配：检查历史中是否有相似问题的回答
  const questionKeywords = question.toLowerCase().split(/[\s，。、！？；：""''（）【】《》,.!?;:'"()\[\]]/).filter(w => w.length >= 2);

  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const msg = chatHistory[i];
    // 只检查 assistant 的回答
    if (msg.role !== 'assistant') continue;

    const content = (msg.content || '').toLowerCase();
    const selectedLower = (selectedText || '').toLowerCase();

    // 计算关键词命中率
    let hits = 0;
    for (const kw of questionKeywords) {
      if (content.includes(kw) || (selectedLower && content.includes(selectedLower.slice(0, 10)))) {
        hits++;
      }
    }

    // 如果命中超过 30% 的关键词，认为是相关历史
    if (questionKeywords.length > 0 && hits / questionKeywords.length >= 0.3) {
      return {
        answer: msg.content,
        round: i,
        confidence: hits / questionKeywords.length,
        reason: '历史对话中找到相关回答'
      };
    }
  }

  return null;
}

/**
 * 判断页面上下文是否足够回答问题（L1）
 */
async function determinePageContextSufficiency(aiService, question, selectedText, pageContext, options = {}) {
  if (!pageContext || pageContext.trim().length < 30) {
    return { sufficient: false, reason: '页面上下文不足' };
  }

  const checkPrompt = `判断以下问题是否只需要页面上下文就能回答，不需要检索书内其他内容。

页面上下文：
${pageContext.slice(0, 500)}

用户问题：「${question}」
${selectedText ? `选中文本：「${selectedText.slice(0, 50)}...」` : ''}

请输出JSON：
{
  "sufficient": true或false,
  "reason": "一句话说明判断理由"
}`;

  try {
    const result = await aiService.chat(
      [{ role: 'system', content: checkPrompt }],
      { temperature: 0, maxTokens: 150, provider: options.provider }
    );
    const text = result.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.warn('页面上下文充分性判断失败:', error.message);
  }

  // 默认认为需要 RAG
  return { sufficient: false, reason: '判断异常，默认需要RAG' };
}

/**
 * 构建 L0 回答（基于历史）
 */
function buildHistoryAnswer(historyResult, question, selectedText) {
  return {
    answer: historyResult.answer,
    sources: [],
    routing: {
      level: 0,
      reasoning: historyResult.reason,
      source: 'chat_history',
      round: historyResult.round
    },
    citations: [],
    lowConfidence: false,
    fromCache: true
  };
}

/**
 * 构建 L1 回答（基于页面上下文）
 */
function buildPageAnswer(pageContext, question, aiService, options = {}) {
  const systemPrompt = `你是一个阅读助手。用户正在阅读一本书，当前页面内容已提供。
请基于页面内容回答用户的问题。

【规则】
- 如果页面内容足以回答，直接回答
- 如果页面内容不足以回答，坦诚说明"当前页面内容不足以回答这个问题"
- 无论是否充足，都不要调用工具，直接生成回答`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(selectedText ? [{ role: 'user', content: `当前页面内容：\n${pageContext}\n\n---\n\n选中的文本："${selectedText}"\n\n我的问题：${question}` }] : [{ role: 'user', content: `当前页面内容：\n${pageContext}\n\n---\n\n我的问题：${question}` }])
  ];

  return aiService.chat(messages, options).then(result => ({
    answer: result.choices?.[0]?.message?.content || '',
    sources: [],
    routing: {
      level: 1,
      reasoning: '页面上下文足以回答',
      source: 'page_context'
    },
    citations: [],
    lowConfidence: false
  }));
}

/**
 * 执行 L2 RAG（书内检索）
 * 实际由调用方传入的 ragFunction 执行
 */
function buildL2RoutingTarget(selectedText, question, options = {}) {
  return {
    type: 'rag',
    params: {
      selectedText: selectedText || question,
      question,
      ...options
    }
  };
}

/**
 * 执行 L3/L4 降级回答
 */
function buildFallbackAnswer(level, question, error = null) {
  const levelConfig = {
    3: {
      answer: `您的问题涉及书外知识（时效性内容、外部资料等），我暂时无法联网搜索相关内容。

建议您：
· 换个与当前书籍内容相关的问题
· 直接向我描述您想知道的内容，我可以基于书籍内容尽力回答`,
      reasoning: '网络搜索暂未实现'
    },
    4: {
      answer: `您的问题似乎与当前阅读的书籍内容无关，我基于书籍内容无法直接回答。

不过我可以基于一般知识尝试回答：\n\n（请在此处基于通识知识回答）\n\n⚠️ 注意：以上回答基于一般性知识，非本书内容，如与书中的观点冲突，请以书为准。`,
      reasoning: '通识知识降级回答'
    }
  };

  const config = levelConfig[level] || levelConfig[4];

  return {
    answer: config.answer + (error ? `\n\n（系统信息：${error.message}）` : ''),
    sources: [],
    routing: {
      level,
      reasoning: config.reasoning,
      source: level === 3 ? 'websearch_unavailable' : 'general_knowledge'
    },
    citations: [],
    lowConfidence: true
  };
}

module.exports = {
  determineRoutingLevel,
  findHistoryAnswer,
  determinePageContextSufficiency,
  buildHistoryAnswer,
  buildPageAnswer,
  buildL2RoutingTarget,
  buildFallbackAnswer
};
