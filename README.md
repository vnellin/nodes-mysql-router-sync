# MySQL Router Sync Service

Node.js сервис для синхронизации сетевых маршрутов из базы данных MySQL в таблицу маршрутизации ядра Linux. Сервис использует MySQL как источник истины и предоставляет REST API для управления маршрутами.

## Возможности

- **Односторонняя синхронизация**: Автоматическое добавление в систему маршрутов из MySQL
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
ROUTE_INTERFACE=tun0
BLOCKED_ROUTE_CIDRS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16

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
| `ROUTE_INTERFACE` | Интерфейс для маршрутов (`dev`), можно оставить пустым | (пусто) |
| `BLOCKED_ROUTE_CIDRS` | CIDR-диапазоны, которые сервис не добавляет, не удаляет и не синхронизирует | 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16 |
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
  "addedToSystem": ["203.0.113.0/24", "198.51.100.10 (хост)"],
  "skippedBlocked": [],
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
      "ip": "203.0.113.0",
      "mask": 24,
      "source": "both"
    },
    {
      "ip": "198.51.100.10",
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
  "ip": "203.0.113.0",
  "mask": 24
}
```

**Примечание:** Для маршрутов хостов используйте `mask: "хост"`, `mask: "host"` или опустите mask.

**Ответ:**
```json
{
  "route": {
    "ip": "203.0.113.0",
    "mask": 24
  },
  "mysql": {
    "success": true,
    "changed": true,
    "message": "Route 203.0.113.0/24 added to MySQL"
  },
  "system": {
    "success": true,
    "changed": true,
    "message": "Route 203.0.113.0/24 added to system"
  }
}
```

#### DELETE `/api/routes`
Удаление маршрута. По умолчанию удаляет только из MySQL, чтобы сохранить старое безопасное поведение. Для удаления из системы передайте `from: "system"`, для удаления из обоих источников - `from: "both"`.

**Заголовки:**
- `X-API-Key: ваш-api-ключ`
- `Content-Type: application/json`

**Тело запроса:**
```json
{
  "ip": "203.0.113.0",
  "mask": 24,
  "from": "both"
}
```

**Ответ:**
```json
{
  "route": {
    "ip": "203.0.113.0",
    "mask": 24
  },
  "mysql": {
    "success": true,
    "changed": true,
    "message": "Route 203.0.113.0/24 removed from MySQL"
  },
  "system": {
    "success": true,
    "changed": true,
    "message": "Route 203.0.113.0/24 deleted from system"
  }
}
```

## Формат маршрутов

### Сетевые маршруты
- Формат: `IP_АДРЕС/МАСКА`
- Пример: `203.0.113.0/24`
- В API: `{"ip": "203.0.113.0", "mask": 24}`

### Маршруты хостов
- Формат: `IP_АДРЕС` (неявная маска /32)
- Пример: `198.51.100.10`
- В API: `{"ip": "198.51.100.10", "mask": "хост"}` или `{"ip": "198.51.100.10"}`

## Логика синхронизации

Сервис выполняет одностороннюю синхронизацию:

1. **MySQL → Система**: Маршруты, присутствующие в MySQL, но отсутствующие в системе, добавляются в таблицу маршрутизации
2. **Система → MySQL не выполняется**: Сервис не импортирует маршруты из ядра Linux обратно в базу данных

Маршруты синхронизируются через настроенный целевой шлюз (`TARGET_GW`).
Если задан `ROUTE_INTERFACE`, системные маршруты добавляются и удаляются с `dev <интерфейс>`, а при чтении учитываются только маршруты через этот интерфейс.
Маршруты из `BLOCKED_ROUTE_CIDRS` пропускаются при синхронизации и отклоняются в ручных `POST /api/routes` и `DELETE /api/routes`.

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
