# ReadFlow — AI 阅读器

一体化阅读工作台，把"读书 + AI 提问 + 笔记沉淀"三个工作流合并为一个无切换体验。

## 功能特性

- 📖 **EPUB 阅读**：支持导入 EPUB 文件或加载演示内容
- 🤖 **AI 问答**：基于选中文字提问，支持多种大模型
- 🔍 **RAG 检索**：书籍内容索引，支持上下文感知回答
- 📝 **笔记系统**：划词高亮 + 笔记卡片 + Markdown 导出
- 🔖 **书签定位**：快速跳转到重要位置
- 🎨 **多主题**：浅色 / 深色 / 护眼模式
- 🔌 **多模型支持**：OpenAI、通义千问、文心一言、智谱AI、DeepSeek、Claude

## 项目结构

```
read assistant/
├── index.html          # 前端页面
├── styles.css          # 样式文件
├── app.js              # 前端逻辑
├── api.js              # 前端 API 客户端
├── ai-service.js       # AI 服务模块（多模型支持）
├── package.json        # Node.js 项目配置
├── server.js           # 后端服务
├── .env                # 环境变量配置（AI API Key）
├── .env.example        # 环境变量模板
├── data/               # SQLite 数据库目录
│   └── readflow.db
└── README.md
```

## 快速启动

### 1. 安装依赖

```bash
cd "read assistant"
npm install
```

### 2. 配置 AI API

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 API Key。支持以下 AI 提供商：

#### OpenAI / Azure OpenAI / 国内代理
```env
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-3.5-turbo
```

#### 阿里云百炼 (通义千问)
获取地址：https://bailian.console.aliyun.com/
```env
DASHSCOPE_API_KEY=your-dashscope-api-key-here
DASHSCOPE_MODEL=qwen-turbo
```

#### 百度文心一言
获取地址：https://console.bce.baidu.com/qianfan/
```env
QIANFAN_API_KEY=your-qianfan-api-key-here
QIANFAN_SECRET_KEY=your-qianfan-secret-key-here
QIANFAN_MODEL=ernie-bot-turbo
```

#### 智谱 AI (GLM)
获取地址：https://open.bigmodel.cn/
```env
ZHIPU_API_KEY=your-zhipu-api-key-here
ZHIPU_MODEL=glm-4-flash
```

#### DeepSeek
获取地址：https://platform.deepseek.com/
```env
DEEPSEEK_API_KEY=your-deepseek-api-key-here
DEEPSEEK_MODEL=deepseek-chat
```

#### Anthropic Claude
获取地址：https://console.anthropic.com/
```env
ANTHROPIC_API_KEY=your-anthropic-api-key-here
ANTHROPIC_MODEL=claude-3-haiku-20240307
```

#### 设置默认提供商
```env
DEFAULT_AI_PROVIDER=openai  # 可选：openai | dashscope | qianfan | zhipu | deepseek | anthropic
```

> 不配置 API Key 也能运行，但 AI 功能将使用模拟回复。

### 3. 启动后端服务

```bash
npm start
```

或开发模式（热重载）：

```bash
npm run dev
```

服务默认运行在 http://localhost:3000

启动后会显示已配置的 AI 提供商：
```
AI 提供商: ✅ 已配置 2 个
  ▶ OpenAI: gpt-3.5-turbo
    DeepSeek: deepseek-chat
```

### 4. 启动前端

**方式一：Python（推荐）**

```bash
python -m http.server 8787
```

**方式二：Node.js**

```bash
npx serve -p 8787
```

**方式三：直接用后端服务**

后端已经配置了静态文件服务，直接访问：http://localhost:3000

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查（含 AI 配置信息） |
| `/api/ai/config` | GET | 获取 AI 配置信息 |
| `/api/chat` | POST | AI 通用对话 |
| `/api/chat/book-context` | POST | 基于书籍内容的 AI 对话（RAG） |
| `/api/rag/index` | POST | 索引书籍内容 |
| `/api/rag/search` | POST | 搜索书籍内容 |
| `/api/notes` | GET/POST | 笔记 CRUD |
| `/api/bookmarks` | GET/POST | 书签 CRUD |
| `/api/progress` | GET/POST | 阅读进度 |

## 技术栈

**前端**：
- 纯 HTML + CSS + Vanilla JS（无框架依赖）
- EPUB 解析：epub.js 0.3.93
- JSZip（用于生成演示 EPUB）

**后端**：
- Node.js + Express
- SQLite 数据库
- 支持多种 AI API（OpenAI、通义千问、文心一言等）

## 开发模式 vs 生产模式

| 模式 | AI 回复 | RAG 检索 | 数据存储 |
|------|---------|----------|----------|
| 后端未启动 | 本地模拟回复 | 不可用 | localStorage |
| 后端已启动，无 API Key | 服务端模拟回复 | 可用 | SQLite |
| 后端已启动，有 API Key | 真实 AI 回复 | 可用 | SQLite |

## 如何获取免费 AI API

### 1. 智谱 AI (GLM-4-Flash) - 免费
- 访问：https://open.bigmodel.cn/
- 注册即送 token，GLM-4-Flash 模型免费使用
- 在 `.env` 中配置 `ZHIPU_API_KEY`

### 2. DeepSeek - 有免费额度
- 访问：https://platform.deepseek.com/
- 注册赠送 5000 万 tokens
- 在 `.env` 中配置 `DEEPSEEK_API_KEY`

### 3. 阿里云通义千问 - 有免费额度
- 访问：https://bailian.console.aliyun.com/
- 新用户有免费额度
- 在 `.env` 中配置 `DASHSCOPE_API_KEY`

## 后续规划

- [x] 接入多种 AI 大模型接口
- [x] 支持国内主流大模型
- [ ] 向量检索升级（支持语义相似度搜索）
- [ ] 流式输出（打字机效果）
- [ ] 多用户支持与云端同步
- [ ] 书架管理页面
- [ ] 结构化笔记（大纲/思维导图）

## 许可证

MIT
