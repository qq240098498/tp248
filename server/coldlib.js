// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 一条记录名下的更正（按其探头+时刻归集），按序号排好；序号从 1 开始，全部留痕
function correctionsForRecord(data, recordId) {
  const row = data.records.find((r) => r.id === recordId);
  if (!row) return [];
  return correctionsForMoment(data, row.probeId, row.at);
}

function latestCorrectionForRecord(data, recordId) {
  const list = correctionsForRecord(data, recordId);
  return list.length ? list[list.length - 1] : null;
}

// 同一探头同一时刻的记录互为一组（存量里存在自动+手工两条），更正挂在组内任一条上都算
function peerRecords(data, row) {
  return data.records.filter((x) => x.probeId === row.probeId && x.at === row.at && x.batchId === row.batchId);
}

// 某探头某时刻（可跨同批次内成对的自动/手工行）的全部更正，按序号排好；
// 按 probeId+at 归集而不是按 recordId，这样同组的自动行被删、手工行还在时更正仍然在。
function correctionsForMoment(data, probeId, at) {
  return (data.corrections || [])
    .filter((c) => c.probeId === probeId && c.at === at)
    .slice()
    .sort((a, b) => (a.seq - b.seq) || (a.correctedAt < b.correctedAt ? -1 : a.correctedAt > b.correctedAt ? 1 : 0));
}

function groupCorrections(data, rows) {
  const all = [];
  const seen = {};
  for (const r of rows) {
    for (const c of correctionsForMoment(data, r.probeId, r.at)) {
      if (!seen[c.id]) { seen[c.id] = 1; all.push(c); }
    }
  }
  return all.sort((a, b) => (a.seq - b.seq) || (a.correctedAt < b.correctedAt ? -1 : a.correctedAt > b.correctedAt ? 1 : 0));
}

// 取某条记录所在「探头+时刻」组的最终采用值与最新更正
function finalAdoption(data, row) {
  const peers = peerRecords(data, row);
  const list = correctionsForMoment(data, row.probeId, row.at);
  const latest = list.length ? list[list.length - 1] : null;
  const representative = peers.find((r) => r.source === '自动') || peers[0];
  const manual = peers.find((r) => r.source === '人工');
  let value = Number(representative.temperatureC);
  if (latest) value = Number(latest.toValueC);
  else if (representative.source === '自动' && manual) value = Number(manual.temperatureC);
  return { value, latest, history: list, representative, peers };
}

// 同一探头同一时刻：以最新更正后的值为最终采用值；
// 没有更正时保留旧口径（手工记录覆盖自动记录）。原始记录不删不改。
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (current.source !== '自动' && row.source === '自动') picked[key] = row;
  }
  return order.map((key) => {
    const representative = picked[key];
    const adoption = finalAdoption(data, representative);
    const effective = Object.assign({}, representative, {
      temperatureC: adoption.value,
      corrected: !!adoption.latest,
      correctionSeq: adoption.latest ? adoption.latest.seq : 0,
      correctionId: adoption.latest ? adoption.latest.id : '',
    });
    return effective;
  });
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  correctionsForRecord,
  latestCorrectionForRecord,
  correctionsForMoment,
  peerRecords,
  groupCorrections,
  finalAdoption,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
};
