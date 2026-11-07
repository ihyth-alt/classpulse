'use strict';
const $=id=>document.getElementById(id);
const sensors=[{field:1,name:'Body temperature',unit:'°C',color:'#83a36e',threshold:31.5,lowThreshold:28.5,min:20,max:45},{field:2,name:'Room temperature',unit:'°C',color:'#adad77',threshold:35,target:[20,26],min:0,max:50},{field:3,name:'Relative humidity',unit:'%',color:'#8fb4c7',threshold:70,target:[40,60],min:0,max:100},{field:4,name:'MQ-2 air quality',unit:'PPM',color:'#a39a7d',threshold:600,target:[0,300],min:0,max:1000}];
const STALE_MS=120000;
let readings={};
let feeds=[],readKey='',demo=false,range=30,busy=false,lastFetch=null,failure='',generation=0,controller=null;
const value=(feed,field)=>{const v=feed?.['field'+field];if(v===null||v===undefined||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};
const display=(n,d=1)=>n===null?'—':n.toFixed(d);
const time=t=>new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const escapeText=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),3000)}
function isAlert(s,n) { return n!==null&&(n>s.threshold||(s.lowThreshold!==undefined&&n<s.lowThreshold)); }
function sensorState(s,n) {
  if(n===null)return 'No reading';
  if(isAlert(s,n))return 'Alert';
  if(s.field===1)return 'In project range';
  if(n<s.min||n>s.max)return 'Out of range';
  if(n<s.target[0]||n>s.target[1])return 'Off target';
  return 'In target';
}
// Each board writes partial entries. A missing field does not erase its last reading.
function mergeReadings(batch) {
  for(const feed of batch) {
    const timestamp=Date.parse(feed.created_at);
    if(!Number.isFinite(timestamp))continue;
    for(let field=1;field<=6;field++) {
      const n=value(feed,field);
      if(n!==null&&(!readings[field]||timestamp>=readings[field].timestamp)) {
        readings[field]={value:n,timestamp,created_at:feed.created_at};
      }
    }
  }
}
const latestValue=field=>readings[field]?.value??null;
const readingIsStale=field=>!!readings[field]&&Date.now()-readings[field].timestamp>STALE_MS;
function readingLabel(field) {
  const r=readings[field];
  if(!r)return 'No reading received';
  const seconds=Math.max(0,Math.floor((Date.now()-r.timestamp)/1000));
  const age=seconds<60?seconds+'s ago':seconds<3600?Math.floor(seconds/60)+'m ago':Math.floor(seconds/3600)+'h ago';
  const at=new Date(r.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  return (demo?'Sample · ':readingIsStale(field)?'Stale · ':'Received ')+at+' · '+age;
}
function updateReadingLabels() {
  for(let field=1;field<=6;field++) {
    for(const el of document.querySelectorAll('[data-reading-field="'+field+'"]')) {
      el.textContent=readingLabel(field);
      el.classList.toggle('stale',readingIsStale(field));
      el.title=readings[field]?new Date(readings[field].timestamp).toLocaleString():'No valid reading found in the fetched history';
    }
  }
  for(const s of sensors) {
    const el=$('state-'+s.field),state=sensorState(s,latestValue(s.field));
    el.textContent=state+(readingIsStale(s.field)?' · Stale':'');
    el.style.color=state==='Alert'||state==='Out of range'?'var(--danger)':readingIsStale(s.field)?'var(--amber)':'';
  }
}
$('sensor-grid').innerHTML=sensors.map(s=>`<article class="card sensor-card"><div class="card-heading"><h2>${s.name}</h2><span class="subtle">0${s.field}</span></div><div class="sensor-top"><strong id="value-${s.field}">—</strong><span>${s.unit}</span><span class="sensor-state" id="state-${s.field}">No reading</span></div><div class="reading-time" data-reading-field="${s.field}">No reading received</div><div class="sparkline" id="spark-${s.field}"></div><div class="chart-labels"><span id="start-${s.field}">—</span><span id="end-${s.field}">LATEST</span></div></article>`).join('');
$('seats').innerHTML=Array.from({length:40},()=>'<span></span>').join('');
function chartSVG(series,colors,options={}){const w=520,h=190,l=options.axes?42:4,r=options.dual?42:8,t=12,b=options.axes?30:6;const iw=w-l-r,ih=h-t-b;const all=series.flat().filter(n=>n!==null);if(!all.length)return '<div class="empty-chart">Waiting for sensor history</div>';let lo=Math.min(...all),hi=Math.max(...all);const pad=Math.max((hi-lo)*.2,1);lo-=pad;hi+=pad;const bounds=series.map(a=>{const ns=a.filter(n=>n!==null);if(!options.dual)return [lo,hi];if(!ns.length)return [0,100];const mn=Math.min(...ns),mx=Math.max(...ns),p=Math.max((mx-mn)*.25,2);return [mn-p,mx+p]});const x=i=>l+i*iw/Math.max(feeds.length-1,1);let svg=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${options.dual?'Room temperature and humidity trend':'Sensor reading trend'}">`;
if(options.axes){for(let j=0;j<4;j++){const yy=t+j*ih/3;svg+=`<line x1="${l}" x2="${w-r}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="${l-8}" y="${yy+3}" text-anchor="end" fill="var(--muted)" font-size="9">${(bounds[0][1]-j*(bounds[0][1]-bounds[0][0])/3).toFixed(1)}${options.dual?'°':''}</text>`;if(options.dual)svg+=`<text x="${w-r+8}" y="${yy+3}" fill="var(--muted)" font-size="9">${(bounds[1][1]-j*(bounds[1][1]-bounds[1][0])/3).toFixed(0)}%</text>`}svg+=`<text x="${l}" y="${h-5}" fill="var(--muted)" font-size="9">${feeds.length?time(feeds[0].created_at):''}</text><text x="${w-r}" y="${h-5}" text-anchor="end" fill="var(--muted)" font-size="9">${feeds.length?time(feeds.at(-1).created_at):''}</text>`}
series.forEach((a,k)=>{const [mn,mx]=bounds[k];const y=n=>t+(mx-n)/(mx-mn)*ih;let path='',connected=false;a.forEach((n,i)=>{if(n===null){connected=false;return}path+=`${connected?'L':'M'}${x(i).toFixed(2)},${y(n).toFixed(2)} `;connected=true});svg+=`<path class="chart-path" d="${path}" fill="none" stroke="${colors[k]}" stroke-width="${options.axes?2:2.3}" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;a.forEach((n,i)=>{if(n!==null)svg+=`<circle cx="${x(i)}" cy="${y(n)}" r="${a.length===1?4:2}" fill="${colors[k]}" opacity="${a.length===1?1:.45}"/>`})});feeds.forEach((f,i)=>{const title=`${new Date(f.created_at).toLocaleString()} · ${series.map((a,k)=>a[i]===null?'No reading':display(a[i])+(options.dual?(k?'%':'°C'):'')).join(' / ')}`;svg+=`<rect class="chart-hit" x="${x(i)-iw/Math.max(feeds.length,1)/2}" y="${t}" width="${Math.max(iw/Math.max(feeds.length,1),3)}" height="${ih}"><title>${escapeText(title)}</title></rect>`});return svg+'</svg>'}
function renderScatter(){const pairs=feeds.map(f=>[value(f,2),value(f,3),f.created_at]).filter(p=>p[0]!==null&&p[1]!==null);if(!pairs.length){$('scatter-chart').innerHTML='<div class="empty-chart">Waiting for paired sensor readings</div>';$('correlation-note').textContent='Waiting for paired sensor readings';return}const xs=pairs.map(p=>p[0]),ys=pairs.map(p=>p[1]);const xmin=Math.min(...xs)-2,xmax=Math.max(...xs)+2,ymin=Math.max(0,Math.min(...ys)-5),ymax=Math.max(...ys)+5;let svg='<svg viewBox="0 0 520 190" role="img" aria-label="Scatter plot: room temperature in Celsius against relative humidity in percent">';for(let j=0;j<4;j++){const y=12+j*138/3;svg+=`<line x1="43" x2="500" y1="${y}" y2="${y}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="34" y="${y+3}" text-anchor="end" fill="var(--muted)" font-size="9">${(ymax-j*(ymax-ymin)/3).toFixed(0)}%</text>`}for(let j=0;j<5;j++)svg+=`<text x="${43+j*457/4}" y="169" text-anchor="middle" fill="var(--muted)" font-size="9">${(xmin+j*(xmax-xmin)/4).toFixed(1)}°</text>`;pairs.forEach(p=>svg+=`<circle cx="${43+(p[0]-xmin)/(xmax-xmin)*457}" cy="${12+(ymax-p[1])/(ymax-ymin)*138}" r="4" fill="#8daa78" fill-opacity=".6"><title>${escapeText(time(p[2]))}: ${p[0]}°C / ${p[1]}%</title></circle>`);$('scatter-chart').innerHTML=svg+'</svg>';const n=pairs.length,mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;const cov=pairs.reduce((a,p)=>a+(p[0]-mx)*(p[1]-my),0),dx=xs.reduce((a,x)=>a+(x-mx)**2,0),dy=ys.reduce((a,y)=>a+(y-my)**2,0);$('correlation-note').textContent=n<3?'At least 3 paired readings needed for correlation':dx&&dy?`${n} paired readings · Pearson r = ${(cov/Math.sqrt(dx*dy)).toFixed(2)} · Association does not establish causation`:`${n} paired readings · Correlation unavailable for constant readings`}
function updateStatus() {
  const last=feeds.at(-1),channelStale=last&&Date.now()-Date.parse(last.created_at)>STALE_MS;
  const staleFields=Object.keys(readings).filter(field=>readingIsStale(field));
  $('connection-label').textContent=demo?'Sample mode':failure?(feeds.length?'Connection interrupted':'Feed unavailable'):!last?'Connecting':channelStale?'Stale readings':staleFields.length?'Some readings stale':'Live monitoring';
  $('connection-dot').className='status-dot '+(demo||failure||channelStale||staleFields.length?'error':'live');
  $('last-updated').textContent=last?(demo?'Latest sample entry · ':'Latest channel entry · ')+new Date(last.created_at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'No sensor readings received';
  const notice=$('notice');notice.hidden=false;
  if(demo)notice.innerHTML='Sample mode · These readings are illustrative. <button data-settings>Connect live channel →</button>';
  else if(failure)notice.innerHTML=escapeText(failure)+(Object.keys(readings).length?' Previously received values remain visible with their timestamps.':' No sensor values have been substituted.')+' <button data-settings>Connection settings →</button>';
  else if(staleFields.length)notice.textContent='Fields '+staleFields.join(', ')+' have not updated for over 2 minutes. Their last received values remain visible and are marked stale.';
  else notice.hidden=true;
  updateReadingLabels();
}
function render() {
  sensors.forEach(s=>{
    const n=latestValue(s.field);
    $('value-'+s.field).textContent=display(n,s.field===4?0:1);
    $('spark-'+s.field).innerHTML=chartSVG([feeds.map(f=>value(f,s.field))],[s.color]);
    $('start-'+s.field).textContent=feeds.length?time(feeds[0].created_at):'—';
    $('end-'+s.field).textContent=feeds.length?time(feeds.at(-1).created_at):'LATEST';
  });
  const body=latestValue(1),hum=latestValue(3),bodyState=sensorState(sensors[0],body),bodyAlert=isAlert(sensors[0],body);
  $('body-value').textContent=display(body);
  $('body-badge').textContent=bodyState;
  $('body-badge').className='badge '+(bodyAlert?'danger':body===null?'warning':'');
  $('gauge-fill').style.strokeDashoffset=body===null?100:100-Math.max(0,Math.min(100,(body-20)/25*100));
  $('gauge-fill').style.stroke=bodyAlert?'var(--danger)':'#81a56e';
  $('health-orbit').className='health-orbit '+(bodyAlert?'danger':'');
  $('health-symbol').textContent=bodyAlert?'!':'♡';
  $('health-title').textContent=body===null?'Awaiting readings':bodyAlert?'Temperature alert':'Within project range';
  $('health-description').textContent=body===null?'No valid Field 1 reading has been received.':bodyAlert?(body<28.5?'Latest reading is below your 28.5°C lower limit.':'Latest reading is above your 31.5°C upper limit.'):'Latest reading is within your 28.5–31.5°C project range.';
  $('humidity-value').textContent=display(hum,0);
  $('humidity-note').textContent=hum===null?'Waiting for classroom data':sensorState(sensors[2],hum)+' · Relative humidity';
  $('humidity-fill').style.width=(hum===null?0:Math.max(0,Math.min(100,hum)))+'%';
  const occ=latestValue(5),fan=latestValue(6),validOccupancy=occ!==null&&Number.isInteger(occ)&&occ>=0;
  $('occupancy-value').textContent=display(occ,Number.isInteger(occ)?0:1);
  $('seats').querySelectorAll('span').forEach((e,i)=>e.classList.toggle('filled',validOccupancy&&i<occ));
  $('seat-note').textContent=occ===null?'Awaiting occupancy reading':!validOccupancy?'Invalid occupancy count':occ>40?'Display shows the first 40 occupied seats':'Each block represents one count · 40-block display';
  $('fan-status').textContent=fan===1?'RUNNING':fan===0?'OFF':'UNKNOWN';
  $('fan').className='fan '+(fan===1?'spinning':'');
  $('fan-title').textContent=fan===1?'Keeping the air moving':fan===0?'Fan is currently off':'Waiting for fan status';
  const alerts=sensors.flatMap(s=>{
    const n=latestValue(s.field),invalid=n!==null&&s.field!==1&&(n<s.min||n>s.max);
    return n!==null&&(isAlert(s,n)||invalid)?[{s,n,invalid,reading:readings[s.field]}]:[];
  });
  const reporting=sensors.filter(s=>latestValue(s.field)!==null).length;
  $('alert-count').textContent=alerts.length;
  $('alert-badge').textContent=!reporting?'No data':alerts.length?alerts.length+' flagged':'No threshold alerts';
  $('alert-badge').className='badge '+(alerts.length?'danger':'');
  $('alert-list').innerHTML=!reporting?'<p class="muted">Connect your channel to evaluate sensor readings.</p>':alerts.length?alerts.map(({s,n,invalid,reading})=>{
    const rule=s.field===1?'Project alert < 28.5 or > 31.5 °C':'Project alert > '+s.threshold+' '+s.unit;
    return '<div class="alert-item danger"><span class="alert-icon">!</span><div><strong>'+s.name+': '+(invalid?'out of range':s.field===1&&n<28.5?'below lower limit':'above upper limit')+'</strong><small>'+display(n)+' '+s.unit+' · '+escapeText(invalid?'Check sensor calibration':rule)+'</small><small data-reading-field="'+s.field+'">'+escapeText(readingLabel(s.field))+'</small></div></div>';
  }).join(''):'<div class="alert-item"><span class="alert-icon">✓</span><div><strong>No project thresholds exceeded</strong><small>'+reporting+'/4 threshold sensors have received values; check their timestamps.</small></div></div><div class="alert-item"><span class="alert-icon">◷</span><div><strong>Independent sensor updates</strong><small>Each field keeps its latest valid reading.</small></div></div>';
  $('dual-chart').innerHTML=chartSVG([feeds.map(f=>value(f,2)),feeds.map(f=>value(f,3))],['#83a36e','#8fb4c7'],{axes:true,dual:true});
  renderScatter();updateStatus();
}
function sampleFeeds(){const now=Date.now();return Array.from({length:range},(_,i)=>{const z=i*.43;return{created_at:new Date(now-(range-1-i)*15000).toISOString(),entry_id:i+1,field1:(36.6+Math.sin(z)*.18).toFixed(1),field2:(24.1+Math.sin(z*.45)*.8+i/range*.3).toFixed(1),field3:(49+Math.cos(z*.45)*3+Math.sin(z)*1.2).toFixed(1),field4:String(Math.round(186+Math.sin(z)*23+Math.cos(z*2)*7)),field5:'24',field6:'1'}})}
async function fetchData(){if(busy)return;busy=true;const current=++generation;$('refresh-button').disabled=true;$('refresh-button').querySelector('span').textContent='Updating…';controller=new AbortController();const timer=setTimeout(()=>controller?.abort(),12000);try{if(demo){feeds=sampleFeeds();mergeReadings(feeds);failure='';lastFetch=new Date();render();return}const url=new URL('https://api.thingspeak.com/channels/3519098/feeds.json');url.searchParams.set('results',Math.max(range,120));if(readKey)url.searchParams.set('api_key',readKey);const response=await fetch(url,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error('http');const data=await response.json();if(current!==generation)return;if(!data||!Array.isArray(data.feeds))throw new Error('private');const next=data.feeds.filter(f=>f&&Number.isFinite(Date.parse(f.created_at))).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));if(!next.length)throw new Error('empty');mergeReadings(next);feeds=next.slice(-range);failure='';lastFetch=new Date();render()}catch(e){if(current!==generation)return;failure=e.message==='empty'?'The channel returned no readings.':e.message==='private'?'The feed is unavailable. A private channel needs its read API key.':'Could not read the live channel. Check the connection or add a read API key for a private channel.';render()}finally{clearTimeout(timer);if(current===generation){busy=false;controller=null;$('refresh-button').disabled=false;$('refresh-button').querySelector('span').textContent='Refresh'}}}
function restart(clearReadings=true){generation++;controller?.abort();busy=false;if(clearReadings){feeds=[];readings={};}failure='';render();fetchData()}
$('settings-button').onclick=()=>$('settings').showModal();$('close-settings').onclick=()=>$('settings').close();document.addEventListener('click',e=>{if(e.target.closest('[data-settings]'))$('settings').showModal()});$('settings-form').onsubmit=e=>{e.preventDefault();readKey=$('read-key').value.trim();demo=$('demo-mode').checked;$('settings').close();restart()};$('refresh-button').onclick=fetchData;$('range-controls').onclick=e=>{const b=e.target.closest('[data-range]');if(!b)return;range=Number(b.dataset.range);document.querySelectorAll('[data-range]').forEach(x=>x.classList.toggle('selected',x===b));restart(false)};$('export-button').onclick=()=>{if(!feeds.length){toast('No readings available to export yet');return}const rows=[['mode','timestamp','entry_id','body_temperature_c','room_temperature_c','humidity_percent','mq2_ppm','occupancy_cps','fan_status'],...feeds.map(f=>[demo?'sample':'channel',new Date(f.created_at).toISOString(),Number.isFinite(Number(f.entry_id))?Number(f.entry_id):'',...Array.from({length:6},(_,i)=>value(f,i+1)??'')])];const blob=new Blob([rows.map(r=>r.join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`classpulse-${demo?'sample':'channel'}-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Sensor history exported')};$('theme-button').onclick=()=>{document.body.classList.toggle('dark');const dark=document.body.classList.contains('dark');$('theme-button').textContent=dark?'☀':'☾';try{localStorage.setItem('classpulse-theme',dark?'dark':'light')}catch{}};try{if(localStorage.getItem('classpulse-theme')==='dark'){$('theme-button').click()}}catch{}document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>{document.querySelectorAll('nav a').forEach(x=>x.classList.remove('active'));a.classList.add('active')});$('header-date').textContent=new Date().toLocaleDateString([], {weekday:'short',day:'numeric',month:'short',year:'numeric'});render();fetchData();setInterval(()=>{if(!document.hidden)fetchData()},15000);setInterval(updateStatus,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)fetchData()});
