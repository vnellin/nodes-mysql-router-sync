# MySQL Router Sync Service

Node.js сервис для синхронизации сетевых маршрутов между таблицей маршрутизации ядра Linux и базой данных MySQL. Сервис обеспечивает двунаправленную синхронизацию и предоставляет REST API для управления маршрутами.

## Возможности

- **Двунаправленная синхронизация**: Автоматическая синхронизация маршрутов между системой и MySQL
- **REST API**: HTTP API для ручного управления маршрутами и мониторинга
- **Автосинхронизация**: Настраиваемая периодическая автоматическая синхронизация
- **Логирование**: Настраиваемые уровни логирования (debug, info, warn, error)
- **Проверка здоровья**: Встроенный эндпоинт для мониторинга состояния
- **Аутентификация**: Аутентификация по API-ключу для защищенных эндпоинтов

## Требования

- Node.js 14+
- MySQL 5.7+
- Linux система с доступной командой `ip`
- Привилегии root/sudo для управления маршрутами

## Установка

1. Клонируйте репозиторий:
   ```bash
   git clone <repository-url>
   cd mysql-router
   ```

2. Установите зависимости:
   ```bash
   npm install
   ```

3. Скопируйте конфигурацию окружения:
   ```bash
   cp .env.example .env
   ```

4. Отредактируйте файл `.env` с вашей конфигурацией:
   ```bash
   nano .env
   ```

## Конфигурация

Отредактируйте файл `.env` с вашими настройками:

```env
# Конфигурация MySQL
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=ваш_пароль
DB_NAME=routes_db
DB_TABLE=routes

# Конфигурация маршрутизации
TARGET_GW=10.8.1.1

# Конфигурация API
API_PORT=3000
API_KEY=ваш-безопасный-api-ключ

# Конфигурация синхронизации
SYNC_INTERVAL_MS=60000
AUTO_SYNC_ENABLED=true

# Логирование (debug, info, warn, error)
LOG_LEVEL=info
```

### Переменные окружения

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `DB_HOST` | Адрес хоста MySQL | localhost |
| `DB_USER` | Имя пользователя MySQL | root |
| `DB_PASSWORD` | Пароль MySQL | (обязательно) |
| `DB_NAME` | Имя базы данных | routes_db |
| `DB_TABLE` | Имя таблицы маршрутов | routes |
| `TARGET_GW` | Целевой шлюз для маршрутов | (обязательно) |
| `API_PORT` | Порт HTTP API | 3000 |
| `API_KEY` | API-ключ для аутентификации | (обязательно) |
| `SYNC_INTERVAL_MS` | Интервал автосинхронизации в миллисекундах | 60000 |
| `AUTO_SYNC_ENABLED` | Включить автоматическую синхронизацию | true |
| `LOG_LEVEL` | Уровень логирования | info |

## Настройка базы данных

Сервис автоматически создаст необходимую таблицу, если она не существует:

```sql
CREATE TABLE routes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip VARCHAR(15) NOT NULL,
    mask VARCHAR(2) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_route (ip, mask),
    INDEX idx_ip (ip)
);
```

## Использование

### Запуск сервиса

```bash
# Сделайте скрипт исполняемым
chmod +x router.js

# Запустите сервис
./router.js

# Или используйте node напрямую
node router.js
```

### Запуск как системного сервиса

Создайте файл сервиса systemd `/etc/systemd/system/mysql-router.service`:

```ini
[Unit]
Description=MySQL Router Sync Service
After=network.target mysql.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/mysql-router
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /path/to/mysql-router/router.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Включите и запустите сервис:
```bash
sudo systemctl daemon-reload
sudo systemctl enable mysql-router
sudo systemctl start mysql-router
```

## Справочник API

### Аутентификация
Все эндпоинты API, кроме `/api/health`, требуют аутентификации через заголовок `X-API-Key`.

### Эндпоинты

#### GET `/api/health`
Публичный эндпоинт проверки здоровья.

**Ответ:**
```json
{
  "status": "ok",
  "service": "route-sync",
  "timestamp": "2024-01-01T12:00:00Z",
  "uptime": 3600
}
```

#### GET `/api/status`
Получение статуса сервиса и статистики.

**Заголовки:**
- `X-API-Key: ваш-api-ключ`

**Ответ:**
```json
{
  "service": "route-sync",
  "status": "running",
  "syncInProgress": false,
  "lastSyncTime": "2024-01-01T12:00:00Z",
  "lastSyncResult": {...},
  "config": {...},
  "stats": {...}
}
```

#### POST `/api/sync`
Запуск ручной синхронизации.

**Заголовки:**
- `X-API-Key: ваш-api-ключ`

**Ответ:**
```json
{
  "startTime": "2024-01-01T12:00:00Z",
  "addedToSystem": ["10.0.0.0/24", "192.168.1.1 (хост)"],
  "addedToMysql": ["172.16.0.0/16"],
  "errors": [],
  "endTime": "2024-01-01T12:00:01Z",
  "duration": 1000,
  "success": true,
  "message": "Sync completed in 1000ms"
}
```

#### GET `/api/routes`
Получение всех маршрутов из системы и MySQL.

**Заголовки:**
- `X-API-Key: ваш-api-ключ`

**Ответ:**
```json
{
  "total": 5,
  "routes": [
    {
      "ip": "10.0.0.0",
      "mask": 24,
      "source": "both"
    },
    {
      "ip": "192.168.1.1",
      "mask": "хост",
      "source": "system"
    }
  ]
}
```

#### POST `/api/routes`
Добавление нового маршрута в систему и MySQL.

**Заголовки:**
- `X-API-Key: ваш-api-ключ`
- `Content-Type: application/json`

**Тело запроса:**
```json
{
  "ip": "10.0.0.0",
  "mask": 24
}
```

**Примечание:** Для маршрутов хостов используйте `mask: "хост"`, `mask: "host"` или опустите mask.

**Ответ:**
```json
{
  "mysql": {
    "success": true,
    "message": "Route 10.0.0.0 (24) added to MySQL"
  },
  "system": {
    "success": true,
    "message": "Route 10.0.0.0/24 added"
  }
}
```

#### DELETE `/api/routes`
Удаление маршрута из MySQL (не удаляет из системы).

**Заголовки:**
- `X-API-Key: ваш-api-ключ`
- `Content-Type: application/json`

**Тело запроса:**
```json
{
  "ip": "10.0.0.0",
  "mask": 24
}
```

**Ответ:**
```json
{
  "success": true,
  "message": "Route 10.0.0.0 (24) removed from MySQL"
}
```

## Формат маршрутов

### Сетевые маршруты
- Формат: `IP_АДРЕС/МАСКА`
- Пример: `10.0.0.0/24`
- В API: `{"ip": "10.0.0.0", "mask": 24}`

### Маршруты хостов
- Формат: `IP_АДРЕС` (неявная маска /32)
- Пример: `192.168.1.1`
- В API: `{"ip": "192.168.1.1", "mask": "хост"}` или `{"ip": "192.168.1.1"}`

## Логика синхронизации

Сервис выполняет двунаправленную синхронизацию:

1. **Система → MySQL**: Маршруты, присутствующие в системе, но отсутствующие в MySQL, добавляются в базу данных
2. **MySQL → Система**: Маршруты, присутствующие в MySQL, но отсутствующие в системе, добавляются в таблицу маршрутизации

Маршруты синхронизируются через настроенный целевой шлюз (`TARGET_GW`).

## Логирование

Уровни логирования можно настроить через переменную окружения `LOG_LEVEL`:
- `debug`: Подробная отладочная информация
- `info`: Общая информация о сервисе (по умолчанию)
- `warn`: Предупреждающие сообщения
- `error`: Только сообщения об ошибках

## Устранение неполадок

### Распространенные проблемы

1. **Permission denied для операций с маршрутами**
   - Убедитесь, что сервис запущен с привилегиями root/sudo
   - Проверьте доступность команды `ip route`

2. **Ошибки подключения к MySQL**
   - Проверьте учетные данные MySQL в `.env`
   - Убедитесь, что сервер MySQL запущен
   - Проверьте, что у пользователя есть необходимые права

3. **Сбои аутентификации API**
   - Убедитесь, что заголовок `X-API-Key` установлен правильно
   - Проверьте, что API-ключ соответствует конфигурации в `.env`

4. **Маршруты не синхронизируются**
   - Проверьте настройку `AUTO_SYNC_ENABLED`
   - Убедитесь, что `SYNC_INTERVAL_MS` > 0
   - Проверьте логи на наличие ошибок синхронизации

### Проверка статуса сервиса

```bash
# Проверка логов сервиса
journalctl -u mysql-router -f

# Тест эндпоинта проверки здоровья
curl http://localhost:3000/api/health

# Тест API с аутентификацией
curl -H "X-API-Key: ваш-api-ключ" http://localhost:3000/api/status
```

## Вопросы безопасности

1. **API-ключ**: Используйте надежный уникальный API-ключ в production
2. **Учетные данные БД**: Храните учетные данные MySQL безопасно
3. **Сетевой доступ**: Ограничьте доступ к API доверенным сетям
4. **Привилегии**: Запускайте сервис с минимально необходимыми привилегиями
5. **Логи**: Мониторьте логи на попытки несанкционированного доступа

## Разработка

### Структура проекта
```
mysql-router/
├── router.js          # Основное приложение
├── package.json       # Зависимости
├── .env.example       # Пример конфигурации
├── .env               # Локальная конфигурация (игнорируется git)
└── README.md          # Этот файл
```

### Зависимости
- `express`: HTTP серверный фреймворк
- `mysql2`: Клиент базы данных MySQL
- `dotenv`: Управление переменными окружения

### Тестирование
В настоящее время автоматические тесты отсутствуют. Ручное тестирование можно выполнять через эндпоинты API.

## Лицензия

ISC License