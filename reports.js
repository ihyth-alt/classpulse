'use strict';
(() => {
  const R = ClassPulseReports;
  const byId = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (value, digits = 2) => value === null ? '—' : Number(value.toFixed(digits)).toLocaleString('en-IN', {maximumFractionDigits: digits});
  const dateLabel = ms => new Date(ms).toLocaleDateString('en-IN', {timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric'});
  const actionIds = ['report-raw-csv','report-summary-csv','report-html','report-print'];
  let currentReport = null, activeController = null, revision = 0;

  function setActions(enabled) { actionIds.forEach(id => byId(id).disabled = !enabled); }
  function invalidate(message = 'Choose a period and generate a report to load its recorded data.') {
    revision++; activeController?.abort(); activeController = null; currentReport = null;
    setActions(false); setLoading(false);
    byId('report-status').textContent = message;
    byId('report-status').className = 'report-status';
    byId('report-result').innerHTML = '<div class="report-empty"><span>▤</span><h3>Your classroom, on record.</h3><p>Generate a daily or weekly summary, then download the readings or a report ready to share.</p></div>';
  }
  function setLoading(loading) {
    ['report-period','report-date','report-generate'].forEach(id => byId(id).disabled = loading);
    byId('report-generate').textContent = loading ? 'Generating…' : 'Generate report';
    byId('report-result').setAttribute('aria-busy', String(loading));
  }
  function periodHint() {
    byId('report-date-label').textContent = byId('report-period').value === 'weekly' ? 'Week ending' : 'Report date';
    try {
      const p = R.period(byId('report-date').value, byId('report-period').value);
      byId('report-period-hint').textContent = dateLabel(p.start) + (p.days === 7 ? ' – ' + dateLabel(p.end - 1) : '') + ' · India Standard Time (UTC+05:30)';
    } catch { byId('report-period-hint').textContent = 'Dates use India Standard Time (UTC+05:30).'; }
  }

  async function loadWindow(start, end, signal, session, depth = 0) {
    if (++session.requests > 64 || depth > 12) throw Error('This period contains too many records to retrieve safely. Choose a daily report.');
    const url = new URL('https://api.thingspeak.com/channels/3519098/feeds.json');
    url.searchParams.set('start', new Date(start).toISOString().slice(0,19).replace('T',' '));
    url.searchParams.set('end', new Date(end).toISOString().slice(0,19).replace('T',' '));
    url.searchParams.set('results','8000');
    url.searchParams.set('timezone','UTC');
    if (session.key) url.searchParams.set('api_key', session.key);
    const timeout = setTimeout(() => session.controller.abort(), 30000);
    let response, data;
    try {
      response = await fetch(url, {signal,cache:'no-store'});
      if (!response.ok) throw Error(response.status === 429 ? 'ThingSpeak temporarily limited these requests. Please wait and try again.' : 'ThingSpeak could not return this report. Check your connection and read API key.');
      data = await response.json();
    } finally { clearTimeout(timeout); }
    if (!data || !Array.isArray(data.feeds)) throw Error('The channel is unavailable. For a private channel, enter its read API key in Connection settings.');
    // Split a full response rather than silently truncating the requested period.
    if (data.feeds.length >= 8000) {
      const midpoint = Math.floor((start + end) / 2000) * 1000;
      if (midpoint <= start || midpoint >= end) throw Error('Could not retrieve this dense period without truncation. Choose a shorter period.');
      return [...await loadWindow(start, midpoint, signal, session, depth + 1), ...await loadWindow(midpoint, end, signal, session, depth + 1)];
    }
    return data.feeds;
  }

  function sampleHistory(p, generatedAt) {
    const rows = []; let id = 1;
    for (let t=p.start;t<Math.min(p.end,generatedAt+1);t+=30*60000) {
      const wave = (t-p.start)/3600000;
      rows.push({created_at:new Date(t).toISOString(),entry_id:id++,field1:(29.8+Math.sin(wave)*1.7).toFixed(1)});
      if (t+30000<=generatedAt) rows.push({created_at:new Date(t+30000).toISOString(),entry_id:id++,field2:(24.2+Math.sin(wave*.6)*2).toFixed(1),field3:(49+Math.cos(wave)*6).toFixed(1),field4:String(Math.round(185+Math.sin(wave)*30)),field6:Math.sin(wave*.6)>.5?'1':'0'});
    }
    return rows;
  }

  function reportMarkup(report) {
    const p = report.period, title = p.kind === 'weekly' ? 'Weekly classroom report' : 'Daily classroom report';
    const periodText = dateLabel(p.start) + (p.days === 7 ? ' – ' + dateLabel(p.end-1) : '');
    const rules = report.stats.map(s => esc(s.name) + ': ' + (s.lowThreshold !== undefined ? '&lt; '+s.lowThreshold+' or ' : '') + '&gt; '+s.threshold+' '+esc(s.unit)).join(' · ');
    return `<div class="report-document">
      <div class="report-title-row"><div><div class="eyebrow">CLASSPULSE / CHANNEL #3519098</div><h3>${title}</h3><p>${periodText} · IST (UTC+05:30)</p></div><span class="report-mode ${report.mode==='sample'?'sample':''}">${report.mode==='sample'?'SAMPLE DATA':'CHANNEL DATA'}</span></div>
      <p class="report-generated">Generated ${esc(R.istTime(report.generatedAt))} · ${p.end>report.generatedAt?'Current period: data through generation time.':'Completed calendar period.'}</p>
      ${report.mode==='sample'?'<div class="report-caution">Illustrative sample report. These are not measurements from your devices.</div>':''}
      <div class="report-kpis"><div><small>CHANNEL ENTRIES</small><strong>${report.rows.length.toLocaleString('en-IN')}</strong><span>Raw timestamped records</span></div><div><small>SENSOR SAMPLES</small><strong>${report.samples.toLocaleString('en-IN')}</strong><span>Across the four sensors</span></div><div><small>THRESHOLD BREACHES</small><strong>${report.breaches.toLocaleString('en-IN')}</strong><span>Flagged readings, not messages</span></div><div><small>FAN FEEDBACK</small><strong>${report.fan.on} <em>ON</em> / ${report.fan.off} <em>OFF</em></strong><span>Sample counts, not run time${report.fan.invalid?' · '+report.fan.invalid+' invalid':''}</span></div></div>
      ${!report.rows.length?'<div class="report-caution">No channel entries were found for this period. Empty statistics do not mean zero measurements or normal conditions.</div>':''}
      <h4>Sensor summary</h4><div class="report-table-wrap"><table class="report-table"><thead><tr><th scope="col">Sensor</th><th scope="col">Samples</th><th scope="col">Minimum</th><th scope="col">Average</th><th scope="col">Maximum</th><th scope="col">Breaches</th></tr></thead><tbody>${report.stats.map(s=>`<tr><th scope="row">${esc(s.name)}<small>${esc(s.unit)}</small></th><td>${s.count}</td><td>${fmt(s.min)}</td><td>${fmt(s.average)}</td><td>${fmt(s.max)}</td><td><span class="report-count ${s.breaches?'flagged':''}">${s.count?s.breaches:'—'}</span></td></tr>`).join('')}</tbody></table></div>
      <h4>Daily breakdown</h4><div class="report-table-wrap"><table class="report-table"><thead><tr><th scope="col">Date (IST)</th><th scope="col">Entries</th><th scope="col">Body avg °C</th><th scope="col">Room avg °C</th><th scope="col">Humidity avg %</th><th scope="col">Air avg PPM</th><th scope="col">Breaches</th></tr></thead><tbody>${report.daily.map(d=>`<tr><th scope="row">${d.date}</th><td>${d.entries}</td>${d.sensors.map(s=>'<td>'+fmt(s.average)+'</td>').join('')}<td>${d.entries?d.breaches:'—'}</td></tr>`).join('')}</tbody></table></div>
      <h4>Recorded coverage</h4><div class="report-coverage">${report.stats.map(s=>`<div><strong>${esc(s.name)}</strong><span>${s.first?esc(R.istTime(Date.parse(s.first)))+' → '+esc(R.istTime(Date.parse(s.last))):'No readings in this period'}</span></div>`).join('')}</div>
      <div class="report-method"><p><strong>Thresholds used:</strong> ${rules}.</p><p>Statistics use actual numeric readings only. Missing fields from either board are excluded, never filled with another reading or converted to zero. Averages are per sample. Breaches count readings outside the configured limits; they are not unique incidents or delivered Telegram notifications. This report does not infer attendance or fan run time.</p><p>Modules 1 and 2 · Attendance is outside this report’s scope. Raw CSV retains all six original sensor fields, entry IDs, UTC timestamps and IST timestamps. This is an on-demand snapshot of the data stored in ThingSpeak.</p></div>
    </div>`;
  }

  async function generate(event) {
    event?.preventDefault();
    const selectedDate = byId('report-date').value;
    let p;
    try { p = R.period(selectedDate, byId('report-period').value); if(p.start>Date.now()) throw Error('Choose today or an earlier date.'); }
    catch(error) { byId('report-status').textContent = error.message; byId('report-status').className='report-status error'; return; }
    const run = ++revision, controller = new AbortController(), sample = demo, key = readKey;
    activeController?.abort(); activeController = controller; currentReport = null;
    setActions(false); setLoading(true);
    byId('report-result').innerHTML='<div class="report-empty"><span class="report-loading">◌</span><h3>Gathering your classroom’s story…</h3><p>Fetching recorded entries for the selected period.</p></div>';
    byId('report-status').className='report-status';
    const generatedAt = Date.now();
    try {
      let rows = [];
      if(sample) rows = sampleHistory(p,generatedAt);
      else {
        const session={requests:0,key,controller};
        for(let day=0;day<p.days;day++) {
          const start=p.start+day*R.DAY,end=Math.min(start+R.DAY,p.end,generatedAt+1);
          if(start>=end)continue;
          byId('report-status').textContent='Loading day '+(day+1)+' of '+p.days+'…';
          rows.push(...await loadWindow(start,end,controller.signal,session));
        }
      }
      if(run!==revision)return;
      const rules=sensors.map(s=>({...s}));
      currentReport=R.build(rows,p,rules,generatedAt,sample?'sample':'channel');
      byId('report-result').innerHTML=reportMarkup(currentReport);
      byId('report-status').textContent=currentReport.rows.length?`Report ready · ${currentReport.rows.length.toLocaleString('en-IN')} entries · ${sample?'Sample mode':'Channel #3519098'} · Generated ${new Date(generatedAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'})} IST`:'No records found for the selected period. You can still download the empty report.';
      setActions(true);
    } catch(error) {
      if(run!==revision)return;
      currentReport=null;setActions(false);
      byId('report-status').className='report-status error';
      byId('report-status').textContent=error.name==='AbortError'?'Report request timed out. Try again or choose a daily report.':error.message||'Could not load the report. Check your connection and try again.';
      byId('report-result').innerHTML='<div class="report-empty"><span>!</span><h3>Report could not be completed</h3><p>No partial report has been exported. Please try again.</p></div>';
    } finally { if(run===revision){setLoading(false);activeController=null;} }
  }

  function download(content,name,type) {
    const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function filename(suffix) { return 'classpulse-'+currentReport.mode+'-'+currentReport.period.kind+'-'+currentReport.period.date+'-'+suffix; }
  function standaloneHTML(report) {
    const css='body{font:14px/1.6 Arial,sans-serif;color:#183b30;max-width:1050px;margin:40px auto;padding:0 24px}h3{font-size:28px;margin:8px 0}h4{margin:28px 0 10px}.eyebrow{font-size:10px;letter-spacing:1px}.report-title-row{display:flex;justify-content:space-between;gap:20px}.report-mode{font-size:11px}.sample,.report-caution{color:#915d19;background:#fff3dc;padding:12px}.report-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:25px 0}.report-kpis>div{background:#f1f5ee;padding:15px}.report-kpis small,.report-kpis span{display:block;font-size:10px}.report-kpis strong{display:block;font-size:26px}.report-kpis em{font-size:10px}.report-table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}th,td{padding:12px;border-bottom:1px solid #dce5da}th small{display:block;font-weight:400}.flagged{color:#ae3434}.report-coverage>div{display:flex;justify-content:space-between;gap:20px;font-size:11px;padding:8px 0}.report-method,.report-generated{color:#65745e;font-size:11px}.report-method{border-top:1px solid #dce5da;margin-top:24px}@media(max-width:650px){.report-kpis{grid-template-columns:1fr 1fr}.report-title-row,.report-coverage>div{display:block}}@media print{body{margin:0;max-width:none}h4,thead{break-after:avoid}tr,.report-kpis>div{break-inside:avoid}}';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClassPulse '+esc(report.period.kind)+' report '+esc(report.period.date)+'</title><style>'+css+'</style></head><body>'+reportMarkup(report)+'</body></html>';
  }

  byId('report-date').value=R.dayKey(Date.now());byId('report-date').max=R.dayKey(Date.now());
  byId('report-form').addEventListener('submit',generate);
  ['report-period','report-date'].forEach(id=>byId(id).addEventListener('change',()=>{invalidate('Period changed. Generate the report to refresh its data.');periodHint();}));
  byId('report-raw-csv').onclick=()=>{if(currentReport)download(R.rawCSV(currentReport),filename('readings.csv'),'text/csv;charset=utf-8');};
  byId('report-summary-csv').onclick=()=>{if(currentReport)download(R.summaryCSV(currentReport),filename('summary.csv'),'text/csv;charset=utf-8');};
  byId('report-html').onclick=()=>{if(currentReport)download(standaloneHTML(currentReport),filename('report.html'),'text/html;charset=utf-8');};
  byId('report-print').onclick=()=>{if(currentReport)window.print();};
  byId('settings-form').addEventListener('submit',()=>invalidate('Connection changed. Generate a new report for the selected source.'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)byId('report-date').max=R.dayKey(Date.now());});
  periodHint();invalidate();
})();
