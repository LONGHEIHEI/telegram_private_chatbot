/**
 * 配置管理器
 * 支持环境变量覆盖和配置验证
 */

import { Logger } from './logger.js';

// 默认配置常量
export const DEFAULT_CONFIG = {
    // 验证配置
    VERIFY_ID_LENGTH: 16,                    // 增加到16位，提高安全性
    VERIFY_EXPIRE_SECONDS: 300,              // 5分钟
    VERIFIED_EXPIRE_SECONDS: 2592000,        // 30天
    NEEDS_REVERIFY_TTL_SECONDS: 600,         // 标记需重新验证的 TTL

    // 媒体组配置
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,              // 3秒
    MEDIA_GROUP_MAX_DELAY_MS: 10000,         // 最大延迟10秒

    // 消息队列配置
    PENDING_MAX_MESSAGES: 10,                // 验证期间最多暂存的消息数

    // 缓存配置
    ADMIN_CACHE_TTL_SECONDS: 300,            // 管理员权限缓存 5 分钟
    THREAD_HEALTH_TTL_MS: 60000,             // 话题健康检查缓存 1 分钟
    CACHE_MAX_SIZE: 10000,                   // 最大缓存条目数
    CACHE_CLEANUP_INTERVAL_MS: 60000,        // 缓存清理间隔 1 分钟

    // 速率限制配置
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    RATE_LIMIT_GLOBAL: 100,                  // 全局速率限制

    // API配置
    API_TIMEOUT_MS: 10000,
    API_RETRY_ATTEMPTS: 3,                   // 默认重试次数
    API_BASE_DELAY_MS: 1000,                 // 基础重试延迟
    API_MAX_DELAY_MS: 32000,                 // 最大重试延迟

    // 电路断路器配置
    CIRCUIT_FAILURE_THRESHOLD: 5,            // 失败阈值
    CIRCUIT_RECOVERY_TIMEOUT_MS: 60000,      // 恢复超时 1 分钟
    CIRCUIT_HALF_OPEN_MAX_CALLS: 3,          // 半开状态最大调用次数

    // 用户界面配置
    BUTTON_COLUMNS: 2,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    MAX_CLEANUP_DISPLAY: 20,

    // 清理和运维配置
    CLEANUP_BATCH_SIZE: 10,
    CLEANUP_LOCK_TTL_SECONDS: 1800,          // /cleanup 防并发锁 30 分钟
    MAX_RETRY_ATTEMPTS: 3,
    KV_LIST_MAX_ITERATIONS: 100,             // KV 列表最大迭代次数
    KV_BATCH_SIZE: 100,                      // KV 批量操作大小

    // 健康检查配置
    HEALTH_CHECK_INTERVAL_MS: 300000,        // 健康检查间隔 5 分钟
    MEDIA_GROUP_EXPIRE_THRESHOLD_MS: 300000, // 媒体组过期阈值 5 分钟

    // 环境配置
    NODE_ENV: 'production',                  // 生产环境
    DEBUG_MODE: false,                       // 调试模式
    LOG_LEVEL: 'info'                        // 日志级别: debug, info, warn, error
};

// 最终导出的配置对象（带环境变量覆盖）
export const CONFIG = { ...DEFAULT_CONFIG };

/**
 * 从环境变量读取并覆盖配置
 * @param {Object} env - Cloudflare Workers 环境对象
 */
