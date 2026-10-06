// 人工更正台账：每次更正都留痕（改前值、改后值、原始值、更正人、时刻、依据、序号），
// 原始记录不删不改；更正登记后受影响批次的放行判定立即重算并给出改前改后对照。
const store = require('./store');
const coldlib = require('./coldlib');
const { AppError } = require('./errors');

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateCorrection(data, c) {
  return Object.assign({}, c, {
    batchCode: batchCode(data, c.batchId),
    probeCode: probeCode(data, c.probeId),
    restoredToOriginal: Number(c.toValueC) === Number(c.originalValueC) && c.seq > 1,
  });
}

// 登记一条更正。同一条（探头+时刻）记录可以被反复更正，每次都新增一条台账并递增序号。
function createCorrection(data, recordId, payload) {
  const record = data.records.find((r) => r.id === recordId);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');

  const errors = {};
  const toValue = Number(payload.toValueC);
  if (payload.toValueC === undefined || payload.toValueC === '' || !Number.isFinite(toValue)) {
    errors.toValueC = '更正后的温度要是数字';
  }
  const corrector = String(payload.corrector || '').trim();
  if (!corrector) errors.corrector = '更正人不能为空';
  const basis = String(payload.basis || '').trim();
  if (!basis) errors.basis = '更正依据不能为空';
  const correctedAt = String(payload.correctedAt || store.nowText());
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(correctedAt)) {
    errors.correctedAt = '更正时刻格式要像 2026-09-01 08:00:00';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这次更正没通过校验', errors);

  // 受影响的是同一探头同一时刻的读数（可能在多个批次里各有一条；存量里自动与手工也各一条）
  const momentRecords = data.records.filter((r) => r.probeId === record.probeId && r.at === record.at);
  const history = coldlib.correctionsForMoment(data, record.probeId, record.at);
  const last = history.length ? history[history.length - 1] : null;

  // 改前值＝这次更正之前实际采用的值；原始值＝该时刻最早的采集值，整条更正链不变
  const adoption = coldlib.finalAdoption(data, record);
  const fromValue = last ? Number(last.toValueC) : adoption.value;
  const originalValue = last ? Number(last.originalValueC) : adoption.value;
  if (toValue === fromValue) {
    throw new AppError(409, 'CORRECTION_SAME_VALUE', '更正后的温度和当前采用值一样，没有变化可登记', { fromValueC: fromValue, toValueC: toValue });
  }

  const affectedBatchIds = [];
  for (const r of momentRecords) {
    if (affectedBatchIds.indexOf(r.batchId) === -1) affectedBatchIds.push(r.batchId);
  }
  const affectedBatches = affectedBatchIds
    .map((id) => data.batches.find((b) => b.id === id))
    .filter(Boolean);

  // 改前判定快照
  const beforeChecks = affectedBatches.map((b) => ({ batch: b, check: coldlib.releaseCheck(data, b) }));

  const correction = {
    id: store.nextId('cr', data.corrections || []),
    recordId: record.id,
    batchId: record.batchId,
    probeId: record.probeId,
    at: record.at,
    seq: (last ? Number(last.seq) : 0) + 1,
    fromValueC: store.round(fromValue, 2),
    toValueC: store.round(toValue, 2),
    originalValueC: store.round(originalValue, 2),
    corrector,
    correctedAt,
    basis,
    remark: String(payload.remark || '').trim(),
    migrated: false,
  };
  data.corrections.push(correction);

  // 改后判定快照与逐条对照
  const decisionCompare = affectedBatches.map((b, i) => {
    const before = beforeChecks[i].check;
    const after = coldlib.releaseCheck(data, b);
    const rows = [];
    const afterMap = {};
    for (const c of after.conditions) afterMap[c.key] = c;
    for (const bc of before.conditions) {
      const ac = afterMap[bc.key];
      rows.push({
        key: bc.key,
        text: bc.text,
        beforeOk: bc.ok,
        afterOk: ac ? ac.ok : bc.ok,
        beforeValue: bc.value,
        afterValue: ac ? ac.value : bc.value,
        limit: bc.limit,
        changed: bc.ok !== (ac ? ac.ok : bc.ok) || String(bc.value) !== String(ac ? ac.value : bc.value),
      });
    }
    // 校准第四条（前端与判定口径一致：探头都在校准有效期内）
    const beforeCalOk = before.expiredProbes.length === 0;
    const afterCalOk = after.expiredProbes.length === 0;
    rows.push({
      key: 'calibration',
      text: '参与判定的探头都在校准有效期内',
      beforeOk: beforeCalOk,
      afterOk: afterCalOk,
      beforeValue: before.expiredProbes.length,
      afterValue: after.expiredProbes.length,
      limit: 0,
      changed: beforeCalOk !== afterCalOk || before.expiredProbes.length !== after.expiredProbes.length,
    });
    return {
      batchId: b.id,
      batchCode: b.code,
      batchStatus: b.status,
      beforePass: before.pass && beforeCalOk,
      afterPass: after.pass && afterCalOk,
      mktBefore: before.mkt,
      mktAfter: after.mkt,
      longestBefore: before.longestMinutes,
      longestAfter: after.longestMinutes,
      totalBefore: before.totalMinutes,
      totalAfter: after.totalMinutes,
      chainBefore: before.chain.gapCount,
      chainAfter: after.chain.gapCount,
      rows,
    };
  });

  return {
    correction: decorateCorrection(data, correction),
    decisionCompare,
  };
}

