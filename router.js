#!/usr/bin/env node

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

// ================= ПРОВЕРКА КОНФИГУРАЦИИ =================
const requiredEnvVars = [
    'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_TABLE',
    'TARGET_GW', 'API_PORT', 'API_KEY'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
    console.error('Please check your .env file');
    process.exit(1);
}

// ================= КОНФИГУРАЦИЯ =================
const CONFIG = {
    mysql: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        table: process.env.DB_TABLE
    },
    targetGw: process.env.TARGET_GW,
    routeInterface: process.env.ROUTE_INTERFACE || '',
    blockedRouteCidrs: process.env.BLOCKED_ROUTE_CIDRS || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    apiPort: parseInt(process.env.API_PORT),
    apiKey: process.env.API_KEY,
    syncInterval: parseInt(process.env.SYNC_INTERVAL_MS) || 60000,
    autoSyncEnabled: process.env.AUTO_SYNC_ENABLED !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info'
};

if (!Number.isInteger(CONFIG.apiPort) || CONFIG.apiPort < 1 || CONFIG.apiPort > 65535) {
    console.error('API_PORT must be a valid TCP port (1-65535)');
    process.exit(1);
}

if (!/^[A-Za-z0-9_]+$/.test(CONFIG.mysql.table)) {
    console.error('DB_TABLE may contain only latin letters, digits and underscore');
    process.exit(1);
}

if (!isValidIpv4(CONFIG.targetGw)) {
    console.error('TARGET_GW must be a valid IPv4 address');
    process.exit(1);
}

if (CONFIG.routeInterface && !/^[A-Za-z0-9_.:-]+$/.test(CONFIG.routeInterface)) {
    console.error('ROUTE_INTERFACE contains invalid characters');
    process.exit(1);
}

CONFIG.blockedRoutes = parseBlockedCidrs(CONFIG.blockedRouteCidrs);
if (CONFIG.blockedRoutes === null) {
    console.error('BLOCKED_ROUTE_CIDRS must be a comma-separated list of IPv4 CIDR ranges');
    process.exit(1);
}

// ================= ЛОГГЕР =================
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.info;

function log(level, message, data = null) {
    if (LOG_LEVELS[level] >= currentLogLevel) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        
        if (data) {
            console.log(logMessage, data);
        } else {
            console.log(logMessage);
        }
    }
}

const logger = {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data)
};

function isValidIpv4(ip) {
    if (typeof ip !== 'string') return false;
    const parts = ip.split('.');
    return parts.length === 4 && parts.every(part => {
        if (!/^\d+$/.test(part)) return false;
        if (part.length > 1 && part.startsWith('0')) return false;
        const value = Number(part);
        return value >= 0 && value <= 255;
    });
}

function parseRouteMask(mask) {
    if (mask === undefined || mask === null || mask === '' || mask === 'хост' || mask === 'host' || mask === 32 || mask === '32') {
        return 32;
    }

    const value = Number(mask);
    if (!Number.isInteger(value) || value < 0 || value > 32) {
        return null;
    }

    return value;
}

function ipv4ToInt(ip) {
    if (!isValidIpv4(ip)) return null;
    return ip.split('.').reduce((result, part) => ((result << 8) + Number(part)) >>> 0, 0);
}

function parseCidr(cidr) {
    const [ip, mask] = cidr.trim().split('/');
    const parsedMask = parseRouteMask(mask);
    const ipInt = ipv4ToInt(ip);

    if (ipInt === null || parsedMask === null) {
        return null;
    }

    const maskInt = parsedMask === 0 ? 0 : (0xffffffff << (32 - parsedMask)) >>> 0;
    return {
        cidr: `${ip}/${parsedMask}`,
        network: (ipInt & maskInt) >>> 0,
        mask: parsedMask,
        maskInt
    };
}

function parseBlockedCidrs(value) {
    const cidrs = value.split(',').map(item => item.trim()).filter(Boolean);
    const parsedCidrs = cidrs.map(parseCidr);

    if (parsedCidrs.some(cidr => cidr === null)) {
        return null;
    }

    return parsedCidrs;
}

function isRouteBlocked(ip) {
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) return true;

    return CONFIG.blockedRoutes.some(route => ((ipInt & route.maskInt) >>> 0) === route.network);
}

function blockedRouteMessage(ip, mask) {
    return `Route ${formatRoute(ip, mask)} is blocked by local/private network policy`;
}

function formatRoute(ip, mask) {
    return mask === 32 ? `${ip} (хост)` : `${ip}/${mask}`;
}

