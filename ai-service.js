/**
 * AI 服务模块
 * 支持多种 AI 提供商：OpenAI、通义千问、文心一言、智谱AI、DeepSeek、Claude
 */

// ==================== 配置（懒加载，确保 dotenv 已加载）====================

function getAIProviders() {
  return {
    openai: {
      name: 'OpenAI',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      requiresKey: true
    },
    dashscope: {
      name: '阿里云通义千问',
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: process.env.DASHSCOPE_MODEL || 'qwen-turbo',
      requiresKey: true
    },
    qianfan: {
      name: '百度文心一言',
      apiKey: process.env.QIANFAN_API_KEY,
      secretKey: process.env.QIANFAN_SECRET_KEY,
      baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat',
      model: process.env.QIANFAN_MODEL || 'ernie_bot_8k',
      requiresKey: true
    },
    zhipu: {
      name: '智谱AI',
      apiKey: process.env.ZHIPU_API_KEY,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: process.env.ZHIPU_MODEL || 'glm-4-flash',
      requiresKey: true
    },
    deepseek: {
      name: 'DeepSeek',
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: 'https://api.deepseek.com/v1',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      requiresKey: true
    },
    anthropic: {
      name: 'Anthropic Claude',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: 'https://api.anthropic.com/v1',
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      requiresKey: true
    }
  };
}

// 获取默认提供商
function getDefaultProvider() {
  return process.env.DEFAULT_AI_PROVIDER || 'openai';
}

// ==================== 工具函数 ====================

/**
 * 获取可用的 AI 提供商
 */
function getAvailableProvider() {
  const providers = getAIProviders();
  const defaultProvider = getDefaultProvider();
  
  // 1. 检查默认提供商
  const defaultConfig = providers[defaultProvider];
  if (defaultConfig && defaultConfig.apiKey) {
    return { provider: defaultProvider, config: defaultConfig };
  }

  // 2. 查找第一个配置了 API Key 的提供商
  for (const [key, config] of Object.entries(providers)) {
    if (config.apiKey) {
      return { provider: key, config };
    }
  }

  return null;
}

/**
 * 获取所有已配置的提供商列表
 */
function getConfiguredProviders() {
  const providers = getAIProviders();
  const configured = [];
  for (const [key, config] of Object.entries(providers)) {
    if (config.apiKey) {
      configured.push({ key, name: config.name, model: config.model });
    }
  }
  return configured;
}

// ==================== OpenAI 兼容格式调用 ====================

/**
 * 调用 OpenAI 兼容格式的 API
 */
async function callOpenAICompatible(config, messages, options = {}) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: options.model || config.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2000,
      stream: options.stream || false
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  return await response.json();
}

// ==================== 特定提供商实现 ====================

/**
 * 调用阿里云通义千问
 */
async function callDashscope(config, messages, options = {}) {
  // 转换消息格式
  const formattedMessages = messages.map(m => ({
    role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  const response = await fetch(`${config.baseUrl}/services/aigc/text-generation/generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: options.model || config.model,
      input: {
        messages: formattedMessages
      },
      parameters: {
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 2000,
        result_format: 'message'
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`通义千问 API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  // 转换为 OpenAI 格式
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: data.output?.choices?.[0]?.message?.content || data.output?.text || ''
      }
    }],
    model: data.model || config.model,
    usage: data.usage
  };
}

/**
 * 调用百度文心一言
 */
