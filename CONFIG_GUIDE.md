# 配置指南

## 环境变量配置说明

### ⚠️ 重要：防止配置丢失

**所有敏感配置都应该在 Cloudflare Dashboard 中手动配置，不要在代码或 GitHub 中设置。**

### 配置优先级

Cloudflare Workers 配置优先级如下：
1. **Dashboard 环境变量** (最高优先级)
2. `wrangler.toml` 中的配置
3. 代码中的默认值

### Dashboard 配置步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 选择你的账户 → Workers & Pages
3. 找到 `telegram-private-chatbot` Worker
4. 点击 **Settings** → **Variables**
5. 添加以下环境变量：

### 必需环境变量

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `BOT_TOKEN` | Telegram Bot Token | `123456789:ABCdefGHIjklMNOpqrsTUVwxyz` |
| `SUPERGROUP_ID` | 超级群组 ID | `-1001234567890` |
| `ADMIN_IDS` | 管理员用户 ID 列表 | `123456789,987654321` |

### 可选环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEBUG_MODE` | 调试模式 | `false` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `RATE_LIMIT_MESSAGE` | 消息速率限制 | `45` |
| `API_TIMEOUT_MS` | API 超时时间 | `10000` |

### KV Namespace 绑定

在 Dashboard 中确保 KV Namespace 绑定正确：

1. 进入 **Settings** → **Bindings**
2. 添加 KV Namespace 绑定：
   - **Variable name**: `TOPIC_MAP`
   - **KV Namespace**: 选择你的 KV namespace

### GitHub Secrets 配置（用于自动部署）

如果使用 GitHub Actions 自动部署，需要在 GitHub Repository 中设置 Secrets：

1. 进入 Repository → **Settings** → **Secrets and variables** → **Actions**
2. 添加以下 Repository secrets：

| Secret 名称 | 说明 | 获取方式 |
|-------------|------|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | Cloudflare Dashboard → My Profile → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | Cloudflare Dashboard → Workers & Pages → Overview |

### 防止配置丢失的最佳实践

1. **永远不要在 `wrangler.toml` 中声明敏感配置**
2. **永远不要在 GitHub Secrets 中存储 `BOT_TOKEN` 或 `SUPERGROUP_ID`**
3. **每次部署后检查 Dashboard 中的配置是否完好**
4. **定期备份重要配置信息**
5. **使用 GitHub Actions 的 `workflow_dispatch` 触发部署，而不是自动部署**

### 故障排查

如果部署后配置丢失：

1. 检查 Dashboard → Variables 是否为空
2. 检查是否有人在 `wrangler.toml` 中添加了 `[vars]` 配置
3. 检查 GitHub Actions 是否在传递环境变量
4. 检查是否有 CI/CD 脚本覆盖了配置

### 配置验证

部署后可以通过以下方式验证配置：

```javascript
// 在 Worker 代码中添加日志
console.log({
  hasBotToken: !!env.BOT_TOKEN,
  hasSupergroupId: !!env.SUPERGROUP_ID,
  hasTopicMap: !!env.TOPIC_MAP
});
```

查看 Cloudflare Workers 日志确认配置是否正确加载。