function routeKey(ip, mask) {
    return `${ip}|${mask}`;
}

function routeDestination(ip, mask) {
    return mask === 32 ? ip : `${ip}/${mask}`;
}

function buildIpRouteArgs(action, ip, mask) {
    const args = ['route', action, routeDestination(ip, mask), 'via', CONFIG.targetGw];
    if (CONFIG.routeInterface) {
        args.push('dev', CONFIG.routeInterface);
    }
    return args;
}

function parseSystemRouteLine(line) {
    const parts = line.trim().split(/\s+/);
    const destination = parts[0];
    const viaIndex = parts.indexOf('via');

    if (viaIndex === -1 || parts[viaIndex + 1] !== CONFIG.targetGw) {
        return null;
    }

    if (CONFIG.routeInterface) {
        const devIndex = parts.indexOf('dev');
        if (devIndex === -1 || parts[devIndex + 1] !== CONFIG.routeInterface) {
            return null;
        }
    }

    if (destination.includes('/')) {
        const [ip, mask] = destination.split('/');
        const parsedMask = parseRouteMask(mask);
        if (!isValidIpv4(ip) || parsedMask === null) return null;
        return { ip, mask: parsedMask, type: parsedMask === 32 ? 'host' : 'network' };
    }

    if (!isValidIpv4(destination)) return null;
    return { ip: destination, mask: 32, type: 'host' };
}

// ================= ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ =================
let db = null;
let syncInProgress = false;
let lastSyncTime = null;
let lastSyncResult = null;
let autoSyncInterval = null;

// ================= ФУНКЦИИ РАБОТЫ С СИСТЕМОЙ =================

// Получение всех маршрутов из системы через указанный шлюз
async function getSystemRoutes() {
    try {
        const { stdout } = await execFilePromise('ip', ['route', 'show']);
        const routes = stdout.trim().split('\n').filter(line => line.length > 0);

        return routes
            .map(parseSystemRouteLine)
            .filter(route => route !== null);
    } catch (error) {
        if (error.stdout === '') {
            return []; // Нет маршрутов
        }
        logger.error('Error getting system routes', { error: error.message });
        throw error;
    }
}

// Проверка существования маршрута в системе
async function routeExistsInSystem(ip, mask) {
    try {
        const routes = await getSystemRoutes();
        return routes.some(route => route.ip === ip && route.mask === mask);
    } catch (error) {
        return false;
    }
}

// Добавление маршрута в систему
async function addRouteToSystem(ip, mask) {
    try {
        if (isRouteBlocked(ip)) {
            return { success: false, blocked: true, message: blockedRouteMessage(ip, mask) };
        }

        const exists = await routeExistsInSystem(ip, mask);
        if (exists) {
            return { success: true, changed: false, message: `Route ${formatRoute(ip, mask)} already exists in system` };
        }

        await execFilePromise('ip', buildIpRouteArgs('add', ip, mask));
        logger.debug(`Route added to system: ${formatRoute(ip, mask)}`);
        return { success: true, changed: true, message: `Route ${formatRoute(ip, mask)} added to system` };
    } catch (error) {
        logger.error(`Failed to add route to system: ${ip}/${mask}`, { error: error.message });
        return { success: false, message: error.message };
    }
}

// Удаление маршрута из системы
async function deleteRouteFromSystem(ip, mask) {
    try {
        if (isRouteBlocked(ip)) {
            return { success: false, blocked: true, message: blockedRouteMessage(ip, mask) };
        }

        const exists = await routeExistsInSystem(ip, mask);
        if (!exists) {
            return { success: true, changed: false, message: `Route ${formatRoute(ip, mask)} not found in system` };
        }

        await execFilePromise('ip', buildIpRouteArgs('del', ip, mask));
        logger.debug(`Route deleted from system: ${formatRoute(ip, mask)}`);
        return { success: true, changed: true, message: `Route ${formatRoute(ip, mask)} deleted from system` };
    } catch (error) {
        logger.error(`Failed to delete route from system: ${ip}/${mask}`, { error: error.message });
        return { success: false, message: error.message };
    }
}

// ================= ФУНКЦИИ РАБОТЫ С MYSQL =================

// Инициализация подключения к БД
async function initDatabase() {
    try {
        db = await mysql.createConnection({
            host: CONFIG.mysql.host,
            user: CONFIG.mysql.user,
            password: CONFIG.mysql.password,
            database: CONFIG.mysql.database,
            connectionLimit: 5,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0
        });
        
        // Создаем таблицу если её нет
        await db.execute(`
            CREATE TABLE IF NOT EXISTS ${CONFIG.mysql.table} (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ip VARCHAR(15) NOT NULL,
                mask VARCHAR(2) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_route (ip, mask),
                INDEX idx_ip (ip)
            )
        `);
        
        logger.info('Database connected and ready');
    } catch (error) {
        logger.error('Database connection failed', { error: error.message });
        throw error;
    }
}

