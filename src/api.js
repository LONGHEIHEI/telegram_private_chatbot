import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { safeGetJSON, normalizeTgDescription, isTopicMissingOrDeleted, isTestMessageInvalid } from './utils.js';
import { AdminCacheWrapper, ThreadHealthCacheWrapper, cleanupAllCaches } from './cache-manager.js';
import { retryOperation, classifyError, isRetryableError, withCircuitBreaker } from './retry-manager.js';

// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
export const topicCreateInFlight = new Map();

// 定期清理缓存
setInterval(() => {
    cleanupAllCaches();
}, 60000); // 每分钟清理一次

// --- 管理员工具 ---

export function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) {
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        set.add(String(n));
    }
    return set.size > 0 ? set : null;
}

export async function isAdminUser(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;

    const cacheKey = String(userId);
    
    // 使用新的缓存包装器
    const cached = AdminCacheWrapper.get(cacheKey);
    if (cached) {
        return cached.isAdmin;
    }

    const kvKey = `admin:${userId}`;
    const kvVal = await env.TOPIC_MAP.get(kvKey);
    if (kvVal === "1" || kvVal === "0") {
        const isAdmin = kvVal === "1";
        const now = Date.now();
        AdminCacheWrapper.set(cacheKey, { ts: now, isAdmin }, CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000);
        return isAdmin;
    }

    try {
        const res = await tgCall(env, "getChatMember", {
            chat_id: env.SUPERGROUP_ID,
            user_id: userId
        });

        const status = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        await env.TOPIC_MAP.put(kvKey, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
        const now = Date.now();
        AdminCacheWrapper.set(cacheKey, { ts: now, isAdmin }, CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000);
        return isAdmin;
    } catch (e) {
        Logger.warn('admin_check_failed', { userId });
        return false;
    }
}

// --- 速率限制 ---

export async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const countStr = await env.TOPIC_MAP.get(key);
    const count = parseInt(countStr || "0");

    if (count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

// --- KV 全量遍历 ---

export async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor = undefined;

    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return allKeys;
}

// --- Telegram API 调用 ---

export async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
    return withCircuitBreaker(async () => {
        return await performApiCall(env, method, body, timeout);
    });
}

/**
 * 实际执行 API 调用（内部函数）
 */
async function performApiCall(env, method, body, timeout) {
    let base = env.API_BASE || "https://api.telegram.org";

    // 强制 HTTPS
    if (base.startsWith("http://")) {
        Logger.warn('api_http_upgraded', { originalBase: base });
        base = base.replace("http://", "https://");
    }

    // 验证 URL 格式
    try {
        new URL(`${base}/test`);
    } catch (e) {
        Logger.error('api_base_invalid', e, { base });
        base = "https://api.telegram.org";
    }

    // 超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!resp.ok && resp.status >= 500) {
            Logger.warn('telegram_api_server_error', { method, status: resp.status });
        }

        const result = await resp.json();

        // 记录速率限制
        if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
            const retryAfter = result.parameters?.retry_after || 5;
            Logger.warn('telegram_api_rate_limit', { method, retryAfter });
        }

        return result;
    } catch (e) {
        clearTimeout(timeoutId);

        if (e.name === 'AbortError') {
            Logger.error('telegram_api_timeout', e, { method, timeout });
            return { ok: false, description: 'Request timeout' };
        }

        Logger.error('telegram_api_failed', e, { method });
        throw e;
    }
}

// --- 话题健康探测 ---

export async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
    const attemptOnce = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: expectedThreadId,
            text: "🔎"
        });

        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;

        // 尽可能清理探测消息
        if (res.ok && probeMessageId) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: probeMessageId
                });
            } catch (e) {
                // 删除失败不影响主流程
            }
        }

        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) {
                return { status: "missing", description: res.description };
            }
            if (isTestMessageInvalid(res.description)) {
                return { status: "probe_invalid", description: res.description };
            }
            return { status: "unknown_error", description: res.description };
        }

        // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id
        if (actualThreadId === undefined || actualThreadId === null) {
            return { status: "missing_thread_id" };
        }

        if (Number(actualThreadId) !== Number(expectedThreadId)) {
            return { status: "redirected", actualThreadId };
        }

        return { status: "ok" };
    };

    const first = await attemptOnce();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

    // 二次探测：避免偶发字段缺失导致误判并触发重建
    const second = await attemptOnce();
    if (second.status === "missing_thread_id") {
        Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    }
    return second;
}
