#!/usr/bin/env node
'use strict';

/**
 * ===== DUMMY DATA GENERATOR =====
 * Генерирует тестовые файлы разных размеров для демонстрации PoC
 * визуального пайплайна передачи данных через экран.
 *
 * Режимы:
 *   allure  — имитация allure-results (структура папок, JSON, attachments)
 *   random  — случайные бинарные файлы
 *   text    — текстовые файлы (логи, CSV)
 *
 * Использование:
 *   node generate-dummies.js                          # все пресеты
 *   node generate-dummies.js --size 1MB --type random # конкретный размер
 *   node generate-dummies.js --size 50KB --type allure
 *   node generate-dummies.js --list                   # показать пресеты
 *   node generate-dummies.js --output ./my-dummies    # указать папку
 *
 * Пресеты размеров (без --size):
 *   tiny    10 KB   — быстрый smoke-тест (1-2 фрейма Q4)
 *   small   50 KB   — минимальный Allure-отчёт (~6 фреймов Q4)
 *   medium  500 KB  — типичный мини-отчёт (~54 фрейма Q4)
 *   large   5 MB    — средний Allure-отчёт (~540 фреймов Q4, ~5 мин)
 *   xlarge  50 MB   — полноценный отчёт (~5400 фреймов Q4, ~45 мин)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ── Parse args ──────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name) {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function hasFlag(name) {
    return args.includes('--' + name);
}

const PRESETS = [
    { name: 'tiny', rawSize: 10 * 1024, desc: '10 KB — smoke-тест (1-2 фрейма Q4)' },
    { name: 'small', rawSize: 50 * 1024, desc: '50 KB — мини Allure (~6 фреймов Q4)' },
    { name: 'medium', rawSize: 500 * 1024, desc: '500 KB — типичный мини-отчёт (~54 фрейма Q4)' },
    { name: 'large', rawSize: 5 * 1024 * 1024, desc: '5 MB — средний отчёт (~540 фреймов Q4, ~5 мин)' },
    { name: 'xlarge', rawSize: 50 * 1024 * 1024, desc: '50 MB — полный отчёт (~5400 фреймов Q4, ~45 мин)' },
];

if (hasFlag('list') || hasFlag('help') || hasFlag('h')) {
    console.log('Dummy Data Generator для PoC визуального пайплайна\n');
    console.log('Использование:');
    console.log('  node generate-dummies.js                          # все пресеты');
    console.log('  node generate-dummies.js --size 1MB --type random # конкретный');
    console.log('  node generate-dummies.js --preset medium          # один пресет');
    console.log('  node generate-dummies.js --output ./my-dummies    # папка вывода\n');
    console.log('Пресеты:');
    for (const p of PRESETS) console.log(`  ${p.name.padEnd(8)} ${p.desc}`);
    console.log('\nТипы: allure, random, text');
    console.log('Размеры: 10KB, 500KB, 1MB, 5MB, 50MB и т.д.');
    process.exit(0);
}

const outputDir = getArg('output') || path.join(path.dirname(process.argv[1]), '..', 'dummies');
const requestedType = getArg('type') || 'allure';
const requestedSize = getArg('size');
const requestedPreset = getArg('preset');

// ── Size parser ─────────────────────────────────────────
function parseSize(s) {
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
    if (!m) {
        console.error('Неверный формат размера: ' + s);
        process.exit(1);
    }
    const num = parseFloat(m[1]);
    const unit = (m[2] || 'B').toUpperCase();
    const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
    return Math.round(num * (mult[unit] || 1));
}

// ── Allure-like content generators ──────────────────────
function uuid() {
    return crypto.randomUUID();
}

function generateAllureResult(suiteName, testName, status) {
    return JSON.stringify({
        uuid: uuid(),
        historyId: crypto.createHash('md5').update(suiteName + testName).digest('hex'),
        fullName: `${suiteName}#${testName}`,
        labels: [
            { name: 'suite', value: suiteName },
            { name: 'subSuite', value: 'Unit Tests' },
            { name: 'host', value: 'test-vm-01' },
            { name: 'thread', value: 'main-' + Math.floor(Math.random() * 10) },
            { name: 'framework', value: 'junit5' },
            { name: 'language', value: 'java' },
            { name: 'package', value: 'com.example.' + suiteName.toLowerCase().replace(/\s+/g, '.') },
        ],
        name: testName,
        status: status,
        stage: 'finished',
        steps: generateSteps(Math.floor(Math.random() * 5) + 1),
        attachments: [],
        start: Date.now() - Math.floor(Math.random() * 60000),
        stop: Date.now(),
    }, null, 2);
}

function generateSteps(count) {
    const steps = [];
    const stepNames = [
        'Подготовка тестовых данных', 'Инициализация контекста',
        'Выполнение запроса', 'Проверка ответа', 'Очистка ресурсов',
        'Валидация схемы', 'Проверка авторизации', 'Загрузка конфигурации',
        'Подключение к БД', 'Отправка события',
    ];
    for (let i = 0; i < count; i++) {
        steps.push({
            name: stepNames[i % stepNames.length],
            status: 'passed',
            start: Date.now() - 5000 + i * 1000,
            stop: Date.now() - 4000 + i * 1000,
        });
    }
    return steps;
}

function generateAllureContainer(suiteId, suiteName, childUuids) {
    return JSON.stringify({
        uuid: suiteId,
        name: suiteName,
        children: childUuids,
        befores: [{ name: 'setUp', status: 'passed', start: Date.now() - 60000, stop: Date.now() - 59000 }],
        afters: [{ name: 'tearDown', status: 'passed', start: Date.now() - 1000, stop: Date.now() }],
        start: Date.now() - 60000,
        stop: Date.now(),
    }, null, 2);
}

function generateAttachment(sizeBytes) {
    return crypto.randomBytes(sizeBytes);
}

function generateLogAttachment(lines) {
    const levels = ['INFO', 'DEBUG', 'WARN', 'ERROR'];
    const messages = [
        'Starting test execution', 'Loading configuration from classpath',
        'Connecting to database pool', 'Executing SQL query: SELECT * FROM users',
        'Response received: 200 OK', 'Asserting response body contains expected value',
        'Cache miss for key: user_session_42', 'Retrying request after timeout',
        'Transaction committed successfully', 'Closing database connection',
        'Memory usage: 256MB / 512MB', 'Thread pool size: 4/16 active',
    ];
    const buf = [];
    for (let i = 0; i < lines; i++) {
        const ts = new Date(Date.now() - (lines - i) * 100).toISOString();
        const lvl = levels[Math.floor(Math.random() * levels.length)];
        const msg = messages[Math.floor(Math.random() * messages.length)];
        buf.push(`${ts} [${lvl}] ${msg}`);
    }
    return buf.join('\n');
}

// ── Generator functions ─────────────────────────────────

function generateAllure(targetSize, outDir) {
    console.log(`\nГенерация Allure-подобных данных (~${formatSize(targetSize)})...`);
    fs.mkdirSync(outDir, { recursive: true });

    const suites = [
        'UserService', 'AuthController', 'PaymentGateway', 'OrderProcessor',
        'NotificationService', 'ReportGenerator', 'DataValidator', 'CacheManager',
        'SearchEngine', 'FileUploader', 'EmailSender', 'SchedulerService',
    ];
    const testNames = [
        'shouldCreateUser', 'shouldAuthenticateWithValidToken',
        'shouldProcessPayment', 'shouldRejectInvalidCard',
        'shouldSendNotification', 'shouldGenerateReport',
        'shouldValidateInput', 'shouldCacheResults',
        'shouldReturnSearchResults', 'shouldUploadFile',
        'shouldSendEmail', 'shouldScheduleTask',
        'shouldHandleTimeout', 'shouldRetryOnFailure',
        'shouldLogError', 'shouldCleanupResources',
    ];
    const statuses = ['passed', 'passed', 'passed', 'passed', 'passed',
        'passed', 'passed', 'failed', 'broken', 'skipped'];

    let totalSize = 0;
    let fileCount = 0;
    const allFiles = [];

    while (totalSize < targetSize) {
        const suite = suites[fileCount % suites.length];
        const childUuids = [];

        const testCount = Math.min(
            Math.floor(Math.random() * 6) + 3,
            Math.ceil((targetSize - totalSize) / 1500)
        );

        for (let t = 0; t < testCount && totalSize < targetSize; t++) {
            const testName = testNames[(fileCount + t) % testNames.length];
            const status = statuses[Math.floor(Math.random() * statuses.length)];
            const result = generateAllureResult(suite, testName + '_' + fileCount, status);
            const resultUuid = JSON.parse(result).uuid;
            childUuids.push(resultUuid);

            const fname = resultUuid + '-result.json';
            fs.writeFileSync(path.join(outDir, fname), result);
            totalSize += Buffer.byteLength(result);
            allFiles.push(fname);

            if (Math.random() < 0.3 && totalSize < targetSize) {
                const attSize = Math.min(
                    Math.floor(Math.random() * 5000) + 500,
                    targetSize - totalSize
                );
                let attData, attExt;
                if (Math.random() < 0.5) {
                    attData = generateLogAttachment(Math.ceil(attSize / 80));
                    attExt = '.txt';
                } else {
                    attData = generateAttachment(attSize);
                    attExt = '.png';
                }
                const attName = uuid() + '-attachment' + attExt;
                fs.writeFileSync(path.join(outDir, attName), attData);
                totalSize += Buffer.byteLength(attData);
                allFiles.push(attName);
            }
        }

        const containerId = uuid();
        const container = generateAllureContainer(containerId, suite, childUuids);
        const cname = containerId + '-container.json';
        fs.writeFileSync(path.join(outDir, cname), container);
        totalSize += Buffer.byteLength(container);
        allFiles.push(cname);
        fileCount++;

        if (totalSize < targetSize && (targetSize - totalSize) < 2000) {
            const pad = generateAttachment(targetSize - totalSize);
            const padName = uuid() + '-attachment.bin';
            fs.writeFileSync(path.join(outDir, padName), pad);
            totalSize += pad.length;
            allFiles.push(padName);
        }
    }

    return { totalSize, fileCount: allFiles.length, files: allFiles };
}

function generateRandom(targetSize, outDir) {
    console.log(`\nГенерация случайных бинарных данных (~${formatSize(targetSize)})...`);
    fs.mkdirSync(outDir, { recursive: true });

    const fname = `random-${formatSize(targetSize).replace(/\s+/g, '')}.bin`;
    const fpath = path.join(outDir, fname);

    const chunkSize = 1024 * 1024;
    const fd = fs.openSync(fpath, 'w');
    let written = 0;
    while (written < targetSize) {
        const sz = Math.min(chunkSize, targetSize - written);
        const chunk = crypto.randomBytes(sz);
        fs.writeSync(fd, chunk);
        written += sz;
    }
    fs.closeSync(fd);

    return { totalSize: written, fileCount: 1, files: [fname] };
}

function generateText(targetSize, outDir) {
    console.log(`\nГенерация текстовых данных (~${formatSize(targetSize)})...`);
    fs.mkdirSync(outDir, { recursive: true });

    const files = [];
    let totalSize = 0;

    const csvName = `metrics-${Date.now()}.csv`;
    const csvPath = path.join(outDir, csvName);
    const headers = 'timestamp,cpu_percent,memory_mb,disk_io_read,disk_io_write,network_in,network_out,active_threads,request_count,error_count\n';
    let csv = headers;
    while (Buffer.byteLength(csv) < targetSize * 0.4) {
        const ts = new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString();
        csv += `${ts},${(Math.random() * 100).toFixed(1)},${Math.floor(Math.random() * 4096)},${Math.floor(Math.random() * 1e6)},${Math.floor(Math.random() * 1e6)},${Math.floor(Math.random() * 1e8)},${Math.floor(Math.random() * 1e8)},${Math.floor(Math.random() * 200)},${Math.floor(Math.random() * 10000)},${Math.floor(Math.random() * 50)}\n`;
    }
    fs.writeFileSync(csvPath, csv);
    totalSize += Buffer.byteLength(csv);
    files.push(csvName);

    const logName = `application-${Date.now()}.log`;
    const logPath = path.join(outDir, logName);
    let log = '';
    while (Buffer.byteLength(log) < targetSize - totalSize) {
        log += generateLogAttachment(100) + '\n';
    }
    log = log.slice(0, targetSize - totalSize);
    fs.writeFileSync(logPath, log);
    totalSize += Buffer.byteLength(log);
    files.push(logName);

    return { totalSize, fileCount: files.length, files };
}

// ── Tar + Gzip ──────────────────────────────────────────
function createTarGz(sourceDir, outFile) {
    const files = fs.readdirSync(sourceDir).filter(f =>
        fs.statSync(path.join(sourceDir, f)).isFile()
    );

    const blocks = [];
    for (const fname of files) {
        const fpath = path.join(sourceDir, fname);
        const data = fs.readFileSync(fpath);
        const header = makeTarHeader(fname, data.length);
        blocks.push(header);
        blocks.push(data);
        const remainder = data.length % 512;
        if (remainder > 0) blocks.push(Buffer.alloc(512 - remainder));
    }
    blocks.push(Buffer.alloc(1024));

    const tarData = Buffer.concat(blocks);
    const gzipped = zlib.gzipSync(tarData, { level: 6 });
    fs.writeFileSync(outFile, gzipped);
    return { tarSize: tarData.length, gzSize: gzipped.length };
}

function makeTarHeader(fname, size) {
    const buf = Buffer.alloc(512);
    buf.write(fname.slice(0, 99), 0);
    buf.write('0000644\0', 100);
    buf.write('0001000\0', 108);
    buf.write('0001000\0', 116);
    buf.write(size.toString(8).padStart(11, '0') + '\0', 124);
    buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    buf.write('0', 156);
    buf.write('ustar\0', 257);
    buf.write('00', 263);
    buf.write('        ', 148);
    let chk = 0;
    for (let i = 0; i < 512; i++) chk += buf[i];
    buf.write(chk.toString(8).padStart(6, '0') + '\0 ', 148);
    return buf;
}

// ── Utils ───────────────────────────────────────────────
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function estimateFrames(gzSize) {
    const q4bpf = 9324;
    const rgbBpf = 37296;
    return {
        q4Frames: Math.ceil(gzSize / q4bpf),
        rgbFrames: Math.ceil(gzSize / rgbBpf),
        q4Time: Math.ceil(gzSize / q4bpf) * 0.5,
        rgbTime: Math.ceil(gzSize / rgbBpf) * 0.5,
    };
}

function cleanDir(dir) {
    if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
        }
    }
}

// ── Main ────────────────────────────────────────────────
function run() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║    Dummy Data Generator для PoC пайплайна   ║');
    console.log('╚══════════════════════════════════════════════╝');

    const generators = { allure: generateAllure, random: generateRandom, text: generateText };
    const gen = generators[requestedType];
    if (!gen) {
        console.error('Неизвестный тип: ' + requestedType + '. Доступные: allure, random, text');
        process.exit(1);
    }

    let targets;
    if (requestedSize) {
        const bytes = parseSize(requestedSize);
        targets = [{ name: 'custom', rawSize: bytes, desc: formatSize(bytes) }];
    } else if (requestedPreset) {
        const p = PRESETS.find(p => p.name === requestedPreset);
        if (!p) {
            console.error('Неизвестный пресет: ' + requestedPreset + '. Доступные: ' + PRESETS.map(p => p.name).join(', '));
            process.exit(1);
        }
        targets = [p];
    } else {
        targets = PRESETS;
    }

    console.log(`Тип данных: ${requestedType}`);
    console.log(`Папка вывода: ${path.resolve(outputDir)}`);
    console.log(`Пресетов: ${targets.length}`);

    const results = [];

    for (const target of targets) {
        const subDir = path.join(outputDir, `${requestedType}-${target.name}`);
        const tarGzFile = path.join(outputDir, `${requestedType}-${target.name}.tar.gz`);

        cleanDir(subDir);
        const info = gen(target.rawSize, subDir);

        const { tarSize, gzSize } = createTarGz(subDir, tarGzFile);
        const est = estimateFrames(gzSize);

        console.log(`\n─── ${target.name} (${target.desc || ''}) ───`);
        console.log(`  Файлов: ${info.fileCount}`);
        console.log(`  Raw размер: ${formatSize(info.totalSize)}`);
        console.log(`  tar.gz: ${formatSize(gzSize)} (сжатие: ${(gzSize / info.totalSize * 100).toFixed(0)}%)`);
        console.log(`  Q4:  ${est.q4Frames} фреймов, ~${est.q4Time < 60 ? est.q4Time.toFixed(0) + ' сек' : (est.q4Time / 60).toFixed(1) + ' мин'}`);
        console.log(`  RGB: ${est.rgbFrames} фреймов, ~${est.rgbTime < 60 ? est.rgbTime.toFixed(0) + ' сек' : (est.rgbTime / 60).toFixed(1) + ' мин'}`);
        console.log(`  Архив: ${tarGzFile}`);

        results.push({
            preset: target.name,
            rawSize: info.totalSize,
            gzSize,
            files: info.fileCount,
            ...est,
            tarGzFile,
        });

        // Сырые файлы остаются в subDir — полезно для инспекции
    }

    // Итоговая таблица
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                      ИТОГОВАЯ ТАБЛИЦА                          ║');
    console.log('╠══════════╦══════════╦══════════╦════════╦════════╦══════════════╣');
    console.log('║ Пресет   ║ Raw      ║ tar.gz   ║ Q4 фр. ║ RGB фр.║ Q4 время    ║');
    console.log('╠══════════╬══════════╬══════════╬════════╬════════╬══════════════╣');
    for (const r of results) {
        const timeStr = r.q4Time < 60 ? `${r.q4Time.toFixed(0)} сек` :
            r.q4Time < 3600 ? `${(r.q4Time / 60).toFixed(1)} мин` :
                `${(r.q4Time / 3600).toFixed(1)} ч`;
        console.log(`║ ${r.preset.padEnd(8)} ║ ${formatSize(r.rawSize).padEnd(8)} ║ ${formatSize(r.gzSize).padEnd(8)} ║ ${String(r.q4Frames).padEnd(6)} ║ ${String(r.rgbFrames).padEnd(6)} ║ ${timeStr.padEnd(12)} ║`);
    }
    console.log('╚══════════╩══════════╩══════════╩════════╩════════╩══════════════╝');

    console.log('\nГотово! Используй tar.gz файлы с энкодером:');
    console.log(`  node src/vm-encoder.js dummies/${requestedType}-small.tar.gz`);
}

run();
