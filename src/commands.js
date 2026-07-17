/**
 * 命令注册表模块
 *
 * 所有管理员命令集中在此注册。每个命令接收一个 ctx 对象：
 *   { env, userId, threadId }
 *
 * 新增命令只需调用 registerCommand() 即可，无需修改核心路由逻辑。
 */

import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { safeGetJSON, withMessageThreadId } from './utils.js';
import { tgCall, probeForumThread, getAllKeys } from './api.js';

// --- 命令注册表 ---

const registry = new Map();

/**
 * 注册管理员命令
 * @param {string} name - 命令名（含 / 前缀，如 "/close"）
 * @param {function} handler - async (ctx: { env, userId, threadId }) => void
 */
export function registerCommand(name, handler) {
    registry.set(name, handler);
}

/**
 * 查找命令处理器
 * @param {string} name - 命令名
 * @returns {function|undefined}
 */
export function getCommand(name) {
    return registry.get(name);
}

// --- 命令注册：所有管理命令在此集中声明 ---

registerCommand('/close', async ({ env, userId, threadId }) => {
    const key = `user:${userId}`;
    const rec = await safeGetJSON(env, key, null);
    if (rec) {
        rec.closed = true;
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
        await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "🚫 **对话已强制关闭**",
            parse_mode: "Markdown"
        });
    }
});

registerCommand('/open', async ({ env, userId, threadId }) => {
    const key = `user:${userId}`;
    const rec = await safeGetJSON(env, key, null);
    if (rec) {
        rec.closed = false;
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
        await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "✅ **对话已恢复**",
            parse_mode: "Markdown"
        });
    }
});

registerCommand('/reset', async ({ env, userId, threadId }) => {
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "🔄 **验证重置**",
        parse_mode: "Markdown"
    });
});

registerCommand('/trust', async ({ env, userId, threadId }) => {
    await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
    await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
    await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "🌟 **已设置永久信任**",
        parse_mode: "Markdown"
    });
});

registerCommand('/ban', async ({ env, userId, threadId }) => {
    await env.TOPIC_MAP.put(`banned:${userId}`, "1");
    await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "🚫 **用户已封禁**",
        parse_mode: "Markdown"
    });
});

registerCommand('/unban', async ({ env, userId, threadId }) => {
    await env.TOPIC_MAP.delete(`banned:${userId}`);
    await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "✅ **用户已解封**",
        parse_mode: "Markdown"
    });
});

registerCommand('/info', async ({ env, userId, threadId }) => {
    const userKey = `user:${userId}`;
    const userRec = await safeGetJSON(env, userKey, null);
    const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
    const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);

    const info = [
        `👤 **用户信息**`,
        `UID: \`${userId}\``,
        `Topic ID: \`${threadId}\``,
        `话题标题: ${userRec?.title || "未知"}`,
        `验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}`,
        `封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}`,
        `Link: [点击私聊](tg://user?id=${userId})`
      ].join('\n');

      await tgCall(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: threadId,
          text: info,
          parse_mode: "Markdown"
      });
  });

registerCommand('/help', async ({ env, threadId }) => {
    const helpText = [
        '**管理员指令列表**',
        '',
        '/close - 强制关闭对话',
        '/open - 重新开启对话',
        '/ban - 封禁用户',
        '/unban - 解封用户',
        '/trust - 永久信任',
        '/reset - 重置验证',
        '/info - 查看用户信息',
        '/cleanup - 批量清理失效用户',
    ].join('\n');

    await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: helpText,
        parse_mode: "Markdown"
    });
});

  // --- /cleanup 命令（处理较重，独立定义） ---

/**
 * 批量清理命令处理函数（优化并发性能）
 *
 * 功能：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
export async function handleCleanupCommand(threadId, env) {
    const lockKey = "cleanup:lock";
    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: "⏳ **已有清理任务正在运行，请稍后再试。**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

    // 发送处理中的消息
    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: "🔄 **正在扫描需要清理的用户...**",
        parse_mode: "Markdown"
    }, threadId));

    let cleanedCount = 0;
    let errorCount = 0;
    const cleanedUsers = [];
    let scannedCount = 0;

    try {
        // 逐页扫描，避免一次性拉取全部 keys 导致超时/内存膨胀
        let cursor = undefined;
        do {
            const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
            const names = (result.keys || []).map(k => k.name);
            scannedCount += names.length;

            // 批量并发处理（限制并发数）
            for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
                const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);

                const results = await Promise.allSettled(
                    batch.map(async (name) => {
                        const rec = await safeGetJSON(env, name, null);
                        if (!rec || !rec.thread_id) return null;

                        const userId = name.slice(5);
                        const topicThreadId = rec.thread_id;

                        // 检测话题是否存在
                        const probe = await probeForumThread(env, topicThreadId, {
                            userId,
                            reason: "cleanup_check",
                            doubleCheckOnMissingThreadId: false
                        });

                        // cleanup 要求更保守：仅在明确缺失/重定向时清理
                        if (probe.status === "redirected" || probe.status === "missing") {
                            await env.TOPIC_MAP.delete(name);
                            await env.TOPIC_MAP.delete(`verified:${userId}`);
                            await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);

                            return {
                                userId,
                                threadId: topicThreadId,
                                title: rec.title || "未知"
                            };
                        } else if (probe.status === "probe_invalid") {
                            Logger.warn('cleanup_probe_invalid_message', {
                                userId,
                                threadId: topicThreadId,
                                errorDescription: probe.description
                            });
                        } else if (probe.status === "unknown_error") {
                            Logger.warn('cleanup_probe_failed_unknown', {
                                userId,
                                threadId: topicThreadId,
                                errorDescription: probe.description
                            });
                        } else if (probe.status === "missing_thread_id") {
                            Logger.warn('cleanup_probe_missing_thread_id', { userId, threadId: topicThreadId });
                        }

                        return null;
                    })
                );

                // 处理结果
                results.forEach(result => {
                    if (result.status === 'fulfilled' && result.value) {
                        cleanedCount++;
                        cleanedUsers.push(result.value);
                        Logger.info('cleanup_user', {
                            userId: result.value.userId,
                            threadId: result.value.threadId
                        });
                    } else if (result.status === 'rejected') {
                        errorCount++;
                        Logger.error('cleanup_batch_error', result.reason);
                    }
                });

                // 防止速率限制
                if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
                    await new Promise(r => setTimeout(r, 600));
                }
            }

            cursor = result.list_complete ? undefined : result.cursor;

            // 在分页之间让出时间片
            if (cursor) {
                await new Promise(r => setTimeout(r, 200));
            }
        } while (cursor);

        // 生成并发送清理报告
        let reportText = `✅ **清理完成**\n\n📊 **统计信息**\n`;
        reportText += `- 扫描用户数: ${scannedCount}\n`;
        reportText += `- 已清理用户数: ${cleanedCount}\n`;
        reportText += `- 错误数: ${errorCount}\n\n`;

        if (cleanedCount > 0) {
            reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
            for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
                reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
            }
            if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
                reportText += `\n...(还有 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} 个用户)\n`;
            }
            reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
        } else {
            reportText += `✨ 没有发现需要清理的用户记录。`;
        }

        Logger.info('cleanup_completed', { cleanedCount, errorCount, totalUsers: scannedCount });

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: reportText,
            parse_mode: "Markdown"
        }, threadId));

    } catch (e) {
        Logger.error('cleanup_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\``,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}