export function loadConfigFromEnv(env) {
    if (!env) return;

    // 数值类型配置
    const numericConfigs = [
        'VERIFY_ID_LENGTH', 'VERIFY_EXPIRE_SECONDS', 'VERIFIED_EXPIRE_SECONDS',
        'MEDIA_GROUP_EXPIRE_SECONDS', 'MEDIA_GROUP_DELAY_MS', 'MEDIA_GROUP_MAX_DELAY_MS',
        'PENDING_MAX_MESSAGES', 'ADMIN_CACHE_TTL_SECONDS', 'THREAD_HEALTH_TTL_MS',
        'CACHE_MAX_SIZE', 'CACHE_CLEANUP_INTERVAL_MS', 'RATE_LIMIT_MESSAGE',
        'RATE_LIMIT_VERIFY', 'RATE_LIMIT_WINDOW', 'RATE_LIMIT_GLOBAL', 'API_TIMEOUT_MS',
        'API_RETRY_ATTEMPTS', 'API_BASE_DELAY_MS', 'API_MAX_DELAY_MS',
        'CIRCUIT_FAILURE_THRESHOLD', 'CIRCUIT_RECOVERY_TIMEOUT_MS', 'CIRCUIT_HALF_OPEN_MAX_CALLS',
        'BUTTON_COLUMNS', 'MAX_TITLE_LENGTH', 'MAX_NAME_LENGTH', 'MAX_CLEANUP_DISPLAY',
        'CLEANUP_BATCH_SIZE', 'CLEANUP_LOCK_TTL_SECONDS', 'MAX_RETRY_ATTEMPTS',
        'KV_LIST_MAX_ITERATIONS', 'KV_BATCH_SIZE', 'HEALTH_CHECK_INTERVAL_MS',
        'MEDIA_GROUP_EXPIRE_THRESHOLD_MS', 'NEEDS_REVERIFY_TTL_SECONDS'
    ];

    // 布尔类型配置
    const booleanConfigs = ['DEBUG_MODE'];

    // 字符串类型配置
    const stringConfigs = ['NODE_ENV', 'LOG_LEVEL'];

    // 读取数值配置
    for (const key of numericConfigs) {
        if (env[key] !== undefined) {
            const value = parseInt(env[key], 10);
            if (!isNaN(value)) {
                CONFIG[key] = value;
            }
        }
    }

    // 读取布尔配置
    for (const key of booleanConfigs) {
        if (env[key] !== undefined) {
            CONFIG[key] = env[key] === 'true' || env[key] === true;
        }
    }

    // 读取字符串配置
    for (const key of stringConfigs) {
        if (env[key] !== undefined) {
            CONFIG[key] = String(env[key]);
        }
    }

    Logger.info('config_loaded_from_env', {
        loadedKeys: Object.keys(CONFIG).length,
        debugMode: CONFIG.DEBUG_MODE,
        logLevel: CONFIG.LOG_LEVEL,
        nodeEnv: CONFIG.NODE_ENV
    });
}

/**
 * 验证配置的有效性
 */
export function validateConfig() {
    const errors = [];
    const warnings = [];

    // 检查必需的配置项
    const requiredConfigs = [
        'VERIFY_ID_LENGTH', 'VERIFY_EXPIRE_SECONDS', 
        'VERIFIED_EXPIRE_SECONDS', 'API_TIMEOUT_MS'
    ];

    for (const configName of requiredConfigs) {
        if (CONFIG[configName] === undefined || CONFIG[configName] === null) {
            errors.push(`Missing required config: ${configName}`);
        }
    }

    // 验证数值范围
    if (CONFIG.VERIFY_ID_LENGTH < 8 || CONFIG.VERIFY_ID_LENGTH > 32) {
        warnings.push('VERIFY_ID_LENGTH should be between 8 and 32 for security');
    }

    if (CONFIG.API_TIMEOUT_MS < 1000 || CONFIG.API_TIMEOUT_MS > 60000) {
        warnings.push('API_TIMEOUT_MS should be between 1000 and 60000 ms');
    }

    if (CONFIG.CACHE_MAX_SIZE < 100 || CONFIG.CACHE_MAX_SIZE > 100000) {
        warnings.push('CACHE_MAX_SIZE should be between 100 and 100000');
    }

    // 验证时间配置的合理性
    if (CONFIG.VERIFY_EXPIRE_SECONDS >= CONFIG.VERIFIED_EXPIRE_SECONDS) {
        warnings.push('VERIFY_EXPIRE_SECONDS should be much shorter than VERIFIED_EXPIRE_SECONDS');
    }

    if (CONFIG.RATE_LIMIT_MESSAGE < 10 || CONFIG.RATE_LIMIT_MESSAGE > 1000) {
        warnings.push('RATE_LIMIT_MESSAGE should be between 10 and 1000');
    }

    // 验证日志级别
    const validLogLevels = ['debug', 'info', 'warn', 'error'];
    if (!validLogLevels.includes(CONFIG.LOG_LEVEL.toLowerCase())) {
        errors.push(`Invalid LOG_LEVEL: ${CONFIG.LOG_LEVEL}. Must be one of: ${validLogLevels.join(', ')}`);
    }

    // 记录验证结果
    if (errors.length > 0) {
        Logger.error('config_validation_errors', null, { errors });
        throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }

    if (warnings.length > 0) {
        Logger.warn('config_validation_warnings', { warnings });
    }

    Logger.info('config_validation_success', { 
        configCount: Object.keys(CONFIG).length,
        hasWarnings: warnings.length > 0 
    });

    return { valid: true, errors, warnings };
}

/**
 * 获取环境特定的配置覆盖
 */
