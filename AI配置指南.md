# ReadFlow AI 配置指南

本文档介绍如何在 ReadFlow 中配置 AI 功能。

## 快速开始

### 1. 复制配置文件

```bash
cp .env.example .env
```

### 2. 选择 AI 提供商

ReadFlow 支持以下 AI 提供商，选择其中一个进行配置即可：

#### 推荐：智谱 AI（免费）
1. 访问 https://open.bigmodel.cn/ 注册账号
2. 获取 API Key
3. 在 `.env` 文件中配置：
```env
ZHIPU_API_KEY=你的API密钥
ZHIPU_MODEL=glm-4-flash
DEFAULT_AI_PROVIDER=zhipu
```

#### DeepSeek（有免费额度）
1. 访问 https://platform.deepseek.com/ 注册账号
2. 获取 API Key
3. 在 `.env` 文件中配置：
```env
DEEPSEEK_API_KEY=你的API密钥
DEEPSEEK_MODEL=deepseek-chat
DEFAULT_AI_PROVIDER=deepseek
```

#### 阿里云通义千问
1. 访问 https://bailian.console.aliyun.com/ 注册账号
2. 获取 API Key
3. 在 `.env` 文件中配置：
```env
DASHSCOPE_API_KEY=你的API密钥
DASHSCOPE_MODEL=qwen-turbo
DEFAULT_AI_PROVIDER=dashscope
```

#### OpenAI
1. 访问 https://platform.openai.com/ 获取 API Key
2. 在 `.env` 文件中配置：
```env
OPENAI_API_KEY=你的API密钥
OPENAI_MODEL=gpt-3.5-turbo
DEFAULT_AI_PROVIDER=openai
```

### 3. 启动服务

```bash
npm start
```

启动后，控制台会显示：
```
AI 提供商: ✅ 已配置 1 个
  ▶ 智谱AI: glm-4-flash
```

## 常见问题

### Q: 没有 API Key 能用吗？
可以，但没有真实 AI 回复，系统会使用模拟回复。

### Q: 可以同时配置多个 AI 吗？
可以，系统会自动选择第一个可用的。也可以通过 `DEFAULT_AI_PROVIDER` 指定默认使用的。

### Q: API Key 保存在哪里安全吗？
API Key 保存在服务端的 `.env` 文件中，不会暴露给前端。请勿将 `.env` 文件提交到 Git。

### Q: 如何切换 AI 模型？
修改 `.env` 中的 `DEFAULT_AI_PROVIDER` 为对应的值即可。

## 各平台免费额度

| 平台 | 免费额度 | 备注 |
|------|---------|------|
| 智谱 AI GLM-4-Flash | 完全免费 | 推荐 |
| DeepSeek | 5000 万 tokens | 注册赠送 |
| 阿里云通义千问 | 100 万 tokens | 新用户 |
| 百度文心一言 | 有免费额度 | 需实名认证 |

## 测试 AI 功能

启动服务后，可以通过以下方式测试：

1. 访问 http://localhost:3000 打开阅读器
2. 点击"加载演示书籍"
3. 选中一段文字，点击"问 AI"
4. 输入问题，查看 AI 回复

如果看到 `[系统提示：当前使用模拟回复...]`，说明 API Key 配置有问题，请检查 `.env` 文件。
