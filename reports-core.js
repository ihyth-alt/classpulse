'use strict';
// Pure report calculations. Raw partial entries stay separate throughout.
const ClassPulseReports = (() => {
  const DAY = 86400000;
  const IST_OFFSET = 330 * 60000;
  const numeric = v => v === null || v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const dayKey = ms => new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
  const istTime = ms => new Date(ms + IST_OFFSET).toISOString().slice(0, 19).replace('T', ' ') + ' +05:30';

  function period(date, kind = 'daily') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['daily', 'weekly'].includes(kind)) throw Error('Choose a valid report date and period.');
    const selected = Date.parse(date + 'T00:00:00+05:30');
    if (!Number.isFinite(selected) || dayKey(selected) !== date) throw Error('Choose a valid report date.');
    const days = kind === 'weekly' ? 7 : 1;
    return {kind, date, days, start: selected - (days - 1) * DAY, end: selected + DAY};
  }

  function normalize(rows, start, end) {
    const seen = new Set();
    return rows.filter(row => {
      if (!row) return false;
      const at = Date.parse(row.created_at);
      if (!Number.isFinite(at) || at < start || at >= end) return false;
      const id = Number(row.entry_id);
      const key = Number.isSafeInteger(id) && id > 0 ? 'id:' + id : row.created_at + ':' + JSON.stringify(Array.from({length: 6}, (_, i) => row['field' + (i + 1)] ?? null));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }

  function breach(rule, n) {
    if (n === null) return '';
    if (rule.lowThreshold !== undefined && n < rule.lowThreshold) return 'LOW';
    if (n > rule.threshold) return 'HIGH';
    return '';
  }

  function statistics(rows, rule) {
    const points = rows.map(row => ({value: numeric(row['field' + rule.field]), at: row.created_at})).filter(p => p.value !== null);
    let sum = 0, min = Infinity, max = -Infinity, low = 0, high = 0;
    for (const point of points) {
      sum += point.value; min = Math.min(min, point.value); max = Math.max(max, point.value);
      const flag = breach(rule, point.value);
      if (flag === 'LOW') low++;
      if (flag === 'HIGH') high++;
    }
    return {...rule, count: points.length, min: points.length ? min : null, max: points.length ? max : null, average: points.length ? sum / points.length : null, low, high, breaches: low + high, first: points[0]?.at ?? null, last: points.at(-1)?.at ?? null};
  }

  function build(rows, selectedPeriod, rules, generatedAt = Date.now(), mode = 'channel') {
    const through = Math.min(selectedPeriod.end, generatedAt + 1);
    const records = normalize(rows, selectedPeriod.start, through);
    const stats = rules.map(rule => statistics(records, rule));
    const daily = Array.from({length: selectedPeriod.days}, (_, i) => {
      const start = selectedPeriod.start + i * DAY;
      const items = records.filter(row => Date.parse(row.created_at) >= start && Date.parse(row.created_at) < start + DAY);
      const sensors = rules.map(rule => statistics(items, rule));
      return {date: dayKey(start), entries: items.length, sensors, breaches: sensors.reduce((sum, s) => sum + s.breaches, 0)};
    });
    const fan = {on: 0, off: 0, invalid: 0};
    for (const row of records) {
      const n = numeric(row.field6);
      if (n === 1) fan.on++; else if (n === 0) fan.off++; else if (n !== null) fan.invalid++;
    }
    return {period: selectedPeriod, generatedAt, through, mode, rows: records, stats, daily, fan, breaches: stats.reduce((sum, s) => sum + s.breaches, 0), samples: stats.reduce((sum, s) => sum + s.count, 0)};
  }

  function csv(rows) {
    return '\uFEFF' + rows.map(row => row.map(cell => {
      if (cell === null || cell === undefined) return '';
      let text = String(cell);
      if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join(',')).join('\r\n');
  }

  function rawCSV(report) {
    return csv([
      ['mode', 'entry_id', 'timestamp_utc', 'timestamp_ist', 'body_temperature_c', 'room_temperature_c', 'humidity_percent', 'mq2_ppm', 'seat_occupancy_cps', 'fan_status', ...report.stats.map(s => 'field' + s.field + '_threshold_breach')],
      ...report.rows.map(row => {
        const id = Number(row.entry_id);
        return [report.mode, Number.isSafeInteger(id) && id > 0 ? id : '', new Date(row.created_at).toISOString(), istTime(Date.parse(row.created_at)), ...Array.from({length: 6}, (_, i) => numeric(row['field' + (i + 1)])), ...report.stats.map(s => breach(s, numeric(row['field' + s.field])))];
      })
    ]);
  }

  function summaryCSV(report) {
    return csv([
      ['mode', 'period', 'period_start_ist', 'period_end_exclusive_ist', 'generated_at_utc', 'field', 'sensor', 'unit', 'samples', 'minimum', 'average', 'maximum', 'below_lower_limit', 'above_upper_limit', 'threshold_breaches', 'lower_limit', 'upper_limit', 'first_reading_utc', 'last_reading_utc', 'fan_on_samples', 'fan_off_samples', 'fan_invalid_samples'],
      ...report.stats.map(s => [report.mode, report.period.kind, istTime(report.period.start), istTime(report.period.end), new Date(report.generatedAt).toISOString(), s.field, s.name, s.unit, s.count, s.min, s.average === null ? null : Number(s.average.toFixed(4)), s.max, s.low, s.high, s.breaches, s.lowThreshold ?? '', s.threshold, s.first ? new Date(s.first).toISOString() : '', s.last ? new Date(s.last).toISOString() : '', report.fan.on, report.fan.off, report.fan.invalid])
    ]);
  }

  return {DAY, dayKey, istTime, numeric, period, normalize, breach, statistics, build, csv, rawCSV, summaryCSV};
})();