// Получение всех маршрутов из MySQL
// mask = NULL или '' означает хост (/32)
async function getMysqlRoutes() {
    try {
        const [rows] = await db.execute(
            `SELECT ip, mask FROM ${CONFIG.mysql.table} ORDER BY ip, mask`
        );
        return rows.map(row => {
            // Если mask = NULL или пустая строка - это хост (маска 32)
            const isHost = row.mask === null || row.mask === '';
            return {
                ip: row.ip,
                mask: isHost ? 32 : parseInt(row.mask),
                originalMask: row.mask
            };
        });
    } catch (error) {
        logger.error('Error fetching MySQL routes', { error: error.message });
        throw error;
    }
}

// Проверка существования маршрута в MySQL
async function routeExistsInMysql(ip, mask) {
    try {
        let query;
        let params;
        
        if (mask === 32) {
            // Хост: ищем где mask IS NULL или mask = '' или mask = '32'
            query = `SELECT COUNT(*) as count FROM ${CONFIG.mysql.table} 
                     WHERE ip = ? AND (mask IS NULL OR mask = '' OR mask = '32')`;
            params = [ip];
        } else {
            // Сеть: ищем точное совпадение mask
            query = `SELECT COUNT(*) as count FROM ${CONFIG.mysql.table} 
                     WHERE ip = ? AND mask = ?`;
            params = [ip, mask.toString()];
        }
        
        const [rows] = await db.execute(query, params);
        return rows[0].count > 0;
    } catch (error) {
        logger.error('Error checking route in MySQL', { ip, mask, error: error.message });
        return false;
    }
}

// Добавление маршрута в MySQL
// Для хостов mask сохраняем как NULL
async function addRouteToMysql(ip, mask) {
    try {
        if (isRouteBlocked(ip)) {
            return { success: false, blocked: true, message: blockedRouteMessage(ip, mask) };
        }

        let maskValue;
        let maskDisplay;
        
        if (mask === 32) {
            // Хост: сохраняем как NULL
            maskValue = null;
            maskDisplay = 'хост';
        } else {
            // Сеть: сохраняем как строку
            maskValue = mask.toString();
            maskDisplay = mask;
        }
        
        const exists = await routeExistsInMysql(ip, mask);
        if (exists) {
            return { success: true, changed: false, message: `Route ${formatRoute(ip, mask)} already exists in MySQL` };
        }

        await db.execute(
            `INSERT INTO ${CONFIG.mysql.table} (ip, mask) VALUES (?, ?)`,
            [ip, maskValue]
        );
        logger.debug(`Route added to MySQL: ${ip} (${maskDisplay})`);
        return { success: true, changed: true, message: `Route ${formatRoute(ip, mask)} added to MySQL` };
    } catch (error) {
        logger.error(`Failed to add route to MySQL: ${ip}/${mask}`, { error: error.message });
        return { success: false, message: error.message };
    }
}

// Удаление маршрута из MySQL
async function deleteRouteFromMysql(ip, mask) {
    if (isRouteBlocked(ip)) {
        return { success: false, blocked: true, message: blockedRouteMessage(ip, mask) };
    }

    let maskCondition;
    let params;

    if (mask === 32) {
        maskCondition = '(mask IS NULL OR mask = "" OR mask = "32")';
        params = [ip];
    } else {
        maskCondition = 'mask = ?';
        params = [ip, mask.toString()];
    }

    try {
        const [result] = await db.execute(
            `DELETE FROM ${CONFIG.mysql.table} 
             WHERE ip = ? AND ${maskCondition}`,
            params
        );

        if (result.affectedRows > 0) {
            return { success: true, changed: true, message: `Route ${formatRoute(ip, mask)} removed from MySQL` };
        }

        return { success: true, changed: false, message: `Route ${formatRoute(ip, mask)} not found in MySQL` };
    } catch (error) {
        logger.error(`Failed to delete route from MySQL: ${ip}/${mask}`, { error: error.message });
        return { success: false, message: error.message };
    }
}

// ================= ОСНОВНАЯ ЛОГИКА СИНХРОНИЗАЦИИ =================