async function callQianfan(config, messages, options = {}) {
  // 百度需要 access_token，这里简化处理，实际应该先获取 token
  // 详见：https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Slkkydwgk
  
  // 获取 access_token
  const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${config.apiKey}&client_secret=${config.secretKey}`;
  const tokenRes = await fetch(tokenUrl, { method: 'POST' });
  const tokenData = await tokenRes.json();
  
  if (!tokenData.access_token) {
    throw new Error('百度 API 认证失败：无法获取 access_token');
  }

  // 构建消息（百度格式略有不同）
  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');
  
  const requestBody = {
    messages: chatMessages.map(m => ({
      role: m.role,
      content: m.content
    })),
    temperature: options.temperature ?? 0.7,
    max_output_tokens: options.maxTokens ?? 2000
  };

  if (systemMessage) {
    requestBody.system = systemMessage.content;
  }

  const response = await fetch(`${config.baseUrl}/${config.model}?access_token=${tokenData.access_token}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`文心一言 API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // 转换为 OpenAI 格式
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: data.result || ''
      }
    }],
    model: config.model,
    usage: data.usage
  };
}

/**
 * 带重试的 fetch 调用
 */
async function fetchWithRetry(url, options, maxRetries = 3, delayMs = 1000) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      
      // 如果是 429 (Too Many Requests)，等待后重试
      if (response.status === 429) {
        const errorText = await response.text();
        console.log(`⏳ 遇到限流 (429)，${delayMs}ms 后重试 (${i + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2; // 指数退避
        continue;
      }
      
      return response;
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        console.log(`⏳ 请求失败，${delayMs}ms 后重试 (${i + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }
  }
  
  throw lastError || new Error('请求多次重试后仍然失败');
}

/**
 * 调用智谱 AI
 * 文档：https://open.bigmodel.cn/dev/api/thirdparty-frame/openai-sdk
 * 智谱使用 OpenAI 兼容格式，Authorization: Bearer {apiKey}
 */
async function callZhipu(config, messages, options = {}) {
  // 如果主模型繁忙，尝试备用模型
  const models = [options.model || config.model, 'glm-4-flash', 'glm-4-air'];
  let lastError;
  
  for (const model of models) {
    try {
      console.log(`🔄 尝试使用模型: ${model}`);
      
      const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 2000
        })
      }, 2, 500);

      if (!response.ok) {
        const errorText = await response.text();
        // 如果是模型繁忙，尝试下一个模型
        if (response.status === 429 || errorText.includes('访问量过大')) {
          console.log(`⚠️ 模型 ${model} 繁忙，尝试备用模型...`);
          lastError = new Error(`智谱 API 错误 (${response.status}): ${errorText}`);
          continue;
        }
        console.error('智谱 API 错误详情:', errorText);
        throw new Error(`智谱 API 错误 (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      console.log(`✅ 成功使用模型: ${model}`);
      return data;
      
    } catch (error) {
      lastError = error;
      if (error.message.includes('访问量过大') || error.message.includes('429')) {
        continue;
      }
      throw error;
    }
  }
  
  throw lastError || new Error('所有模型都不可用');
}

/**
 * 调用 Anthropic Claude
 */
async function callAnthropic(config, messages, options = {}) {
  // 转换消息格式（Claude 格式略有不同）
  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: m.content
  }));

  const requestBody = {
    model: options.model || config.model,
    messages: chatMessages,
    max_tokens: options.maxTokens ?? 2000,
    temperature: options.temperature ?? 0.7
  };

  if (systemMessage) {
    requestBody.system = systemMessage.content;
  }

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // 转换为 OpenAI 格式
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: data.content?.[0]?.text || ''
      }
    }],
    model: data.model,
    usage: data.usage
  };
}

// ==================== 主调用函数 ====================

/**
 * 调用 AI 生成回复
 * @param {Array} messages - 消息列表 [{role, content}]
 * @param {Object} options - 选项 {provider, temperature, maxTokens, stream}
 * @returns {Promise<Object>} AI 回复
 */
async function chat(messages, options = {}) {
  // 获取要使用的提供商
  let providerConfig;
  let providerKey;
  const providers = getAIProviders();

  if (options.provider && providers[options.provider]?.apiKey) {
    providerKey = options.provider;
    providerConfig = providers[options.provider];
  } else {
    const available = getAvailableProvider();
    if (!available) {
      throw new Error('未配置任何 AI API Key，请在 .env 文件中配置');
    }
    providerKey = available.provider;
    providerConfig = available.config;
  }

  console.log(`🤖 使用 AI 提供商: ${providerConfig.name} (${providerConfig.model})`);

  // 根据提供商调用相应的方法
  switch (providerKey) {
    case 'dashscope':
      return await callDashscope(providerConfig, messages, options);
    case 'qianfan':
      return await callQianfan(providerConfig, messages, options);
    case 'anthropic':
      return await callAnthropic(providerConfig, messages, options);
    case 'zhipu':
      return await callZhipu(providerConfig, messages, options);
    case 'deepseek':
    case 'openai':
    default:
      return await callOpenAICompatible(providerConfig, messages, options);
  }
}

/**
 * 生成书籍上下文相关的 AI 回复
 * @param {string} question - 用户问题
 * @param {string} context - 书籍上下文
 * @param {string} selectedText - 选中的文本
 * @param {Object} options - 选项
 */
async function chatWithBookContext(question, context, selectedText = null, options = {}) {
  const systemPrompt = `你是一个专业的阅读助手，正在帮助用户阅读一本书。
${context ? '以下是书中可能相关的内容片段：\n\n' + context + '\n\n---\n\n' : ''}
请基于书籍内容回答用户的问题。如果书中没有相关信息，请坦诚告知。回答要简洁、准确、有帮助。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(selectedText ? [{ role: 'user', content: `我正在看的段落："${selectedText}"` }] : []),
    { role: 'user', content: question }
  ];

  return await chat(messages, options);
}

/**
 * 基于记忆上下文生成回复（用于长期对话中的记忆增强）
 * @param {string} question - 用户问题
 * @param {string} context - 书籍上下文
 * @param {string} memoryText - 格式化后的记忆文本
 * @param {Object} options
 */
async function chatWithMemory(question, context, memoryText, options = {}) {
  const systemPrompt = `你是一个专业的阅读助手，正在帮助用户深度阅读一本书。
${memoryText ? `\n以下是你之前积累的用户记忆和书籍要点：\n${memoryText}\n` : ''}
${context ? '以下是当前对话的上下文片段：\n' + context + '\n' : ''}
请基于以上信息回答用户的问题。如果用户的问题涉及之前对话中提到的内容，优先引用记忆中的信息。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question }
  ];

  return await chat(messages, options);
}

// ==================== 导出 ====================

module.exports = {
  chat,
  chatWithBookContext,
  chatWithMemory,
  getAvailableProvider,
  getConfiguredProviders,
  getAIProviders
};
