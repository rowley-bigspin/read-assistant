function shouldUseDeepReading(selectedText = '', question = '') {
  const q = String(question || '').toLowerCase();
  const text = String(selectedText || '');
  if (text.length > 20) return true;
  const deepKeywords = [
    '上下文', '表达', '含义', '艺术效果', '为什么这么写', '怎么理解',
    '什么意思', '暗示', '隐喻', '象征', '伏笔', '铺垫', '情绪', '心理',
    '意图', '手法', '作用', '效果', '背景', '为什么', '说明什么',
    '体现', '反映', '解读', '赏析', '品味', '体会',
    'meaning', 'implication', 'symbolism', 'interpret'
  ];
  return deepKeywords.some(keyword => q.includes(keyword.toLowerCase()));
}

module.exports = { shouldUseDeepReading };
