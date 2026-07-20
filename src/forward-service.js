import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { safeGetJSON, normalizeTgDescription, isTopicMissingOrDeleted } from './utils.js';
import { tgCall, probeForumThread } from './api.js';
import { ThreadHealthCacheWrapper } from './cache-manager.js';
import { getOrCreateUserTopicRec } from './topic.js';
import { handleMediaGroup } from './media.js';
import { sendVerificationChallenge } from './verification.js';

export async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
    // 清理旧映射与验证状态：用户需要重新做人机验证
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
    await env.TOPIC_MAP.delete(`retry:${userId}`);

    if (userKey) {
        await env.TOPIC_MAP.delete(userKey);
    }

   if (oldThreadId !== undefined && oldThreadId !== null) {
       await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
       await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
        ThreadHealthCacheWrapper.delete(oldThreadId);
    }

    Logger.info('verification_reset_due_to_topic_loss', {
        userId,
        oldThreadId,
        pendingMsgId,
        reason
    });

    await sendVerificationChallenge(userId, env, pendingMsgId || null);
}

export async function forwardToTopic(msg, userId, key, env, ctx) {
    // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) {
        await sendVerificationChallenge(userId, env, msg.message_id || null);
        return;
    }

    // 使用安全的 JSON 解析
    let rec = await safeGetJSON(env, key, null);

    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    // 重试计数器，防止无限循环
    const retryKey = `retry:${userId}`;
    let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");

    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "❌ 系统繁忙，请稍后再试。" });
        await env.TOPIC_MAP.delete(retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) {
            throw new Error("创建话题失败");
        }
    }

    // 补建 thread->user 映射（兼容旧数据）
    if (rec && rec.thread_id) {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
        if (!mappedUser) {
            await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
        }
    }

    // 验证话题是否仍然存在（带缓存，降低探测频率）
    if (rec && rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now = Date.now();
        const cached = ThreadHealthCacheWrapper.get(cacheKey);
        const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

        if (!withinTTL) {
            // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk = await env.TOPIC_MAP.get(kvHealthKey);
            if (kvHealthOk === "1") {
                ThreadHealthCacheWrapper.set(cacheKey, { ts: now, ok: true });
            } else {
                const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

                if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    await resetUserVerificationAndRequireReverify(env, {
                        userId,
                        userKey: key,
                        oldThreadId: rec.thread_id,
                        pendingMsgId: msg.message_id,
                        reason: `health_check:${probe.status}`
                    });
                    return;
                } else if (probe.status === "probe_invalid") {
                    Logger.warn('topic_health_probe_invalid_message', {
                        userId,
                        threadId: rec.thread_id,
                        errorDescription: probe.description
                    });

                    // 仍然设置短 TTL，避免每条消息都探测
                    ThreadHealthCacheWrapper.set(cacheKey, { ts: now, ok: true });
                    await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
                } else if (probe.status === "unknown_error") {
                    Logger.warn('topic_test_failed_unknown', {
                        userId,
                        threadId: rec.thread_id,
                        errorDescription: probe.description
                    });
                } else {
                    await env.TOPIC_MAP.delete(retryKey);
                    ThreadHealthCacheWrapper.set(cacheKey, { ts: now, ok: true });
                    await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
                }
            }
        }
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
        });
        return;
    }

    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    // 检测 Telegram 静默重定向到 General 的情况
    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        Logger.warn('forward_redirected_to_general', {
            userId,
            expectedThreadId: rec.thread_id,
            actualThreadId: resThreadId
        });

        // 删除误投到 General 的消息
        if (res.result?.message_id) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: res.result.message_id
                });
            } catch (e) {
                // 删除失败不影响重发
            }
        }
        await resetUserVerificationAndRequireReverify(env, {
            userId,
            userKey: key,
            oldThreadId: rec.thread_id,
            pendingMsgId: msg.message_id,
            reason: "forward_redirected_to_general"
        });
        return;
    }

    // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
    if (res.ok && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            Logger.warn('forward_suspected_redirect_or_missing', {
                userId,
                expectedThreadId: rec.thread_id,
                probeStatus: probe.status,
                probeDescription: probe.description
            });

            if (res.result?.message_id) {
                try {
                    await tgCall(env, "deleteMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        message_id: res.result.message_id
                    });
                } catch (e) {
                    // 删除失败不影响重发
                }
            }
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: `forward_missing_thread_id:${probe.status}`
            });
            return;
        }
   }

    // 增强错误处理，双重保险
    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            Logger.warn('forward_failed_topic_missing', {
                userId,
                threadId: rec.thread_id,
                errorDescription: res.description
            });
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: "forward_failed_topic_missing"
            });
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        // 如果 forwardMessage 失败，尝试使用 copyMessage 作为降级方案
        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
    }
}
