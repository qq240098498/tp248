const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  lowerLimitC: 2,
  upperLimitC: 8,
  allowExcursionMinutes: 30,
  allowTotalExcursionMinutes: 120,
  chainGapMinutes: 15,
  mktActivationEnergy: 83144,
  gasConstant: 8.314,
  probeCalibrationGraceDays: 0,
  recordIntervalMinutes: 15,
  correctionWarnPct: 10,
};

// 存量数据迁移：老系统里「同一探头同一时刻的手工记录覆盖自动记录」没有留痕，
// 这里把这种覆盖补登成一次更正（自动原始记录保留不动），只在内存里幂等生成，
// 首次有写操作保存时一并落盘。
function migrateLegacyOverrides(data) {
  if (!Array.isArray(data.corrections)) data.corrections = [];
  const groups = {};
  for (const r of data.records) {
    const key = r.probeId + '|' + r.at;
    (groups[key] = groups[key] || []).push(r);
  }
  for (const key of Object.keys(groups)) {
    const list = groups[key];
    const auto = list.find((r) => r.source === '自动');
    const manual = list.filter((r) => r.source === '人工').sort((a, b) => (a.id < b.id ? -1 : 1)).pop();
    if (!auto || !manual) continue;
    if (data.corrections.some((c) => c.recordId === auto.id)) continue;
    const corrector = manual.operator && manual.operator !== '自动采集' ? manual.operator : '人工（存量补登）';
    data.corrections.push({
      id: 'crm-' + auto.id,
      recordId: auto.id,
      batchId: auto.batchId,
      probeId: auto.probeId,
      at: auto.at,
      seq: 1,
      fromValueC: Number(auto.temperatureC),
      toValueC: Number(manual.temperatureC),
      originalValueC: Number(auto.temperatureC),
      corrector: corrector,
      correctedAt: String(manual.at),
      basis: '存量手工覆盖记录补登：原系统只留下覆盖后的新值，更正时刻以手工记录时刻占位',
      remark: manual.remark || '',
      migrated: true,
    });
  }
}

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['rooms', 'probes', 'batches', 'records', 'releases', 'corrections']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  migrateLegacyOverrides(data);
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 2 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function minutesBetween(a, b) {
  const toDate = (s) => new Date(String(s).replace(' ', 'T') + '+08:00');
  return Math.round((toDate(b) - toDate(a)) / 60000);
}

function nowText() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes()) + ':' + p(now.getUTCSeconds());
}

module.exports = { load, save, nextId, normalize, round, minutesBetween, nowText, DEFAULT_SETTINGS, dataFile };
