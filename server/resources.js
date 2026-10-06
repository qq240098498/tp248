const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

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

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const latestMap = coldlib.latestCorrectionMap(data);
  const countMap = correctionCountMap(data);
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
    effectiveC: coldlib.adoptedC(r, latestMap),
    correctionCount: countMap[r.id] || 0,
  }));
  const corrections = listCorrections(data, { batchId: id });
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
    corrections,
    checkBeforeCorrections: corrections.length ? checkSnapshot(coldlib.releaseCheck(data, batch, { ignoreCorrections: true })) : null,
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.corrections = (data.corrections || []).filter((c) => c.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  const latestMap = coldlib.latestCorrectionMap(data);
  const countMap = correctionCountMap(data);
  return rows
    .map((r) => {
      const latest = latestMap[r.id];
      const effectiveC = coldlib.adoptedC(r, latestMap);
      return Object.assign({}, r, {
        batchCode: batchCode(data, r.batchId),
        probeCode: probeCode(data, r.probeId),
        effectiveC,
        correctionCount: countMap[r.id] || 0,
        lastCorrectedAt: latest ? latest.correctedAt : '',
        outOfRange: effectiveC > Number(data.settings.upperLimitC) || effectiveC < Number(data.settings.lowerLimitC),
      });
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId) }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

/* ---------- 更正 ---------- */

// 每条记录被更正过几次
function correctionCountMap(data) {
  const map = {};
  for (const c of data.corrections || []) map[c.recordId] = (map[c.recordId] || 0) + 1;
  return map;
}

// 判定快照：用于更正前后对照
function checkSnapshot(check) {
  return {
    pass: check.pass,
    longestMinutes: check.longestMinutes,
    totalMinutes: check.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    recordCount: check.recordCount,
    failed: check.failed,
    expiredProbeCount: (check.expiredProbes || []).length,
  };
}

// 台账行：一次更正 + 原始值与当前采用值并排
function correctionView(data, c) {
  const record = data.records.find((r) => r.id === c.recordId) || null;
  const latestMap = coldlib.latestCorrectionMap(data);
  const countMap = correctionCountMap(data);
  return Object.assign({}, c, {
    batchCode: batchCode(data, c.batchId),
    probeCode: probeCode(data, c.probeId),
    originalC: record ? Number(record.temperatureC) : null,
    adoptedC: record ? coldlib.adoptedC(record, latestMap) : null,
    correctionCountForRecord: countMap[c.recordId] || 0,
    recordDeleted: !record,
  });
}

function listCorrections(data, query) {
  const q = query || {};
  let rows = (data.corrections || []).slice();
  if (q.batchId) rows = rows.filter((c) => c.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((c) => c.probeId === q.probeId);
  if (q.recordId) rows = rows.filter((c) => c.recordId === q.recordId);
  const decorated = rows.map((c) => correctionView(data, c));
  // 查单条记录时按更正时刻升序排成历史链；否则按更正时刻降序
  if (q.recordId) {
    return decorated.sort((a, b) => (a.correctedAt < b.correctedAt ? -1 : a.correctedAt > b.correctedAt ? 1 : (a.id < b.id ? -1 : 1)));
  }
  return decorated.sort((a, b) => (a.correctedAt < b.correctedAt ? 1 : a.correctedAt > b.correctedAt ? -1 : (a.id < b.id ? 1 : -1)));
}

// 登记更正：改前值取当前采用值，原记录不动；返回受影响批次的判定对照
function createCorrection(data, payload) {
  const record = data.records.find((r) => r.id === payload.recordId);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '要更正的温度记录不存在', { recordId: '要更正的温度记录不存在' });
  const errors = {};
  if (payload.afterC === undefined || payload.afterC === '' || !Number.isFinite(Number(payload.afterC))) {
    errors.afterC = '更正后的温度要是数字';
  }
  if (!String(payload.corrector || '').trim()) errors.corrector = '更正人不能为空';
  if (!String(payload.basis || '').trim()) errors.basis = '更正依据不能为空';
  if (payload.correctedAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.correctedAt))) {
    errors.correctedAt = '更正时刻格式要像 2026-09-01 08:00:00';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条更正没通过校验', errors);

  const batch = data.batches.find((b) => b.id === record.batchId) || null;
  const before = batch ? checkSnapshot(coldlib.releaseCheck(data, batch)) : null;

  const latestMap = coldlib.latestCorrectionMap(data);
  const correction = {
    id: store.nextId('cr', data.corrections),
    recordId: record.id,
    batchId: record.batchId,
    probeId: record.probeId,
    at: record.at,
    beforeC: coldlib.adoptedC(record, latestMap),
    afterC: Number(payload.afterC),
    corrector: String(payload.corrector).trim(),
    correctedAt: String(payload.correctedAt || store.nowText()),
    basis: String(payload.basis).trim(),
    remark: String(payload.remark || ''),
  };
  data.corrections.push(correction);

  const after = batch ? checkSnapshot(coldlib.releaseCheck(data, batch)) : null;
  return {
    correction: correctionView(data, correction),
    impact: batch ? { batchId: batch.id, batchCode: batch.code, before, after } : null,
  };
}