// 更正流水：支持按批次、探头、记录、更正人、时间筛选，按更正时刻倒序
function listCorrections(data, query) {
  const q = query || {};
  let rows = (data.corrections || []).slice();
  if (q.batchId) {
    // 按时刻归属：该批次有记录的探头+时刻上的更正都算这个批次的
    const momentSet = {};
    for (const r of data.records) if (r.batchId === q.batchId) momentSet[r.probeId + '|' + r.at] = 1;
    rows = rows.filter((c) => momentSet[c.probeId + '|' + c.at]);
  }
  if (q.probeId) rows = rows.filter((c) => c.probeId === q.probeId);
  if (q.recordId) {
    const target = data.records.find((r) => r.id === q.recordId);
    if (target) rows = rows.filter((c) => c.probeId === target.probeId && c.at === target.at);
    else rows = [];
  }
  if (q.corrector) rows = rows.filter((c) => String(c.corrector).includes(String(q.corrector)));
  if (q.from) rows = rows.filter((c) => c.at >= q.from);
  if (q.to) rows = rows.filter((c) => c.at <= q.to);
  return rows
    .map((c) => decorateCorrection(data, c))
    .sort((a, b) => (a.correctedAt < b.correctedAt ? 1 : a.correctedAt > b.correctedAt ? -1 : b.seq - a.seq));
}

// 同一探头同一时刻被反复更正的历史（改了又改回去之类），按序号排
function historyOfMoment(data, probeId, at) {
  const records = data.records.filter((r) => r.probeId === probeId && r.at === at);
  const list = coldlib.groupCorrections(data, records).map((c) => decorateCorrection(data, c));
  const adoption = records.length ? coldlib.finalAdoption(data, records[0]) : null;
  return {
    probeId,
    probeCode: probeCode(data, probeId),
    at,
    batchCodes: Array.from(new Set(records.map((r) => batchCode(data, r.batchId)))),
    rawValueC: adoption ? adoption.value : null,
    originalValueC: list.length ? list[0].fromValueC : (adoption ? adoption.value : null),
    finalValueC: list.length ? list[list.length - 1].toValueC : (adoption ? adoption.value : null),
    history: list,
  };
}