async function syncRoutes() {
    if (syncInProgress) {
        logger.warn('Sync already in progress, skipping');
        return {
            success: false,
            message: 'Sync already in progress',
            result: lastSyncResult
        };
    }
    
    syncInProgress = true;
    const startTime = Date.now();
    const result = {
        startTime: new Date().toISOString(),
        addedToSystem: [],
        skippedBlocked: [],
        errors: []
    };
    
    try {
        logger.info('Starting synchronization...');
        
        // MySQL -> system: MySQL is the source of truth.
        logger.debug('Checking MySQL routes for system...');
        const mysqlRoutes = await getMysqlRoutes();
        logger.debug(`Found ${mysqlRoutes.length} routes in MySQL`);
        
        for (const route of mysqlRoutes) {
            try {
                if (isRouteBlocked(route.ip)) {
                    result.skippedBlocked.push(formatRoute(route.ip, route.mask));
                    logger.warn(`Skipping blocked MySQL route: ${formatRoute(route.ip, route.mask)}`);
                    continue;
                }

                const exists = await routeExistsInSystem(route.ip, route.mask);
                if (!exists) {
                    logger.info(`Adding to system: ${formatRoute(route.ip, route.mask)}`);
                    const addResult = await addRouteToSystem(route.ip, route.mask);
                    if (addResult.success) {
                        result.addedToSystem.push(formatRoute(route.ip, route.mask));
                    } else {
                        result.errors.push(`System add failed for ${route.ip}: ${addResult.message}`);
                    }
                }
            } catch (error) {
                result.errors.push(`Error checking ${route.ip} in system: ${error.message}`);
            }
        }
        
        result.endTime = new Date().toISOString();
        result.duration = Date.now() - startTime;
        result.success = true;
        result.message = `Sync completed in ${result.duration}ms`;
        
        logger.info(`Sync completed: +${result.addedToSystem.length} to system, ${result.skippedBlocked.length} blocked`);
        
    } catch (error) {
        result.success = false;
        result.message = error.message;
        result.errors.push(error.message);
        logger.error('Sync failed', { error: error.message });
    } finally {
        syncInProgress = false;
        lastSyncTime = new Date();
        lastSyncResult = result;
    }
    
    return result;
}

// ================= API С ФУНКЦИЕЙ АУТЕНТИФИКАЦИИ =================

function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== CONFIG.apiKey) {
        logger.warn('Unauthorized API access attempt', { ip: req.ip });
        return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }
    
    next();
}

