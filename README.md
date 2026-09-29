# Claude Code Web Terminal 使用说明

本项目包含两个组件：

1. **ttyd-terminal** — Web 终端网关（手机访问 Claude Code）
2. **claude-code-config** — Claude Code 配置 + 轮询大模型服务

---

## 一、TTYD 终端网关

### 功能
通过浏览器访问 Web 终端，运行 Claude Code。

### 文件说明
- `ttyd-gateway.js` — 反向代理网关（端口 7681）
- `ttyd-fix.html` — 自定义终端页面（支持移动端优化）

### 启动方式

```bash
# 安装依赖
apt-get install -y ttyd tmux nodejs npm

# 启动网关
node ttyd-gateway.js &

# 访问地址
http://<server-ip>:7681/
```

### 访问地址
- 主终端: `http://<host>:7681/?key=ce4b3fd9862c013c430bd12e9a0769e2`

---

## 二、轮询大模型服务 (chat-web)

### 功能
提供 Web 聊天界面，自动轮询多个大模型 API，支持限流管理和模型降级。

### 文件说明
- `chat-web/server.js` — 轮询服务主程序
- `chat-web/index.html` — 前端界面
- `sensecli/` — SenseNova API 包装器（备用）

### 启动方式

```bash
cd chat-web
npm install
node server.js &

# 访问地址
http://<server-ip>:3001/
```

---

## 三、大模型轮询机制详解

### 3.1 架构概览

```
用户请求 → chat-web server → Claude Code CLI → LLM API
                    ↓
              Token Pool (4个token)
              Model Chain (3个模型)
              Rate Limiter (限流管理)
```

### 3.2 核心组件

#### Token 池 (TOKEN_POOL)
- 配置 4 个 Sensenova API Token
- Round-robin 轮换使用
- 每个 token 独立计数 5 小时窗口内的用量

```javascript
const TOKEN_POOL = [
  'sk-rjSWwNOueqYfSxFUEu7fEi1mTjYjvvdQ',  // tok#SWwN
  'sk-P4l1zSAGwLif4LnOzAtKhorVej5L1uT4',  // tok#l1zS
  'sk-zXAlbixlfWXxXjUWRso9qC1m3DYB4ajk',  // tok#XAlb
  'sk-6HqcznSf6agPXoGkh8dRvbFBWuesMxHT',  // tok#cznS
];
```

#### 模型链 (MODEL_CHAIN)
三级降级链，按优先级排序：

```javascript
const MODEL_CHAIN = [
  'glm-5.2',                    // 主模型
  'deepseek-v4-pro',            // 降级1
  'sensenova-6.8-flash-lite',   // 降级2（备用）
];
```

#### 配额限制 (MODEL_QUOTA)
每个模型每 5 小时窗口内的最大请求数：

| 模型 | 配额 |
|------|------|
| glm-5.2 | 500 |
| deepseek-v4-pro | 500 |
| sensenova-6.8-flash-lite | 1500 |

### 3.3 轮询流程

```
请求到达
    ↓
选择当前模型 (默认 glm-5.2)
    ↓
pickToken(model) → 从池中选择下一个可用 token
    ↓
发送请求到 Claude Code CLI
    ↓
    ├── 成功 → 记录用量 +1，返回结果
    │
    ├── 429 限流 → markRateLimited()
    │       ↓
    │   判断限流类型：
    │   ├── RPM 瞬时超限 → 冷却 60s，换下一个 token
    │   ├── 配额耗尽 → 冷却 5h，降级到下一个模型
    │   └── 服务故障 → 冷却 30s，继续重试
    │
    └── 其他错误 → 记录日志，返回错误
```

### 3.4 限流检测逻辑

```javascript
// 伪代码
function markRateLimited(tokenIdx, model, errorText) {
  if (error contains "empty_stream") {
    // 服务故障，短冷却 30s
    cooldown = 30s
  } else if (used < quota * 0.5) {
    // 使用量不足一半，肯定是 RPM 瞬时超限
    cooldown = 60s
  } else if (其他 token 也在 10s 内被 429) {
    // 全局 RPM 尖峰
    cooldown = 60s
  } else {
    // 真正的配额耗尽
    cooldown = 5h
    degrade_to_next_model()
  }
}
```

### 3.5 状态持久化

使用 `/root/.chat-web/token-usage.json` 保存用量状态：

```json
{
  "0:glm-5.2": {
    "windowStart": 1696000000000,
    "used": 123,
    "limitedUntil": 0,
    "consecutive429": 0,
    "last429At": 0
  },
  "1:glm-5.2": { ... },
  "2:glm-5.2": { ... },
  "3:glm-5.2": { ... }
}
```

重启服务后自动加载，保证跨重启的用量计数准确。

### 3.6 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `WINDOW_MS` | 5h | 用量窗口长度 |
| `SHORT_COOLDOWN_MS` | 30s | 服务故障冷却 |
| `RPM_SPIKE_COOLDOWN_MS` | 60s | RPM 尖峰冷却 |
| `ROTATE_DELAY_MS` | 3s | 换 token/降级前延迟 |
| `MAX_RETRIES` | 12 | 最大重试次数 |
| `MAX_SESSION_CHARS` | 800KB | 会话压缩阈值 |

---

## 四、环境变量配置

### SENSENOVA_TOKENS
自定义 token 池（逗号分隔）：

```bash
export SENSENOVA_TOKENS="sk-token1,sk-token2,sk-token3,sk-token4"
node server.js
```

### ANTHROPIC_BASE_URL
指定 LLM API 端点（Claude Code 配置中已设为 `http://127.0.0.1:8317`）

---

## 五、新环境部署步骤

### 前置条件
- Node.js 18+
- npm
- ttyd, tmux（如需 Web 终端）
- Claude Code CLI（`/usr/local/bin/claude`）

### 部署脚本

```bash
# 1. 克隆仓库
git clone https://github.com/wqy579/claude-code-config.git
cd claude-code-config

# 2. 安装依赖
cd chat-web && npm install

# 3. 配置 token（可选，默认使用内置 4 个）
export SENSENOVA_TOKENS="your-token1,your-token2,your-token3,your-token4"

# 4. 启动服务
nohup node server.js > chat-web.log 2>&1 &

# 5. 验证
curl http://localhost:3001/
```

### 手机访问
浏览器打开：`http://<server-ip>:3001/`

---

## 六、故障排查

### 问题：所有 token 都 429
- 检查 `token-usage.json` 中的 `limitedUntil` 时间
- 等待 5h 窗口重置，或更换新 token

### 问题：模型降级后无法恢复
- 检查模型 API 是否可用
- 手动清除 `/root/.chat-web/token-usage.json` 重置状态

### 问题：会话超长导致报错
- 系统会自动压缩（保留最近对话）
- 或手动清空会话文件

---

## 七、相关文件

| 文件 | 用途 |
|------|------|
| `chat-web/server.js` | 轮询服务主程序 |
| `chat-web/index.html` | 前端界面 |
| `.claude/settings.json` | Claude Code 权限与模型配置 |
| `sensecli/chat.js` | SenseNova API 包装器（备用） |

---

## 八、安全注意

- Token 已硬编码在 server.js 中，生产环境请使用环境变量
- `token-usage.json` 包含用量状态，建议加入 `.gitignore`
- 生产环境建议添加反向代理和认证