// 汇总：按探头与批次的更正条数与占比、高占比探头、反复更正的时刻
function correctionSummary(data) {
  const thresholdPct = Number(data.settings.correctionAlertRatioPct);
  const corrections = data.corrections || [];
  const countMap = correctionCountMap(data);

  const byProbe = data.probes.map((p) => {
    const recordCount = data.records.filter((r) => r.probeId === p.id).length;
    const correctionCount = corrections.filter((c) => c.probeId === p.id).length;
    const ratioPct = recordCount ? store.round((correctionCount / recordCount) * 100, 1) : 0;
    return {
      probeId: p.id, probeCode: p.code, roomCode: roomCode(data, p.roomId),
      recordCount, correctionCount, ratioPct,
      overThreshold: correctionCount > 0 && ratioPct >= thresholdPct,
    };
  }).filter((x) => x.recordCount > 0 || x.correctionCount > 0)
    .sort((a, b) => (b.ratioPct - a.ratioPct) || (a.probeCode < b.probeCode ? -1 : 1));

  const byBatch = data.batches.map((b) => {
    const recordCount = data.records.filter((r) => r.batchId === b.id).length;
    const correctionCount = corrections.filter((c) => c.batchId === b.id).length;
    const ratioPct = recordCount ? store.round((correctionCount / recordCount) * 100, 1) : 0;
    return {
      batchId: b.id, batchCode: b.code, product: b.product,
      recordCount, correctionCount, ratioPct,
      overThreshold: correctionCount > 0 && ratioPct >= thresholdPct,
    };
  }).filter((x) => x.recordCount > 0 || x.correctionCount > 0)
    .sort((a, b) => (b.ratioPct - a.ratioPct) || (a.batchCode < b.batchCode ? -1 : 1));

  // 同一时刻被反复更正的：按记录分组，组内按更正时刻升序排成历史链
  const repeated = Object.keys(countMap)
    .filter((recordId) => countMap[recordId] >= 2)
    .map((recordId) => {
      const history = listCorrections(data, { recordId });
      const first = history[0];
      return {
        recordId,
        batchId: first.batchId, batchCode: first.batchCode,
        probeId: first.probeId, probeCode: first.probeCode,
        at: first.at,
        originalC: first.originalC,
        adoptedC: first.adoptedC,
        count: history.length,
        history,
      };
    })
    .sort((a, b) => (b.count - a.count) || (a.at < b.at ? -1 : 1));

  return {
    thresholdPct,
    totalCorrections: corrections.length,
    correctedRecordCount: Object.keys(countMap).length,
    repeatedCount: repeated.length,
    byProbe,
    byBatch,
    highRatioProbes: byProbe.filter((x) => x.overThreshold),
    repeated,
  };
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  listCorrections, createCorrection, correctionSummary, checkSnapshot,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
