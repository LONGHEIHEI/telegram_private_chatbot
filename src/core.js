import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { safeGetJSON } from './utils.js';
import { isAdminUser, checkRateLimit, tgCall, getAllKeys } from './api.js';
import { sendVerificationChallenge, handleCallbackQuery } from './verification.js';
import { forwardToTopic } from './forward-service.js';
import { handleMediaGroup } from './media.js';
import { updateThreadStatus } from './topic.js';
import { getCommand, handleCleanupCommand } from './commands.js';

// 通过 threadId 反查用户 ID：优先用映射，缺失时全量扫描
async function resolveUserId(env, threadId) {
    const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
    if (mappedUser) return Number(mappedUser);

    const allKeys = await getAllKeys(env, "user:");
    for (const { name } of allKeys) {
        const rec = await safeGetJSON(env, name, null);
        if (rec && Number(rec.thread_id) === Number(threadId)) {
            return Number(name.slice(5));
        }
    }
    return null;
}

export async function handlePrivateMessage(msg, env, ctx) {
    const userId = msg.chat.id;
    const key = `user:${userId}`;

    // 速率限制检查
    const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
    if (!rateLimit.allowed) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 发送过于频繁，请稍后再试。"
        });
        return;
    }

    // 拦截普通用户发送的指令
    if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
        return;
    }

    const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
    if (isBanned) return;

    const verified = await env.TOPIC_MAP.get(`verified:${userId}`);

    if (!verified) {
        const isStart = msg.text && msg.text.trim() === "/start";
        const pendingMsgId = isStart ? null : msg.message_id;
        await sendVerificationChallenge(userId, env, pendingMsgId);
        return;
    }

    await forwardToTopic(msg, userId, key, env, ctx);
}

export async function handleAdminReply(msg, env, ctx) {
    const threadId = msg.message_thread_id;
    const text = (msg.text || "").trim();
    const senderId = msg.from?.id;

    // 仅允许管理员在群内操作与回信
    if (!senderId || !(await isAdminUser(env, senderId))) {
        return;
    }

    // /cleanup 命令可能处理较久，使用 waitUntil 防止 webhook 请求超时
    if (text === "/cleanup") {
        ctx.waitUntil(handleCleanupCommand(threadId, env));
        return;
    }

    // /help 命令不限话题，General 和任意用户话题均可使用
    if (text === "/help") {
        const commandHandler = getCommand(text);
        if (commandHandler) {
            await commandHandler({ env, threadId });
        }
        return;
    }

    // 反查用户 ID
    const userId = await resolveUserId(env, threadId);
    if (!userId) return;

    // 分派命令到注册表
    const commandHandler = getCommand(text);
    if (commandHandler) {
        await commandHandler({ env, userId, threadId });
        return;
    }

    // 转发管理员消息给用户
    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
        return;
    }
    await tgCall(env, "copyMessage", {
        chat_id: userId,
        from_chat_id: env.SUPERGROUP_ID,
        message_id: msg.message_id
    });
}

// 重新导出 handleCallbackQuery 供 index.js 使用
export { handleCallbackQuery };

// 重新导出 updateThreadStatus、flushExpiredMediaGroups 供 index.js 使用
export { updateThreadStatus };
export { flushExpiredMediaGroups } from './media.js';