export function getEnvSpecificOverrides() {
    const overrides = {};
    
    // 生产环境覆盖
    if (CONFIG.NODE_ENV === 'production') {
        Object.assign(overrides, {
            DEBUG_MODE: false,
            LOG_LEVEL: 'warn',
            API_RETRY_ATTEMPTS: 2,  // 生产环境减少重试次数
            RATE_LIMIT_MESSAGE: 30, // 生产环境更严格的速率限制
        });
    }
    
    // 开发环境覆盖
    if (CONFIG.NODE_ENV === 'development' || CONFIG.DEBUG_MODE) {
        Object.assign(overrides, {
            DEBUG_MODE: true,
            LOG_LEVEL: 'debug',
            API_RETRY_ATTEMPTS: 3,
            API_TIMEOUT_MS: 15000,    // 开发环境更长超时
            RATE_LIMIT_MESSAGE: 100,  // 开发环境放宽限制
        });
    }
    
    return overrides;
}

/**
 * 应用环境特定的覆盖
 */
export function applyEnvSpecificOverrides() {
    const overrides = getEnvSpecificOverrides();
    
    // 只覆盖当环境中未设置的配置
    for (const [key, value] of Object.entries(overrides)) {
        // 如果环境变量中没有设置，则使用环境特定的默认值
        // 这里我们无法直接检查是否从环境变量加载，所以假设如果值等于默认值则可以覆盖
        if (CONFIG[key] === DEFAULT_CONFIG[key]) {
            CONFIG[key] = value;
        }
    }
    
    Logger.info('config_env_specific_overrides_applied', { 
        overrides,
        nodeEnv: CONFIG.NODE_ENV,
        debugMode: CONFIG.DEBUG_MODE 
    });
}

/**
 * 初始化配置
 * @param {Object} env - Cloudflare Workers 环境对象
 */
export function initializeConfig(env) {
    try {
        // 1. 从环境变量加载配置
        loadConfigFromEnv(env);
        
        // 2. 应用环境特定的覆盖
        applyEnvSpecificOverrides();
        
        // 3. 验证配置
        validateConfig();
        
        Logger.info('config_initialization_success', {
            environment: CONFIG.NODE_ENV,
            debugMode: CONFIG.DEBUG_MODE,
            logLevel: CONFIG.LOG_LEVEL
        });
        
        return CONFIG;
    } catch (error) {
        Logger.error('config_initialization_failed', error);
        throw error;
    }
}

// 本地题库 (15条)
export const LOCAL_QUESTIONS = [
    {"question": "冰融化后会变成什么？", "correct_answer": "水", "incorrect_answers": ["石头", "木头", "火"]},
    {"question": "正常人有几只眼睛？", "correct_answer": "2", "incorrect_answers": ["1", "3", "4"]},
    {"question": "以下哪个属于水果？", "correct_answer": "香蕉", "incorrect_answers": ["白菜", "猪肉", "大米"]},
    {"question": "1 加 2 等于几？", "correct_answer": "3", "incorrect_answers": ["2", "4", "5"]},
    {"question": "5 减 2 等于几？", "correct_answer": "3", "incorrect_answers": ["1", "2", "4"]},
    {"question": "2 乘以 3 等于几？", "correct_answer": "6", "incorrect_answers": ["4", "5", "7"]},
    {"question": "10 加 5 等于几？", "correct_answer": "15", "incorrect_answers": ["10", "12", "20"]},
    {"question": "8 减 4 等于几？", "correct_answer": "4", "incorrect_answers": ["2", "3", "5"]},
    {"question": "在天上飞的交通工具是什么？", "correct_answer": "飞机", "incorrect_answers": ["汽车", "轮船", "自行车"]},
    {"question": "星期一的后面是星期几？", "correct_answer": "星期二", "incorrect_answers": ["星期日", "星期五", "星期三"]},
    {"question": "鱼通常生活在哪里？", "correct_answer": "水里", "incorrect_answers": ["树上", "土里", "火里"]},
    {"question": "我们用什么器官来听声音？", "correct_answer": "耳朵", "incorrect_answers": ["眼睛", "鼻子", "嘴巴"]},
    {"question": "晴朗的天空通常是什么颜色的？", "correct_answer": "蓝色", "incorrect_answers": ["绿色", "红色", "紫色"]},
    {"question": "太阳从哪个方向升起？", "correct_answer": "东方", "incorrect_answers": ["西方", "南方", "北方"]},
    {"question": "小狗发出的叫声通常是？", "correct_answer": "汪汪", "incorrect_answers": ["喵喵", "咩咩", "呱呱"]}
];
