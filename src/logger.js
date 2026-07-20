import { CONFIG } from './config.js';

/**
 * 增强的日志系统
 * 支持不同级别的日志和结构化输出
 */

const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// 级别名称映射
const LEVEL_NAMES = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO', 
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR'
};

class LoggerImpl {
    constructor() {
        this.minLevel = this.getLogLevelFromEnv();
        this.logCounts = { debug: 0, info: 0, warn: 0, error: 0 };
        this.lastReportTime = Date.now();
    }

    /**
     * 从环境变量获取日志级别
     */
    getLogLevelFromEnv() {
        // 默认在生产环境只记录 INFO 以上级别
        if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
            return LogLevel.INFO;
        }
        return LogLevel.DEBUG;
    }

    /**
     * 格式化日志条目
     */
    formatLogEntry(level, action, data = {}, error = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: LEVEL_NAMES[level] || 'UNKNOWN',
            action,
            ...data
        };

        if (error) {
            entry.error = error instanceof Error ? error.message : String(error);
            entry.stack = error instanceof Error ? error.stack : undefined;
            entry.errorType = error.name || 'Unknown';
        }

        return entry;
    }

    /**
     * 检查是否应该记录日志
     */
    shouldLog(level) {
        return level >= this.minLevel;
    }

    /**
     * 实际记录日志
     */
    log(level, action, data = {}, error = null) {
        if (!this.shouldLog(level)) {
            return;
        }

        const entry = this.formatLogEntry(level, action, data, error);
        const methodName = level === LogLevel.DEBUG ? 'debug' : 
                           level === LogLevel.INFO ? 'log' :
                           level === LogLevel.WARN ? 'warn' : 'error';

        console[methodName](JSON.stringify(entry));

        // 统计日志
        this.logCounts[methodName]++;
    }

    /**
     * 记录调试信息
     */
    debug(action, data = {}) {
        this.log(LogLevel.DEBUG, action, data);
    }

    /**
     * 记录一般信息
     */
    info(action, data = {}) {
        this.log(LogLevel.INFO, action, data);
    }

    /**
     * 记录警告信息
     */
    warn(action, data = {}, error = null) {
        this.log(LogLevel.WARN, action, data, error);
    }

    /**
     * 记录错误信息
     */
    error(action, error, data = {}) {
        this.log(LogLevel.ERROR, action, data, error);
    }

    /**
     * 获取日志统计信息
     */
    getStats() {
        const now = Date.now();
        const elapsed = now - this.lastReportTime;
        
        return {
            ...this.logCounts,
            total: Object.values(this.logCounts).reduce((a, b) => a + b, 0),
            elapsedMs: elapsed,
            elapsedMinutes: Math.floor(elapsed / 60000)
        };
    }

    /**
     * 重置统计
     */
    resetStats() {
        this.logCounts = { debug: 0, info: 0, warn: 0, error: 0 };
        this.lastReportTime = Date.now();
    }

    /**
     * 设置最小日志级别
     */
    setMinLevel(level) {
        this.minLevel = level;
    }
}

// 导出单例
export const Logger = new LoggerImpl();

// 导出日志级别常量
export { LogLevel };
