import { Logger } from './logger.js';
import { initializeConfig } from './config.js';
import { tgCall } from './api.js';
import { triggerScheduledCleanup } from './api.js';
import { handlePrivateMessage, handleAdminReply, handleCallbackQuery, updateThreadStatus, flushExpiredMediaGroups } from './core.js';

export default {
  async fetch(request, env, ctx) {

    // 触发缓存清理（如果有必要）
    triggerScheduledCleanup();
    // 初始化配置（会从环境变量中读取并验证）
    initializeConfig(env);    console.log(JSON.stringify({
        hasTopicMap: !!env.TOPIC_MAP,
        hasBotToken: !!env.BOT_TOKEN,
        hasSupergroupId: !!env.SUPERGROUP_ID,
        supergroupIdType: typeof env.SUPERGROUP_ID,
        supergroupIdValue: String(env.SUPERGROUP_ID).substring(0, 10)
    }));

    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // 规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: String(env.SUPERGROUP_ID),
        BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
        return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    if (request.method !== "POST") return new Response("OK");

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    Logger.info('request_received', { contentType });

    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      Logger.info('callback_query_received', { userId: update.callback_query.from?.id });
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) {
        Logger.info('no_message_in_update', { updateKeys: Object.keys(update).join(',') });
        return new Response("OK");
    }

    Logger.info('message_received', {
        chatId: msg.chat?.id,
        chatType: msg.chat?.type,
        textPreview: (msg.text || msg.caption || '').substring(0, 50)
    });

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      Logger.info('routing_to_private', { userId: msg.chat.id });
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 超级群组消息处理
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
            return new Response("OK");
        }
        // 支持 General 话题和普通话题
        const text = (msg.text || "").trim();
        const isCommand = !!text && text.startsWith("/");
        if (msg.message_thread_id || isCommand) {
            await handleAdminReply(msg, normalizedEnv, ctx);
            return new Response("OK");
        }
    }

    Logger.info('unhandled_update', {
        chatType: msg.chat?.type,
        supergroupId: normalizedEnv.SUPERGROUP_ID,
        msgChatId: msg.chat?.id ? String(msg.chat.id) : 'none'
    });
    return new Response("OK");
  },
};
