#!/usr/bin/env node

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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
    apiPort: parseInt(process.env.API_PORT),
    apiKey: process.env.API_KEY,
    syncInterval: parseInt(process.env.SYNC_INTERVAL_MS) || 60000,
    autoSyncEnabled: process.env.AUTO_SYNC_ENABLED !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info'
};

// ================= ЛОГГЕР =================
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[CONFIG.logLevel] || LOG_LEVELS.info;

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
        const { stdout } = await execPromise(`ip route show | grep "via ${CONFIG.targetGw}"`);
        const routes = stdout.trim().split('\n').filter(line => line.length > 0);
        
        return routes.map(route => {
            const parts = route.trim().split(/\s+/);
            const destination = parts[0];
            
            if (destination.includes('/')) {
                const [ip, mask] = destination.split('/');
                return { ip, mask: parseInt(mask), type: 'network' };
            } else {
                // Хост - маска 32
                return { ip: destination, mask: 32, type: 'host' };
            }
        });
    } catch (error) {
        if (error.stdout === '' && error.stderr === '') {
            return []; // Нет маршрутов
        }
        logger.error('Error getting system routes', { error: error.message });
        throw error;
    }
}

// Проверка существования маршрута в системе
async function routeExistsInSystem(ip, mask) {
    try {
        if (mask === 32) {
            // Хост
            const { stdout } = await execPromise(`ip route show | grep "^${ip} via ${CONFIG.targetGw}"`);
            return stdout.trim().length > 0;
        } else {
            // Сеть
            const { stdout } = await execPromise(`ip route show | grep "^${ip}/${mask} via ${CONFIG.targetGw}"`);
            return stdout.trim().length > 0;
        }
    } catch (error) {
        return false;
    }
}

// Добавление маршрута в систему
async function addRouteToSystem(ip, mask) {
    try {
        let cmd;
        if (mask === 32) {
            // Хост
            cmd = `ip route add ${ip} via ${CONFIG.targetGw}`;
        } else {
            // Сеть
            cmd = `ip route add ${ip}/${mask} via ${CONFIG.targetGw}`;
        }
        
        await execPromise(cmd);
        logger.debug(`Route added to system: ${ip}/${mask === 32 ? 'хост' : mask}`);
        return { success: true, message: `Route ${ip}/${mask === 32 ? 'host' : mask} added` };
    } catch (error) {
        logger.error(`Failed to add route to system: ${ip}/${mask}`, { error: error.message });
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
        
        await db.execute(
            `INSERT IGNORE INTO ${CONFIG.mysql.table} (ip, mask) VALUES (?, ?)`,
            [ip, maskValue]
        );
        logger.debug(`Route added to MySQL: ${ip} (${maskDisplay})`);
        return { success: true, message: `Route ${ip} (${maskDisplay}) added to MySQL` };
    } catch (error) {
        logger.error(`Failed to add route to MySQL: ${ip}/${mask}`, { error: error.message });
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
        addedToMysql: [],
        errors: []
    };
    
    try {
        logger.info('Starting synchronization...');
        
        // ШАГ 1: Добавляем в MySQL маршруты из системы, которых нет в MySQL
        logger.debug('Step 1: Checking system routes for MySQL...');
        const systemRoutes = await getSystemRoutes();
        logger.debug(`Found ${systemRoutes.length} routes in system`);
        
        for (const route of systemRoutes) {
            try {
                const exists = await routeExistsInMysql(route.ip, route.mask);
                if (!exists) {
                    const maskDisplay = route.mask === 32 ? 'хост' : route.mask;
                    logger.info(`Adding to MySQL: ${route.ip} (${maskDisplay})`);
                    const addResult = await addRouteToMysql(route.ip, route.mask);
                    if (addResult.success) {
                        result.addedToMysql.push(`${route.ip} (${maskDisplay})`);
                    } else {
                        result.errors.push(`MySQL add failed for ${route.ip}: ${addResult.message}`);
                    }
                }
            } catch (error) {
                result.errors.push(`Error checking ${route.ip} in MySQL: ${error.message}`);
            }
        }
        
        // ШАГ 2: Добавляем в систему маршруты из MySQL, которых нет в системе
        logger.debug('Step 2: Checking MySQL routes for system...');
        const mysqlRoutes = await getMysqlRoutes();
        logger.debug(`Found ${mysqlRoutes.length} routes in MySQL`);
        
        for (const route of mysqlRoutes) {
            try {
                const exists = await routeExistsInSystem(route.ip, route.mask);
                if (!exists) {
                    const maskDisplay = route.mask === 32 ? 'хост' : route.mask;
                    logger.info(`Adding to system: ${route.ip} (${maskDisplay})`);
                    const addResult = await addRouteToSystem(route.ip, route.mask);
                    if (addResult.success) {
                        result.addedToSystem.push(`${route.ip} (${maskDisplay})`);
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
        
        logger.info(`Sync completed: +${result.addedToMysql.length} to MySQL, +${result.addedToSystem.length} to system`);
        
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
                const key = `${route.ip}|${route.mask}`;
                allRoutes.set(key, {
                    ip: route.ip,
                    mask: route.mask === 32 ? 'хост' : route.mask,
                    source: 'system'
                });
            });
            
            mysqlRoutes.forEach(route => {
                const key = `${route.ip}|${route.mask}`;
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
        
        if (!ip || !ip.match(/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/)) {
            return res.status(400).json({ error: 'Invalid IP address' });
        }
        
        let routeMask;
        if (mask === 'хост' || mask === 'host' || mask === null || mask === '') {
            routeMask = 32;
        } else {
            routeMask = parseInt(mask);
            if (isNaN(routeMask) || routeMask < 0 || routeMask > 32) {
                return res.status(400).json({ error: 'Mask must be between 0 and 32 or "хост"/"host"' });
            }
        }
        
        // Добавляем в MySQL
        const mysqlResult = await addRouteToMysql(ip, routeMask);
        
        // Добавляем в систему
        const systemResult = await addRouteToSystem(ip, routeMask);
        
        res.json({
            mysql: mysqlResult,
            system: systemResult
        });
    });
    
    // Удаление маршрута (только из MySQL, не из системы)
    app.delete('/api/routes', async (req, res) => {
        const { ip, mask } = req.body;
        
        if (!ip) {
            return res.status(400).json({ error: 'IP required' });
        }
        
        let routeMask;
        let maskCondition;
        let params;
        
        if (mask === 'хост' || mask === 'host' || mask === null || mask === '' || mask === 32) {
            // Удаляем хост
            maskCondition = '(mask IS NULL OR mask = "" OR mask = "32")';
            params = [ip];
            routeMask = 'хост';
        } else {
            // Удаляем сеть с конкретной маской
            maskCondition = 'mask = ?';
            params = [ip, mask.toString()];
            routeMask = mask;
        }
        
        try {
            const [result] = await db.execute(
                `DELETE FROM ${CONFIG.mysql.table} 
                 WHERE ip = ? AND ${maskCondition}`,
                params
            );
            
            if (result.affectedRows > 0) {
                res.json({ success: true, message: `Route ${ip} (${routeMask}) removed from MySQL` });
            } else {
                res.json({ success: false, message: `Route ${ip} (${routeMask}) not found in MySQL` });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
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