function startApi() {
    const app = express();
    app.use(express.json());
    
    // Логирование запросов
    app.use((req, res, next) => {
        logger.debug(`${req.method} ${req.path}`, { ip: req.ip });
        next();
    });
    
    // Публичный эндпоинт для проверки здоровья (без аутентификации)
    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            service: 'route-sync',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });
    
    // Все остальные эндпоинты требуют аутентификации
    app.use('/api', authenticate);
    
    // Получение статуса
    app.get('/api/status', async (req, res) => {
        try {
            const systemRoutes = await getSystemRoutes();
            const mysqlRoutes = await getMysqlRoutes();
            
            res.json({
                service: 'route-sync',
                status: 'running',
                syncInProgress,
                lastSyncTime: lastSyncTime?.toISOString(),
                lastSyncResult: lastSyncResult,
                config: {
                    targetGw: CONFIG.targetGw,
                    routeInterface: CONFIG.routeInterface || null,
                    blockedRouteCidrs: CONFIG.blockedRoutes.map(route => route.cidr),
                    autoSyncEnabled: CONFIG.autoSyncEnabled,
                    syncInterval: CONFIG.syncInterval
                },
                stats: {
                    systemRoutes: systemRoutes.length,
                    mysqlRoutes: mysqlRoutes.length,
                    routes: {
                        system: systemRoutes.map(r => ({
                            ip: r.ip,
                            mask: r.mask === 32 ? 'хост' : r.mask
                        })),
                        mysql: mysqlRoutes.map(r => ({
                            ip: r.ip,
                            mask: r.mask === 32 ? 'хост' : r.mask
                        }))
                    }
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Запуск синхронизации вручную
    app.post('/api/sync', async (req, res) => {
        const result = await syncRoutes();
        res.json(result);
    });
    
    // Получение всех маршрутов (объединенный список)
    app.get('/api/routes', async (req, res) => {
        try {
            const systemRoutes = await getSystemRoutes();
            const mysqlRoutes = await getMysqlRoutes();
            
            // Объединяем уникальные маршруты
            const allRoutes = new Map();
            
            systemRoutes.forEach(route => {
                const key = routeKey(route.ip, route.mask);
                allRoutes.set(key, {
                    ip: route.ip,
                    mask: route.mask === 32 ? 'хост' : route.mask,
                    source: 'system'
                });
            });
            
            mysqlRoutes.forEach(route => {
                const key = routeKey(route.ip, route.mask);
                if (allRoutes.has(key)) {
                    allRoutes.get(key).source = 'both';
                } else {
                    allRoutes.set(key, {
                        ip: route.ip,
                        mask: route.mask === 32 ? 'хост' : route.mask,
                        source: 'mysql'
                    });
                }
            });
            
            res.json({
                total: allRoutes.size,
                routes: Array.from(allRoutes.values())
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Добавление маршрута вручную
    app.post('/api/routes', async (req, res) => {
        const { ip, mask } = req.body;
        
        if (!isValidIpv4(ip)) {
            return res.status(400).json({ error: 'Invalid IP address' });
        }

        const routeMask = parseRouteMask(mask);
        if (routeMask === null) {
            return res.status(400).json({ error: 'Mask must be between 0 and 32 or "хост"/"host"' });
        }

        if (isRouteBlocked(ip)) {
            return res.status(400).json({ error: blockedRouteMessage(ip, routeMask) });
        }
        
        const mysqlResult = await addRouteToMysql(ip, routeMask);
        const systemResult = await addRouteToSystem(ip, routeMask);
        
        res.status(mysqlResult.success && systemResult.success ? 200 : 207).json({
            route: { ip, mask: routeMask === 32 ? 'хост' : routeMask },
            mysql: mysqlResult,
            system: systemResult
        });
    });
    
    // Удаление маршрута. По умолчанию удаляем только из MySQL, чтобы не ломать старое поведение API.
    app.delete('/api/routes', async (req, res) => {
        const { ip, mask, from = 'mysql' } = req.body;
        
        if (!isValidIpv4(ip)) {
            return res.status(400).json({ error: 'Invalid IP address' });
        }

        const routeMask = parseRouteMask(mask);
        if (routeMask === null) {
            return res.status(400).json({ error: 'Mask must be between 0 and 32 or "хост"/"host"' });
        }

        if (isRouteBlocked(ip)) {
            return res.status(400).json({ error: blockedRouteMessage(ip, routeMask) });
        }

        if (!['mysql', 'system', 'both'].includes(from)) {
            return res.status(400).json({ error: 'from must be "mysql", "system" or "both"' });
        }

        const mysqlResult = from === 'mysql' || from === 'both'
            ? await deleteRouteFromMysql(ip, routeMask)
            : { success: true, skipped: true, message: 'MySQL delete skipped' };
        const systemResult = from === 'system' || from === 'both'
            ? await deleteRouteFromSystem(ip, routeMask)
            : { success: true, skipped: true, message: 'System delete skipped' };

        res.status(mysqlResult.success && systemResult.success ? 200 : 207).json({
            route: { ip, mask: routeMask === 32 ? 'хост' : routeMask },
            mysql: mysqlResult,
            system: systemResult
        });
    });
    
    // Запуск сервера
    app.listen(CONFIG.apiPort, () => {
        logger.info(`API server running on port ${CONFIG.apiPort}`);
    });
}

// ================= ЗАПУСК =================

async function main() {
    logger.info('Starting Route Sync Service...');
    logger.debug('Configuration loaded', {
        dbHost: CONFIG.mysql.host,
        dbName: CONFIG.mysql.database,
        targetGw: CONFIG.targetGw,
        routeInterface: CONFIG.routeInterface || null,
        blockedRouteCidrs: CONFIG.blockedRoutes.map(route => route.cidr),
        apiPort: CONFIG.apiPort,
        autoSyncEnabled: CONFIG.autoSyncEnabled,
        syncInterval: CONFIG.syncInterval
    });
    
    // Инициализация БД
    await initDatabase();
    
    // Запуск API
    startApi();
    
    // Автоматическая синхронизация (если включена)
    if (CONFIG.autoSyncEnabled && CONFIG.syncInterval > 0) {
        autoSyncInterval = setInterval(async () => {
            await syncRoutes();
        }, CONFIG.syncInterval);
        logger.info(`Auto-sync enabled (interval: ${CONFIG.syncInterval}ms)`);
    } else {
        logger.info('Auto-sync disabled');
    }
    
    // Первый запуск синхронизации
    await syncRoutes();
    
    logger.info('Service started successfully');
}

// Обработка сигналов завершения
process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    if (db) await db.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    if (db) await db.end();
    process.exit(0);
});

// Запуск
main().catch(error => {
    logger.error('Fatal error', { error: error.message });
    process.exit(1);
});