// 被更正过不止一次的时刻（反复更正），按时刻列出，最新在前
function repeatedMoments(data, query) {
  const q = query || {};
  const groups = {};
  for (const c of data.corrections || []) {
    const key = c.probeId + '|' + c.at;
    (groups[key] = groups[key] || []).push(c);
  }
  const out = [];
  for (const key of Object.keys(groups)) {
    if (groups[key].length < 2) continue;
    const [probeId, at] = key.split('|');
    if (q.probeId && probeId !== q.probeId) continue;
    const item = historyOfMoment(data, probeId, at);
    if (q.batchId && !data.records.some((r) => r.batchId === q.batchId && r.probeId === probeId && r.at === at)) continue;
    out.push(item);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

function pct(n, d) {
  return d ? store.round((n / d) * 100, 1) : 0;
}

// 更正汇总：按探头与按批次给出更正条数、被更正的时刻数与更正占比；
// 占比达到阈值 correctionWarnPct 的探头单独列出提醒。
function correctionSummary(data, query) {
  const q = query || {};
  let threshold = Number(q.threshold);
  if (!Number.isFinite(threshold)) threshold = Number(data.settings.correctionWarnPct);
  threshold = Math.min(100, Math.max(0, store.round(threshold, 1)));

  // 每个探头的采集时刻总数（同探头同时刻多条只算一个时刻）
  const probeMoments = {};
  const probeRecords = {};
  for (const r of data.records) {
    probeRecords[r.probeId] = (probeRecords[r.probeId] || 0) + 1;
    const set = probeMoments[r.probeId] || (probeMoments[r.probeId] = {});
    set[r.at] = 1;
  }

  const probeCorrectionCount = {};
  const probeCorrectedMoments = {};
  for (const c of data.corrections || []) {
    probeCorrectionCount[c.probeId] = (probeCorrectionCount[c.probeId] || 0) + 1;
    const set = probeCorrectedMoments[c.probeId] || (probeCorrectedMoments[c.probeId] = {});
    set[c.at] = 1;
  }

  const probeRows = data.probes.map((p) => {
    const momentCount = Object.keys(probeMoments[p.id] || {}).length;
    const correctionCount = probeCorrectionCount[p.id] || 0;
    const correctedMomentCount = Object.keys(probeCorrectedMoments[p.id] || {}).length;
    const ratio = pct(correctedMomentCount, momentCount);
    return {
      probeId: p.id,
      probeCode: p.code,
      roomCode: roomCode(data, p.roomId),
      position: p.position,
      status: p.status,
      recordCount: probeRecords[p.id] || 0,
      momentCount,
      correctionCount,
      correctedMomentCount,
      correctionRatioPct: ratio,
      warn: correctionCount > 0 && ratio >= threshold,
    };
  }).sort((a, b) => (b.correctionRatioPct - a.correctionRatioPct) || (b.correctionCount - a.correctionCount));

  const batchCorrectionCount = {};
  const batchCorrectedMoments = {};
  // 更正作用于「探头+时刻」：凡名下有该时刻记录的批次都计入
  const momentBatches = {};
  for (const r of data.records) {
    const key = r.probeId + '|' + r.at;
    const set = momentBatches[key] || (momentBatches[key] = {});
    set[r.batchId] = 1;
  }
  for (const c of data.corrections || []) {
    const key = c.probeId + '|' + c.at;
    for (const batchId of Object.keys(momentBatches[key] || {})) {
      batchCorrectionCount[batchId] = (batchCorrectionCount[batchId] || 0) + 1;
      const set = batchCorrectedMoments[batchId] || (batchCorrectedMoments[batchId] = {});
      set[key] = 1;
    }
  }
  const batchMoments = {};
  for (const r of data.records) {
    const set = batchMoments[r.batchId] || (batchMoments[r.batchId] = {});
    set[r.probeId + '|' + r.at] = 1;
  }

  const batchRows = data.batches.map((b) => {
    const momentCount = Object.keys(batchMoments[b.id] || {}).length;
    const correctionCount = batchCorrectionCount[b.id] || 0;
    const correctedMomentCount = Object.keys(batchCorrectedMoments[b.id] || {}).length;
    const check = coldlib.releaseCheck(data, b);
    const calOk = check.expiredProbes.length === 0;
    return {
      batchId: b.id,
      batchCode: b.code,
      product: b.product,
      status: b.status,
      roomCode: roomCode(data, b.roomId),
      momentCount,
      correctionCount,
      correctedMomentCount,
      correctionRatioPct: pct(correctedMomentCount, momentCount),
      currentPass: check.pass && calOk,
    };
  }).sort((a, b) => (b.correctionRatioPct - a.correctionRatioPct) || (b.correctionCount - a.correctionCount));

  const warnedProbes = probeRows.filter((r) => r.warn);
  const corrections = data.corrections || [];
  const repeated = repeatedMoments(data, {}).length;

  return {
    thresholdPct: threshold,
    totalCorrections: corrections.length,
    correctedProbeCount: Object.keys(probeCorrectionCount).length,
    correctedBatchCount: Object.keys(batchCorrectionCount).length,
    repeatedMomentCount: repeated,
    warnedProbes,
    probes: probeRows,
    batches: batchRows,
  };
}

// 删除一条温度记录后：同一探头同一时刻还有别的记录（自动/手工成对）就保留更正台账；
// 这个时刻的记录全删光了，挂在该时刻上的更正才一并清掉。
function detachMoment(data, probeId, at) {
  const stillHas = data.records.some((r) => r.probeId === probeId && r.at === at);
  if (stillHas) return 0;
  const before = (data.corrections || []).length;
  data.corrections = (data.corrections || []).filter((c) => !(c.probeId === probeId && c.at === at));
  return before - data.corrections.length;
}

// 删除批次时按「探头+时刻」清理：只有该时刻在所有批次里都不再有记录，更正才删除。
// 传入被删批次名下的记录（在它们被移出 data.records 之前调用）。
function detachBatchMoments(data, removedRecords) {
  let count = 0;
  const moments = {};
  for (const r of removedRecords || []) moments[r.probeId + '|' + r.at] = { probeId: r.probeId, at: r.at };
  for (const key of Object.keys(moments)) {
    const m = moments[key];
    const stillHas = data.records.some((r) => r.probeId === m.probeId && r.at === m.at);
    if (stillHas) continue;
    const before = (data.corrections || []).length;
    data.corrections = (data.corrections || []).filter((c) => !(c.probeId === m.probeId && c.at === m.at));
    count += before - data.corrections.length;
  }
  return count;
}

module.exports = {
  createCorrection,
  listCorrections,
  historyOfMoment,
  repeatedMoments,
  correctionSummary,
  decorateCorrection,
  detachMoment,
  detachBatchMoments,
};
