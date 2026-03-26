/**
 * CRMTR v5 — Container Resource Monitor
 * Real Docker only.
 * Tabs: Overview · Live Charts · Containers · Alerts · Prediction
 *       Health · Heatmap · Network · Inspector
 */

const CONFIG = {
  tickMs:2000, histMax:120, sparkLen:30,
  thresholds:{ cpuCrit:85, cpuWarn:70, memCrit:88, memWarn:75, netWarn:80, idle:5 },
};

let S={}, H={}, liveContainers=[], alerts=[], evList=[];
let tick=0, paused=false, selId=null, t0=Date.now();
let cCpu=null,cMem=null,cNet=null,cDisk=null,cFleet=null;
let cPredLR=null,cPredEMA=null,predCid=null;

// ── FETCH DOCKER METRICS ──────────────────
async function fetchDockerMetrics() {
  try {
    const res=await fetch('/api/containers'), data=await res.json();
    if(data.error){ setStatus(false,data.error.split('\n')[0].slice(0,90)); return; }
    if(!data.containers.length){ setStatus(true,'No containers running'); liveContainers=[]; return; }
    const ts=Date.now();
    liveContainers=data.containers.map(c=>({
      id:c.id, name:c.name,
      st:c.cpu>CONFIG.thresholds.cpuCrit?'critical':c.cpu>CONFIG.thresholds.cpuWarn?'warning':'running',
      cl:4, ml:c.memLimit||1024,
    }));
    data.containers.forEach(c=>{
      S[c.id]={cpu:c.cpu,mem:c.mem,net:c.net,dk:c.dk,
               cpuA:(c.cpu/100*4).toFixed(2),memA:Math.round(c.memUsed),
               memLimit:c.memLimit,pids:c.pids};
      if(!H[c.id]) H[c.id]=[];
      H[c.id].push({cpu:c.cpu,mem:c.mem,net:c.net,dk:c.dk,ts});
      if(H[c.id].length>CONFIG.histMax) H[c.id].shift();
    });
    buildAlerts();
    setStatus(true,`${liveContainers.length} container${liveContainers.length!==1?'s':''} running`);
    if(!selId||!liveContainers.find(c=>c.id===selId)) selId=liveContainers[0]?.id||null;
    document.getElementById('c-count').textContent=liveContainers.length;
  } catch(e){ setStatus(false,'Fetch: '+e.message); }
}

// ── FETCH EVENTS ──────────────────────────
async function fetchEvents() {
  try {
    const r=await fetch('/api/events'), d=await r.json();
    if(d.events?.length){
      evList=[...d.events,...evList].slice(0,100);
      renderEvents();
      d.events.forEach(ev=>{
        if(['die','kill'].includes(ev.type)) fetchDockerMetrics();
        if(ev.type==='start')               setTimeout(fetchDockerMetrics,800);
      });
    }
  } catch(_){}
}

function setStatus(ok,msg) {
  const dot=document.getElementById('live-dot');
  const txt=document.getElementById('env-txt');
  const ban=document.getElementById('docker-err-banner');
  if(ok){
    if(dot){dot.style.background='#00d4ff';dot.style.boxShadow='0 0 7px #00d4ff';}
    if(txt) txt.textContent='LIVE · '+msg;
    if(ban) ban.style.display='none';
  } else {
    if(dot){dot.style.background='#ff3d3d';dot.style.boxShadow='0 0 7px #ff3d3d';}
    if(txt) txt.textContent='Error';
    if(ban){ban.style.display='flex';ban.textContent='⚠ '+msg+' — Is Docker Desktop running?';}
  }
}

// ── ALERTS ────────────────────────────────
function buildAlerts() {
  const na=[],t=CONFIG.thresholds;
  liveContainers.forEach(c=>{
    const s=S[c.id]; if(!s) return;
    const tm=new Date().toLocaleTimeString('en',{hour12:false});
    if(s.cpu>t.cpuCrit)      na.push({lv:'danger',cn:c.name,title:'Critical CPU',   sub:`${s.cpu}%`,tm});
    else if(s.cpu>t.cpuWarn) na.push({lv:'warn',  cn:c.name,title:'High CPU',       sub:`${s.cpu}%`,tm});
    if(s.mem>t.memCrit)      na.push({lv:'danger',cn:c.name,title:'Memory critical',sub:`${s.memA}MB (${s.mem}%)`,tm});
    else if(s.mem>t.memWarn) na.push({lv:'warn',  cn:c.name,title:'Memory elevated',sub:`${s.mem}%`,tm});
    if(s.net>t.netWarn)      na.push({lv:'warn',  cn:c.name,title:'High network',   sub:`${s.net} MB/s`,tm});
  });
  alerts=na.slice(0,12);
  const dc=alerts.filter(a=>a.lv==='danger').length;
  const ab=document.getElementById('abadge');
  if(ab){ab.textContent=dc||'';ab.style.display=dc>0?'inline':'none';}
}

// ── HELPERS ───────────────────────────────
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const cpuCol=v=>v>85?'#ff3d3d':v>70?'#ffaa00':'#00d4ff';
const memCol=v=>v>85?'#ff3d3d':v>70?'#ffaa00':'#00ff88';
const SCOL={running:'#00ff88',warning:'#ffaa00',critical:'#ff3d3d',stopped:'#4a5568'};
const CC=['#00d4ff','#00ff88','#ff6b35','#ffd700','#b06cff','#ff3d3d','#ffaa00','#4a9eff'];
const escHtml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── ML MODELS ─────────────────────────────
function linReg(vals) {
  const n=vals.length;
  if(n<3) return {slope:0,pred:vals[n-1]||0,trend:'stable',conf:0,fitted:vals.slice()};
  const mx=(n-1)/2,my=vals.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;
  vals.forEach((y,i)=>{num+=(i-mx)*(y-my);den+=(i-mx)**2;});
  const slope=den?num/den:0,b0=my-slope*mx;
  const fitted=vals.map((_,i)=>clamp(b0+slope*i,0,100));
  const pred=clamp(b0+slope*(n-1+15),0,100);
  const ssTot=vals.reduce((s,y)=>s+(y-my)**2,0);
  const ssRes=vals.reduce((s,y,i)=>s+(y-fitted[i])**2,0);
  const r2=ssTot?clamp(1-ssRes/ssTot,0,1):1;
  const trend=slope>1.5?'up':slope<-1.5?'down':slope>0.5?'warn':'stable';
  return {slope:Math.round(slope*100)/100,pred:Math.round(pred*10)/10,trend,conf:Math.round(r2*100),fitted};
}

function ema(vals,alpha=0.3) {
  const n=vals.length;
  if(n<3) return {slope:0,pred:vals[n-1]||0,trend:'stable',conf:0,smoothed:vals.slice()};
  const sm=[vals[0]];
  for(let i=1;i<n;i++) sm.push(alpha*vals[i]+(1-alpha)*sm[i-1]);
  const tail=sm.slice(-5),tSlope=(tail[tail.length-1]-tail[0])/Math.max(tail.length-1,1);
  const pred=clamp(sm[n-1]+tSlope*15,0,100);
  const mae=vals.reduce((s,v,i)=>s+Math.abs(v-sm[i]),0)/n;
  const trend=tSlope>1.5?'up':tSlope<-1.5?'down':tSlope>0.5?'warn':'stable';
  return {slope:Math.round(tSlope*100)/100,pred:Math.round(pred*10)/10,trend,conf:Math.round(clamp(100-mae*2,0,100)),smoothed:sm};
}

const TRCFG={up:{icon:'↑',lbl:'INCREASING',cls:'trend-up',card:'pred-up'},down:{icon:'↓',lbl:'DECREASING',cls:'trend-down',card:'pred-down'},stable:{icon:'→',lbl:'STABLE',cls:'trend-stable',card:'pred-stable'},warn:{icon:'↗',lbl:'RISING',cls:'trend-warn',card:'pred-warn'}};

function getSuggestions() {
  const out=[];
  liveContainers.forEach(c=>{
    const s=S[c.id]; if(!s) return;
    if(s.cpu>80)   out.push({ico:'📈',title:`Scale ${c.name}`,sub:`CPU ${s.cpu}% — consider replicas`,badge:'SCALE',bc:'sb-scale'});
    if(s.memA>300) out.push({ico:'💾',title:`Optimise ${c.name}`,sub:`Using ${s.memA}MB — check for leaks`,badge:'MEM',bc:'sb-mem'});
    if(s.cpu<5)    out.push({ico:'⚡',title:`${c.name} underutilised`,sub:`CPU ${s.cpu}% — downsize`,badge:'IDLE',bc:'sb-idle'});
  });
  return out.slice(0,5);
}

// ── CHARTS ────────────────────────────────
function chartOpts(yMax, warnAt, critAt){
  return {responsive:true,maintainAspectRatio:false,
    // Smooth transition between data points — NOT a CSS animation
    // This creates the "spike appears instantly then line draws" effect
    animation:{ duration:400, easing:'easeOutQuart' },
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{backgroundColor:'#13161b',borderColor:'#2a3140',borderWidth:1,
        titleColor:'#8a95a3',bodyColor:'#e8ecf0',
        titleFont:{family:"'Space Mono',monospace",size:10},
        bodyFont:{family:"'Space Mono',monospace",size:11},padding:8},
    },
    scales:{
      x:{ticks:{color:'#4a5568',font:{family:"'Space Mono',monospace",size:8},maxTicksLimit:8,maxRotation:0},grid:{color:'rgba(31,37,46,.8)'}},
      y:{min:0,max:yMax,
        ticks:{color:'#4a5568',font:{family:"'Space Mono',monospace",size:8},maxTicksLimit:5},
        grid:{color:'rgba(31,37,46,.8)'},
        // Draw threshold lines directly on Y axis as grid lines
        afterDataLimits(axis){axis.max=Math.max(axis.max,yMax||100);},
      },
    },
  };
}

function mkLine(id,color,yMax,warnAt,critAt){
  const el=document.getElementById(id); if(!el) return null;
  const chart = new Chart(el,{type:'line',data:{labels:[],datasets:[{
    data:[], fill:true, tension:0.4, borderWidth:2.5,
    borderColor: color,
    backgroundColor: color+'22',
    // pointRadius and pointBackgroundColor are arrays — set per data point
    pointRadius: [],
    pointBackgroundColor: [],
    pointBorderColor: [],
    pointBorderWidth: [],
    // Store thresholds on dataset for use in pushCharts
    _warn: warnAt,
    _crit: critAt,
    _baseColor: color,
  }]},options:chartOpts(yMax,warnAt,critAt)});
  // Store threshold lines as reference lines rendered via plugin
  if(warnAt||critAt){
    chart._warnAt=warnAt;
    chart._critAt=critAt;
    chart._baseColor=color;
  }
  return chart;
}

function initCharts(){
  [cCpu,cMem,cNet,cDisk,cFleet].forEach(c=>c&&c.destroy());
  const t=CONFIG.thresholds;
  cCpu=mkLine('chart-cpu','#00d4ff',100, t.cpuWarn, t.cpuCrit);
  cMem=mkLine('chart-mem','#00ff88',100, t.memWarn, t.memCrit);
  cNet=mkLine('chart-net','#ff6b35',120, t.netWarn, null);
  cDisk=mkLine('chart-disk','#ffd700',90, null, null);
  const fEl=document.getElementById('chart-fleet');
  if(fEl) cFleet=new Chart(fEl,{type:'bar',
    data:{labels:liveContainers.map(c=>c.name),datasets:[{data:liveContainers.map(c=>S[c.id]?.cpu||0),backgroundColor:CC.map(c=>c+'88'),borderColor:CC,borderWidth:1,borderRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:'#4a5568',font:{family:"'Space Mono',monospace",size:8},maxRotation:28},grid:{color:'rgba(31,37,46,.8)'}},
              y:{min:0,max:100,ticks:{color:'#4a5568',font:{family:"'Space Mono',monospace",size:8},maxTicksLimit:5},grid:{color:'rgba(31,37,46,.8)'}}}}});
  const cid=getChartCid(),win=getWin();
  (H[cid]||[]).slice(-win).forEach(d=>pushCharts(d,false));
  updateChartVals();
}

function pointColor(val, ds) {
  const crit = ds._crit, warn = ds._warn, base = ds._baseColor || '#00d4ff';
  if (crit && val >= crit) return '#ff3d3d';
  if (warn && val >= warn) return '#ffaa00';
  return base;
}

function pushCharts(d, doUpdate=true){
  const cid=getChartCid(), win=getWin(), lbl=new Date(d.ts).toLocaleTimeString('en',{hour12:false});

  function push(ch, val) {
    if(!ch) return;
    const ds = ch.data.datasets[0];
    const v  = Math.round(val*10)/10;
    const col = pointColor(v, ds);
    const isCrit = ds._crit && v >= ds._crit;
    const isWarn = ds._warn && v >= ds._warn;
    const isSpike = isCrit || isWarn;

    ch.data.labels.push(lbl);
    ds.data.push(v);
    // Spike points get a visible dot + glow; normal points invisible
    ds.pointRadius.push(isSpike ? 5 : 0);
    ds.pointBackgroundColor.push(col);
    ds.pointBorderColor.push(isSpike ? '#fff' : col);
    ds.pointBorderWidth.push(isSpike ? 1.5 : 0);

    // Trim to window
    while(ch.data.labels.length > win){
      ch.data.labels.shift();
      ds.data.shift();
      ds.pointRadius.shift();
      ds.pointBackgroundColor.shift();
      ds.pointBorderColor.shift();
      ds.pointBorderWidth.shift();
    }

    // Update border colour to reflect current severity
    ds.borderColor = col;
    ds.backgroundColor = col + '22';

    if(doUpdate) ch.update({ duration:400, easing:'easeOutQuart' });
  }

  push(cCpu,  d.cpu);
  push(cMem,  d.mem);
  push(cNet,  d.net);
  push(cDisk, d.dk);
}

function tickCharts(){
  const cid=getChartCid(),s=S[cid]; if(!s) return;
  pushCharts({...s,ts:Date.now()});
  if(cFleet){
    const t=CONFIG.thresholds;
    cFleet.data.labels=liveContainers.map(c=>c.name);
    cFleet.data.datasets[0].data=liveContainers.map(c=>S[c.id]?.cpu||0);
    // Fleet bar: colour each bar based on severity
    cFleet.data.datasets[0].backgroundColor=liveContainers.map((c,i)=>{
      const cpu=S[c.id]?.cpu||0;
      return cpu>=t.cpuCrit?'#ff3d3d88':cpu>=t.cpuWarn?'#ffaa0088':CC[i%CC.length]+'88';
    });
    cFleet.data.datasets[0].borderColor=liveContainers.map((c,i)=>{
      const cpu=S[c.id]?.cpu||0;
      return cpu>=t.cpuCrit?'#ff3d3d':cpu>=t.cpuWarn?'#ffaa00':CC[i%CC.length];
    });
    cFleet.update({duration:400,easing:'easeOutQuart'});
  }
  updateChartVals();
}

function updateChartVals(){
  const s=S[getChartCid()]||{};
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  set('chart-cpu-val',`${(s.cpu||0).toFixed(1)}%`);set('chart-mem-val',`${(s.mem||0).toFixed(1)}%`);
  set('chart-net-val',`${(s.net||0).toFixed(1)} MB/s`);set('chart-disk-val',`${(s.dk||0).toFixed(1)} MB/s`);
}

function rebuildCharts(){[cCpu,cMem,cNet,cDisk,cFleet].forEach(c=>c&&c.destroy());cCpu=cMem=cNet=cDisk=cFleet=null;initCharts();}
const getChartCid=()=>document.getElementById('chart-container-sel')?.value||liveContainers[0]?.id;
const getWin=()=>parseInt(document.getElementById('chart-window-sel')?.value||'60');

// ── PREDICTION CHARTS ─────────────────────
function predOpts(){
  return {responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:true,labels:{color:'#8a95a3',font:{family:"'Space Mono',monospace",size:9},boxWidth:10,padding:10}},
      tooltip:{backgroundColor:'#13161b',borderColor:'#2a3140',borderWidth:1,titleColor:'#8a95a3',bodyColor:'#e8ecf0',titleFont:{family:"'Space Mono',monospace",size:10},bodyFont:{family:"'Space Mono',monospace",size:11},padding:8}},
    scales:{x:{ticks:{color:'#4a5568',font:{family:"'Space Mono',monospace",size:8},maxTicksLimit:10,maxRotation:0},grid:{color:'rgba(31,37,46,.8)'}},
            y:{min:0,max:100,ticks:{color:'#4a5568',font:{family:"'Space Mono',monospace",size:8},maxTicksLimit:5},grid:{color:'rgba(31,37,46,.8)'}}}};
}

function buildPredChart(cid){
  if(cPredLR){cPredLR.destroy();cPredLR=null;} if(cPredEMA){cPredEMA.destroy();cPredEMA=null;}
  const h=H[cid]||[],vals=h.map(d=>d.cpu),n=vals.length; if(n<3) return;
  const hL=h.map(d=>new Date(d.ts).toLocaleTimeString('en',{hour12:false}));
  const fL=[];for(let i=1;i<=15;i++) fL.push(new Date(Date.now()+i*2000).toLocaleTimeString('en',{hour12:false}));
  const allL=[...hL,...fL],crit=Array(allL.length).fill(85);
  const lr=linReg(vals),lrCol=lr.trend==='up'?'#ff3d3d':lr.trend==='down'?'#00ff88':'#ffaa00';
  const lrF=Array(n-1).fill(null).concat([vals[n-1]]);
  for(let i=1;i<=15;i++) lrF.push(clamp(vals[n-1]+lr.slope*i,0,100));
  const elLR=document.getElementById('chart-predict-lr');
  if(elLR) cPredLR=new Chart(elLR,{type:'line',data:{labels:allL,datasets:[
    {label:'actual',data:[...vals,...Array(15).fill(null)],borderColor:'#00d4ff',backgroundColor:'#00d4ff18',borderWidth:2,pointRadius:0,fill:true,tension:0.35},
    {label:'OLS fitted',data:[...lr.fitted,...Array(15).fill(null)],borderColor:'#ffffff33',backgroundColor:'transparent',borderWidth:1,borderDash:[2,3],pointRadius:0,tension:0},
    {label:`OLS forecast (R²=${lr.conf}%)`,data:lrF,borderColor:lrCol,backgroundColor:'transparent',borderWidth:2.5,borderDash:[6,3],pointRadius:0,tension:0.25},
    {label:'Critical 85%',data:crit,borderColor:'rgba(255,61,61,.3)',backgroundColor:'transparent',borderWidth:1,borderDash:[2,5],pointRadius:0},
  ]},options:predOpts()});
  const em=ema(vals,0.3),emCol=em.trend==='up'?'#ff3d3d':em.trend==='down'?'#00ff88':'#ffaa00';
  const emF=Array(n-1).fill(null).concat([em.smoothed[n-1]]);
  for(let i=1;i<=15;i++) emF.push(clamp(em.smoothed[n-1]+em.slope*i,0,100));
  const elEMA=document.getElementById('chart-predict-ema');
  if(elEMA) cPredEMA=new Chart(elEMA,{type:'line',data:{labels:allL,datasets:[
    {label:'actual',data:[...vals,...Array(15).fill(null)],borderColor:'#b06cff',backgroundColor:'#b06cff18',borderWidth:2,pointRadius:0,fill:true,tension:0.35},
    {label:'EMA smoothed',data:[...em.smoothed,...Array(15).fill(null)],borderColor:'#ffffff44',backgroundColor:'transparent',borderWidth:1.5,borderDash:[3,2],pointRadius:0,tension:0.5},
    {label:`EMA forecast (conf=${em.conf}%)`,data:emF,borderColor:emCol,backgroundColor:'transparent',borderWidth:2.5,borderDash:[6,3],pointRadius:0,tension:0.25},
    {label:'Critical 85%',data:crit,borderColor:'rgba(255,61,61,.3)',backgroundColor:'transparent',borderWidth:1,borderDash:[2,5],pointRadius:0},
  ]},options:predOpts()});
  predCid=cid;
  const el=document.getElementById('model-compare-row'); if(!el) return;
  const now=(S[cid]?.cpu||0).toFixed(1);
  const diff=v=>{const d=Math.round((v-parseFloat(now))*10)/10;const c=d>0?'#ff3d3d':d<0?'#00ff88':'#8a95a3';return `<span style="color:${c};font-size:10px;font-family:var(--mono)">${d>0?'+':''}${d}% in 30s</span>`;};
  el.innerHTML=`
    <div class="model-card mc-lr"><div class="mc-label">OLS Linear Regression</div><div class="mc-formula">ŷ = β₀ + β₁x</div>
      <div class="mc-now">${now}<span class="mc-unit">% now</span></div>
      <div class="mc-pred" style="color:${cpuCol(lr.pred)}">${lr.pred}%</div><div class="mc-sub">in ~30s</div>${diff(lr.pred)}
      <div class="mc-stats"><span>slope: ${lr.slope}/tick</span><span>R²: ${lr.conf}%</span></div>
      <div class="mc-note">Best for steady trends. High R² = trustworthy.</div></div>
    <div class="model-card mc-ema"><div class="mc-label">Exponential Moving Avg</div><div class="mc-formula">EMAₜ = 0.3·xₜ + 0.7·EMAₜ₋₁</div>
      <div class="mc-now">${now}<span class="mc-unit">% now</span></div>
      <div class="mc-pred" style="color:${cpuCol(em.pred)}">${em.pred}%</div><div class="mc-sub">in ~30s</div>${diff(em.pred)}
      <div class="mc-stats"><span>slope: ${em.slope}/tick</span><span>conf: ${em.conf}%</span></div>
      <div class="mc-note">Best for volatile metrics. Reacts faster.</div></div>`;
}

function rebuildPredictChart(){predCid=null;const cid=document.getElementById('pred-container-sel')?.value||liveContainers[0]?.id;if(cid) buildPredChart(cid);}

// ── RENDER: SIDEBAR ───────────────────────
function renderSidebar(){
  const el=document.getElementById('clist');
  if(!liveContainers.length){el.innerHTML=`<div style="padding:20px 14px;font-size:10px;color:var(--t3);font-family:var(--mono);text-align:center;line-height:1.8">No containers.<br><br>docker run -d --name web nginx</div>`;return;}
  el.innerHTML=liveContainers.map(c=>{
    const s=S[c.id]||{},col=SCOL[c.st]||'#4a5568';
    return `<div class="c-item ${c.id===selId?'sel':''}" onclick="selCont('${c.id}')">
      <div class="ci-status" style="background:${col};box-shadow:0 0 5px ${col}55"></div>
      <div class="ci-info"><div class="ci-name">${c.name}</div></div>
      <div class="ci-perf"><div class="ci-cpu-val" style="color:${cpuCol(s.cpu||0)}">${(s.cpu||0).toFixed(0)}%</div><div class="ci-mem-val">${(s.mem||0).toFixed(0)}m</div></div>
    </div>`;
  }).join('');
}

function renderMiniStats(){
  if(!liveContainers.length){document.getElementById('mini-stats').innerHTML='';return;}
  const ca=liveContainers.reduce((s,c)=>s+(S[c.id]?.cpu||0),0)/liveContainers.length;
  const ma=liveContainers.reduce((s,c)=>s+(S[c.id]?.mem||0),0)/liveContainers.length;
  const dc=alerts.filter(a=>a.lv==='danger').length;
  document.getElementById('mini-stats').innerHTML=
    `<div class="ms-item"><div class="ms-dot" style="background:#00d4ff"></div>CPU ${ca.toFixed(0)}%</div>
     <div class="ms-item"><div class="ms-dot" style="background:#00ff88"></div>MEM ${ma.toFixed(0)}%</div>
     ${dc?`<div class="ms-item"><div class="ms-dot" style="background:#ff3d3d"></div>${dc} CRIT</div>`:''}`;
}

// ── RENDER: OVERVIEW ──────────────────────
function renderOverview(){
  const ac=liveContainers;
  if(!ac.length){document.getElementById('m-grid').innerHTML=`<div style="grid-column:1/-1;padding:30px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">Start Docker containers to see metrics.</div>`;return;}
  const ca=ac.reduce((s,c)=>s+(S[c.id]?.cpu||0),0)/ac.length;
  const ma=ac.reduce((s,c)=>s+(S[c.id]?.mem||0),0)/ac.length;
  const nt=ac.reduce((s,c)=>s+(S[c.id]?.net||0),0);
  const dt=ac.reduce((s,c)=>s+(S[c.id]?.dk||0),0);
  document.getElementById('m-grid').innerHTML=`
    <div class="m-card c-cpu"><div class="mc-icon">CPU · avg</div><div class="mc-val" style="color:${cpuCol(ca)}">${ca.toFixed(1)}<span class="mc-unit">%</span></div><div class="mc-label">${ac.length} containers</div></div>
    <div class="m-card c-mem"><div class="mc-icon">MEMORY · avg</div><div class="mc-val" style="color:${memCol(ma)}">${ma.toFixed(1)}<span class="mc-unit">%</span></div><div class="mc-label">fleet-wide</div></div>
    <div class="m-card c-net"><div class="mc-icon">NETWORK · total</div><div class="mc-val" style="color:#ff6b35">${nt.toFixed(1)}<span class="mc-unit" style="font-size:11px"> MB/s</span></div><div class="mc-label">combined</div></div>
    <div class="m-card c-disk"><div class="mc-icon">DISK · total</div><div class="mc-val" style="color:#ffd700">${dt.toFixed(1)}<span class="mc-unit" style="font-size:11px"> MB/s</span></div><div class="mc-label">combined</div></div>`;
  function spark(id,data,col,maxV=100){
    const sl=data.slice(-CONFIG.sparkLen),mx=Math.max(...sl,maxV*0.1);
    document.getElementById(id).innerHTML='<div class="sp-line"></div>'+sl.map(v=>{
      const ht=Math.round((v/mx)*58)+2,op=(0.4+0.6*(v/mx)).toFixed(2);
      return `<div class="sp-bar" style="height:${ht}px;background:${maxV===100&&v>85?'#ff3d3d':col};opacity:${op}"></div>`;
    }).join('');
  }
  const fc=ac[0],h=H[fc?.id]||[];
  spark('sp-cpu',h.map(d=>d.cpu),'#00d4ff');spark('sp-mem',h.map(d=>d.mem),'#00ff88');
  spark('sp-net',h.map(d=>d.net),'#ff6b35',80);spark('sp-disk',h.map(d=>d.dk),'#ffd700',60);
  const s=S[fc?.id]||{};
  document.getElementById('cv-cpu').textContent=`${(s.cpu||0).toFixed(1)}%`;
  document.getElementById('cv-mem').textContent=`${(s.mem||0).toFixed(1)}%`;
  document.getElementById('cv-net').textContent=`${(s.net||0).toFixed(1)} MB/s`;
  document.getElementById('cv-disk').textContent=`${(s.dk||0).toFixed(1)} MB/s`;
  const ael=document.getElementById('ov-alerts');
  ael.innerHTML=alerts.length?alerts.slice(0,3).map(aHTML).join(''):`<div class="alert-box ok"><div class="a-icon" style="color:#00ff88">◇</div><div class="a-cont"><div class="a-title">All systems nominal</div></div></div>`;
  const sugs=getSuggestions();
  document.getElementById('ov-suggestions').innerHTML=sugs.length
    ?sugs.map(s=>`<div class="sug-item"><div class="sug-ico">${s.ico}</div><div class="sug-body"><div class="sug-title">${s.title}<span class="sug-badge ${s.bc}">${s.badge}</span></div><div class="sug-sub">${s.sub}</div></div></div>`).join('')
    :`<div class="sug-item"><div class="sug-ico">✓</div><div class="sug-body"><div class="sug-title" style="color:var(--ok)">No actions needed</div></div></div>`;
}

// ── RENDER: CONTAINERS ────────────────────
function renderContainers(){
  const el=document.getElementById('cont-grid'); if(!el) return;
  if(!liveContainers.length){el.innerHTML=`<div style="grid-column:1/-1;padding:30px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">No containers running.</div>`;return;}
  el.innerHTML=liveContainers.map(c=>{
    const s=S[c.id]||{},dot=SCOL[c.st]||'#4a5568',stc={running:'sp-run',warning:'sp-warn',critical:'sp-crit'}[c.st]||'sp-run';
    return `<div class="cont-card">
      <div class="cc-header">
        <div class="cc-dot" style="background:${dot};box-shadow:0 0 7px ${dot}55"></div>
        <span class="cc-name">${c.name}</span><span class="cc-status-pill ${stc}">${c.st}</span>
        <button class="edit-limits-btn" onclick="openLimitsModal('${c.id}','${c.name}')">✎ limits</button>
      </div>
      ${mBar('CPU',(s.cpu||0).toFixed(1),'%',cpuCol(s.cpu||0))}
      ${mBar('MEM',(s.mem||0).toFixed(1),'%',memCol(s.mem||0))}
      ${mBar('NET',(s.net||0).toFixed(1),' MB/s','#ff6b35',120)}
      ${mBar('DISK',(s.dk||0).toFixed(1),' MB/s','#ffd700',90)}
      <div style="margin-top:8px;font-size:9px;font-family:var(--mono);color:var(--t3)">PIDs: ${s.pids||0} · Mem: ${(s.memA||0)}/${(s.memLimit||0).toFixed(0)}MB</div>
    </div>`;
  }).join('');
}

function mBar(lbl,val,unit,col,max=100){
  const pct=Math.min(Math.round((val/max)*100),100);
  return `<div class="mr-row"><div class="mr-head"><span class="mr-lbl">${lbl}</span><span class="mr-num" style="color:${col}">${val}${unit}</span></div><div class="track"><div class="fill" style="width:${pct}%;background:${col}"></div></div></div>`;
}

// ── LIMITS MODAL ──────────────────────────
let limitsModal=null;
function openLimitsModal(cid,name){
  if(limitsModal) limitsModal.remove();
  const s=S[cid]||{};
  const m=document.createElement('div');
  m.className='modal-overlay';
  m.innerHTML=`<div class="modal-box">
    <div class="modal-title">Edit limits · <span style="color:var(--cpu)">${name}</span></div>
    <div class="limits-row"><span class="limits-label">CPU cores</span><input class="limits-input" id="lim-cpu" type="number" min="0.1" max="32" step="0.1" placeholder="e.g. 2.0"/><span class="limits-hint">currently ${s.cpuA||'?'} cores</span></div>
    <div class="limits-row"><span class="limits-label">Memory</span><input class="limits-input" id="lim-mem" type="text" placeholder="512m or 1g"/><span class="limits-hint">currently ${(s.memLimit||0).toFixed(0)}MB</span></div>
    <div id="lim-result" style="min-height:18px;font-size:10px;font-family:var(--mono);margin:6px 0"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn accent" onclick="applyLimits('${name}')">APPLY</button>
      <button class="btn" onclick="closeLimitsModal()">CANCEL</button>
    </div>
  </div>`;
  m.addEventListener('click',e=>{ if(e.target===m) closeLimitsModal(); });
  document.body.appendChild(m);
  limitsModal=m;
}
function closeLimitsModal(){ if(limitsModal){limitsModal.remove();limitsModal=null;} }
async function applyLimits(name){
  const cpus=document.getElementById('lim-cpu')?.value.trim();
  const mem =document.getElementById('lim-mem')?.value.trim();
  const res =document.getElementById('lim-result');
  if(!cpus&&!mem){if(res)res.textContent='Enter at least one value.';return;}
  if(res)res.innerHTML=`<span style="color:var(--t2)">Applying…</span>`;
  try{
    const r=await fetch('/api/limits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,cpus:cpus||undefined,memory:mem||undefined})});
    const d=await r.json();
    if(d.ok){if(res)res.innerHTML=`<span style="color:var(--ok)">✓ Applied successfully</span>`;setTimeout(closeLimitsModal,1200);}
    else{if(res)res.innerHTML=`<span style="color:var(--danger)">✗ ${escHtml(d.error)}</span>`;}
  }catch(e){if(res)res.innerHTML=`<span style="color:var(--danger)">✗ ${e.message}</span>`;}
}

// ── RENDER: ALERTS ────────────────────────
function aHTML(a){return `<div class="alert-box ${a.lv}"><div class="a-icon" style="color:${a.lv==='danger'?'#ff3d3d':'#ffaa00'}">${a.lv==='danger'?'▲':'△'}</div><div class="a-cont"><div class="a-title"><span class="a-cname">${a.cn}</span>${a.title}</div><div class="a-sub">${a.sub}</div></div><div class="a-time">${a.tm}</div></div>`;}
function renderAlerts(){
  const el=document.getElementById('all-alerts'); if(!el) return;
  const st=document.getElementById('alert-summary-txt');
  if(st)st.textContent=`${alerts.filter(a=>a.lv==='danger').length} critical · ${alerts.filter(a=>a.lv==='warn').length} warnings`;
  el.innerHTML=alerts.length?alerts.map(aHTML).join(''):`<div class="alert-box ok"><div class="a-icon" style="color:#00ff88">◇</div><div class="a-cont"><div class="a-title">No active alerts</div></div></div>`;
}
function renderAlertRules(){
  const el=document.getElementById('rule-grid'); if(!el) return;
  el.innerHTML=[{cond:'CPU > 85%',l:'CRITICAL',c:'rb-d'},{cond:'CPU > 70%',l:'WARNING',c:'rb-w'},{cond:'Memory > 88%',l:'CRITICAL',c:'rb-d'},{cond:'Memory > 75%',l:'WARNING',c:'rb-w'},{cond:'Net > 80 MB/s',l:'WARNING',c:'rb-w'},{cond:'CPU < 5%',l:'IDLE',c:'rb-w'}]
    .map(r=>`<div class="rule-card"><span class="rule-cond">${r.cond}</span><span class="rule-badge ${r.c}">${r.l}</span></div>`).join('');
}
function clearAlerts(){alerts=[];renderAlerts();renderOverview();}

// ── RENDER: PREDICTION GRID ───────────────
function renderPredGrid(){
  const el=document.getElementById('pred-grid'); if(!el) return;
  el.innerHTML=liveContainers.map(c=>{
    const h=H[c.id]||[],s=S[c.id]||{},lr=linReg(h.map(d=>d.cpu)),em=ema(h.map(d=>d.cpu),0.3);
    const tc=TRCFG[lr.trend]||TRCFG.stable,eta=lr.trend==='up'&&s.cpu>50?Math.round((85-s.cpu)/Math.max(lr.slope,0.1)*2):null;
    return `<div class="pred-card ${tc.card}"><div class="pc-container">${c.name}</div>
      <div class="pc-current" style="color:${cpuCol(s.cpu||0)}">${(s.cpu||0).toFixed(1)}<span style="font-size:11px;color:var(--t2)">%</span></div>
      <div style="display:flex;gap:5px;margin:3px 0;flex-wrap:wrap">
        <span style="font-size:9px;font-family:var(--mono);color:#00d4ff">OLS:${lr.pred}%</span><span style="font-size:9px;color:var(--t3)">|</span>
        <span style="font-size:9px;font-family:var(--mono);color:#b06cff">EMA:${em.pred}%</span>
        <span style="font-size:9px;font-family:var(--mono);color:${Math.abs(lr.pred-em.pred)<5?'#00ff88':'#ffaa00'}">${Math.abs(lr.pred-em.pred)<5?'✓':'⚡'}</span>
      </div>
      <span class="pc-trend ${tc.cls}">${tc.icon} ${tc.lbl}</span>
      ${eta?`<div style="font-size:9px;font-family:var(--mono);color:#ff3d3d;margin-top:2px">⚠ crit ~${eta}s</div>`:''}
    </div>`;
  }).join('');
}

function renderHistTable(){
  const tb=document.getElementById('hist-tbody'); if(!tb) return;
  const rows=[];
  liveContainers.forEach(c=>{
    const allCpu=(H[c.id]||[]).map(x=>x.cpu),lr=linReg(allCpu),em=ema(allCpu,0.3);
    (H[c.id]||[]).slice(-3).forEach(d=>rows.push({cname:c.name,...d,trend:lr.trend,lrPred:lr.pred,emaPred:em.pred}));
  });
  rows.sort((a,b)=>b.ts-a.ts);
  const cnt=document.getElementById('hist-count'); if(cnt)cnt.textContent=`${rows.length} entries`;
  tb.innerHTML=rows.slice(0,40).map(r=>{
    const tc=TRCFG[r.trend]||TRCFG.stable,t=new Date(r.ts).toLocaleTimeString('en',{hour12:false});
    return `<tr><td style="color:var(--t1);font-weight:600">${r.cname}</td><td>${t}</td><td style="color:${cpuCol(r.cpu)}">${r.cpu.toFixed(1)}</td><td style="color:${memCol(r.mem)}">${r.mem.toFixed(1)}</td><td style="color:#ff6b35">${r.net.toFixed(1)}</td><td style="color:#ffd700">${r.dk.toFixed(1)}</td><td style="color:#00d4ff;font-family:var(--mono)">${r.lrPred}</td><td style="color:#b06cff;font-family:var(--mono)">${r.emaPred}</td></tr>`;
  }).join('');
}

// ════════════════════════════════════════════
// NEW FEATURE 1 — HEALTH DASHBOARD
// ════════════════════════════════════════════
function renderHealthGrid(){
  const el=document.getElementById('health-grid'); if(!el) return;
  if(!liveContainers.length){
    el.innerHTML=`<div style="grid-column:1/-1;padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">No containers running.</div>`;
    return;
  }
  el.innerHTML=liveContainers.map(c=>{
    const s=S[c.id]||{};
    const h=H[c.id]||[];
    const st=c.st;
    const col=SCOL[st]||'#4a5568';
    const lr=linReg(h.map(d=>d.cpu));
    const trendArrow=lr.slope>1.5?'↑':lr.slope<-1.5?'↓':lr.slope>0.5?'↗':'→';
    const trendCol  =lr.slope>1.5?'#ff3d3d':lr.slope<-1.5?'#00ff88':'#ffaa00';
    const memPct=s.mem||0;
    const memBar=Math.min(Math.round(memPct),100);
    const memC=memPct>85?'#ff3d3d':memPct>70?'#ffaa00':'#00ff88';
    const score=st==='critical'?'CRITICAL':st==='warning'?'WARNING':'HEALTHY';
    const scoreC=st==='critical'?'#ff3d3d':st==='warning'?'#ffaa00':'#00ff88';
    return `<div class="health-tile" style="--tile-col:${col}">
      <div class="ht-glow" style="background:${col}22;border-color:${col}44"></div>
      <div class="ht-name">${c.name}</div>
      <div class="ht-status" style="color:${scoreC}">${score}</div>
      <div class="ht-cpu">
        <span class="ht-label">CPU</span>
        <span class="ht-val" style="color:${cpuCol(s.cpu||0)}">${(s.cpu||0).toFixed(1)}%</span>
        <span class="ht-arrow" style="color:${trendCol}">${trendArrow}</span>
      </div>
      <div class="ht-mem-bar-wrap">
        <div class="ht-mem-bar" style="width:${memBar}%;background:${memC}"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:9px;font-family:var(--mono);color:var(--t3);margin-top:2px">
        <span>MEM ${memPct.toFixed(0)}%</span>
        <span>PIDs ${s.pids||0}</span>
      </div>
      <div class="ht-net">NET ${(s.net||0).toFixed(1)} MB/s · DISK ${(s.dk||0).toFixed(1)} MB/s</div>
    </div>`;
  }).join('');
}

// ── LIFECYCLE EVENTS ─────────────────────
const EV_ICONS={start:'🟢',die:'🔴',stop:'🟡',kill:'🔴',restart:'🔄',create:'⬜',destroy:'⬛',pause:'⏸',unpause:'▶'};
function renderEvents(){
  const el=document.getElementById('event-stream'); if(!el) return;
  if(!evList.length){el.innerHTML=`<div style="color:var(--t3);font-family:var(--mono);font-size:10px;padding:20px;text-align:center">Listening for container events…</div>`;return;}
  el.innerHTML=evList.map(ev=>{
    const ico=EV_ICONS[ev.type]||'◈',col=ev.type==='start'?'#00ff88':ev.type==='die'||ev.type==='kill'?'#ff3d3d':ev.type==='restart'?'#00d4ff':'#ffaa00';
    const t=new Date(ev.ts).toLocaleTimeString('en',{hour12:false});
    return `<div class="event-row"><span class="ev-icon">${ico}</span><span class="ev-time">${t}</span><span class="ev-name">${escHtml(ev.name||'')}</span><span class="ev-type" style="color:${col}">${ev.type.toUpperCase()}</span><span class="ev-image" style="color:var(--t3)">${escHtml(ev.image||'')}</span></div>`;
  }).join('');
}
function clearEvents(){evList=[];renderEvents();}

// ════════════════════════════════════════════
// NEW FEATURE 2 — CPU HEATMAP
// ════════════════════════════════════════════
function renderHeatmap(){
  const el=document.getElementById('heatmap-wrap'); if(!el) return;
  if(!liveContainers.length){el.innerHTML=`<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">No containers running.</div>`;return;}
  // Build a table: rows = containers, cols = time slots (newest right)
  const cols=CONFIG.histMax;
  let html=`<div class="heatmap-table-wrap"><table class="heatmap-table">`;
  liveContainers.forEach(c=>{
    const h=H[c.id]||[];
    // Pad left with nulls if not enough history
    const padded=Array(Math.max(0,cols-h.length)).fill(null).concat(h.slice(-cols));
    html+=`<tr><td class="hm-label">${c.name}</td>`;
    padded.forEach(d=>{
      if(!d){html+=`<td class="hm-cell hm-empty"></td>`;return;}
      const v=d.cpu;
      const intensity=v/100;
      // Colour: low=dark blue, mid=yellow, high=red
      let r,g,b;
      if(v<40){r=Math.round(0+intensity*2*80);g=Math.round(100+intensity*2*80);b=Math.round(200-intensity*2*60);}
      else if(v<70){const t=(v-40)/30;r=Math.round(80+t*175);g=Math.round(180-t*80);b=Math.round(140-t*140);}
      else{const t=(v-70)/30;r=Math.round(255);g=Math.round(100-t*100);b=0;}
      const bg=`rgb(${r},${g},${b})`;
      const op=(0.3+intensity*0.7).toFixed(2);
      html+=`<td class="hm-cell" style="background:${bg};opacity:${op}" title="${c.name} · ${new Date(d.ts).toLocaleTimeString('en',{hour12:false})} · ${v.toFixed(1)}% CPU"></td>`;
    });
    html+=`</tr>`;
  });
  html+=`</table></div>`;
  // Time axis labels
  const hFirst=liveContainers.find(c=>H[c.id]?.length>0);
  if(hFirst){
    const h=H[hFirst.id];
    const labelCount=6;
    const step=Math.floor(h.length/labelCount);
    html+=`<div class="hm-time-axis">`;
    for(let i=0;i<labelCount;i++){
      const idx=Math.min(i*step,h.length-1);
      const t=h[idx]?new Date(h[idx].ts).toLocaleTimeString('en',{hour12:false}):'';
      html+=`<span style="position:absolute;left:${(i/labelCount*100).toFixed(1)}%;font-size:8px;font-family:var(--mono);color:var(--t3)">${t}</span>`;
    }
    html+=`</div>`;
  }
  el.innerHTML=html;
}

// ════════════════════════════════════════════
// NEW FEATURE 3 — NETWORK TOPOLOGY
// ════════════════════════════════════════════
async function loadNetworkTopology(){
  const el=document.getElementById('network-wrap'); if(!el) return;
  el.innerHTML=`<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">Loading topology…</div>`;
  if(!liveContainers.length){el.innerHTML=`<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">No containers running.</div>`;return;}
  // Inspect all running containers in parallel
  const inspects=await Promise.all(liveContainers.map(c=>
    fetch(`/api/inspect?name=${encodeURIComponent(c.name)}`).then(r=>r.json()).catch(()=>null)
  ));
  // Build network map: networkName → [containers]
  const netMap={};
  inspects.forEach((d,i)=>{
    if(!d||d.error) return;
    const cname=liveContainers[i].name;
    (d.nets||[]).forEach(n=>{
      if(!netMap[n.network]) netMap[n.network]={containers:[]};
      netMap[n.network].containers.push({name:cname,ip:n.ip,mac:n.mac,ports:d.ports||[]});
    });
  });
  const networks=Object.entries(netMap);
  if(!networks.length){el.innerHTML=`<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">No network data found. Try refreshing.</div>`;return;}
  let html=`<div class="topology-wrap">`;
  networks.forEach(([netName,net])=>{
    const isDefault=netName==='bridge';
    const netCol=isDefault?'#4a5568':'#00d4ff';
    html+=`<div class="topology-network">
      <div class="topo-net-header">
        <div class="topo-net-dot" style="background:${netCol}"></div>
        <span class="topo-net-name">${netName}</span>
        <span class="topo-net-count">${net.containers.length} container${net.containers.length!==1?'s':''}</span>
      </div>
      <div class="topo-containers">`;
    net.containers.forEach(c=>{
      const s=S[liveContainers.find(x=>x.name===c.name)?.id]||{};
      const col=SCOL[liveContainers.find(x=>x.name===c.name)?.st]||'#4a5568';
      html+=`<div class="topo-container-card" style="border-color:${col}44">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0"></div>
          <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--t1)">${c.name}</span>
        </div>
        <div class="topo-detail"><span class="topo-lbl">IP</span><span class="topo-val">${c.ip||'—'}</span></div>
        <div class="topo-detail"><span class="topo-lbl">MAC</span><span class="topo-val" style="font-size:9px">${c.mac||'—'}</span></div>
        ${c.ports.length?`<div class="topo-detail"><span class="topo-lbl">PORTS</span><span class="topo-val">${c.ports.join(' · ')||'—'}</span></div>`:''}
        <div class="topo-detail"><span class="topo-lbl">CPU</span><span class="topo-val" style="color:${cpuCol(s.cpu||0)}">${(s.cpu||0).toFixed(1)}%</span></div>
      </div>`;
    });
    html+=`</div></div>`;
  });
  html+=`</div>`;
  el.innerHTML=html;
}

// ════════════════════════════════════════════
// NEW FEATURE 4 — CONTAINER INSPECTOR
// ════════════════════════════════════════════
async function loadInspector(){
  const sel=document.getElementById('inspector-sel');
  const el =document.getElementById('inspector-wrap');
  if(!sel||!el) return;
  const cid  =sel.value;
  const cname=liveContainers.find(c=>c.id===cid)?.name;
  if(!cname){el.innerHTML=`<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">Select a container</div>`;return;}
  el.innerHTML=`<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--t3)">Inspecting ${cname}…</div>`;
  try{
    const r=await fetch(`/api/inspect?name=${encodeURIComponent(cname)}`);
    const d=await r.json();
    if(d.error){el.innerHTML=`<div style="padding:40px;font-family:var(--mono);font-size:10px;color:var(--danger)">Error: ${escHtml(d.error)}</div>`;return;}
    const s=S[cid]||{};
    const stCol=d.status==='running'?'#00ff88':d.status==='exited'?'#ff3d3d':'#ffaa00';
    function section(title,content){return `<div class="insp-section"><div class="insp-sec-title">${title}</div>${content}</div>`;}
    function row(label,val,valCol=''){return `<div class="insp-row"><span class="insp-label">${label}</span><span class="insp-val"${valCol?` style="color:${valCol}"`:''}>${escHtml(String(val))}</span></div>`;}
    const html=`<div class="inspector-grid">
      <div class="insp-col">
        ${section('Identity',
          row('Name',      d.name||cname)+
          row('Image',     d.image)+
          row('Hostname',  d.hostname)+
          row('Status',    d.status,    stCol)+
          row('Started',   d.startedAt)+
          row('Created',   d.created)
        )}
        ${section('Resource Limits',
          row('CPU Limit',    d.cpuLimit)+
          row('Memory Limit', d.memLimit)+
          row('Restart Policy',d.restartPolicy)+
          row('Restart Count',d.restarts||0)
        )}
        ${section('Live Metrics',
          row('CPU',     `${(s.cpu||0).toFixed(1)}%`)+
          row('Memory',  `${(s.memA||0)}MB / ${(s.memLimit||0).toFixed(0)}MB`)+
          row('Network', `${(s.net||0).toFixed(1)} MB/s`)+
          row('Disk I/O',`${(s.dk||0).toFixed(1)} MB/s`)+
          row('PIDs',    s.pids||0)
        )}
      </div>
      <div class="insp-col">
        ${section('Ports', d.ports?.length
          ? d.ports.map(p=>`<div class="insp-tag">${escHtml(p)}</div>`).join('')
          : '<div class="insp-none">No ports exposed</div>'
        )}
        ${section('Networks', d.nets?.length
          ? d.nets.map(n=>`<div class="insp-net-row"><div class="insp-row">${row('Network',n.network)}</div><div class="insp-row">${row('IP',n.ip)}</div><div class="insp-row">${row('Gateway',n.gateway)}</div></div>`).join('<hr class="insp-hr"/>')
          : '<div class="insp-none">No network info</div>'
        )}
        ${section('Volumes', d.mounts?.length
          ? d.mounts.map(m=>`<div class="insp-mount"><span class="insp-mount-type">${m.type}</span> ${escHtml(m.src)} → ${escHtml(m.dst)} <span style="color:var(--t3)">[${m.mode}]</span></div>`).join('')
          : '<div class="insp-none">No volumes</div>'
        )}
        ${section('Environment (filtered)', d.env?.length
          ? d.env.map(e=>`<div class="insp-env-row">${escHtml(e)}</div>`).join('')
          : '<div class="insp-none">No env vars (or all filtered)</div>'
        )}
      </div>
    </div>`;
    el.innerHTML=html;
  }catch(e){el.innerHTML=`<div style="padding:40px;font-family:var(--mono);font-size:10px;color:var(--danger)">Failed: ${e.message}</div>`;}
}

// ── CSV EXPORT ────────────────────────────
function exportCSV(){
  const rows=['Container,Timestamp,CPU %,Memory %,Network MB/s,Disk MB/s'];
  liveContainers.forEach(c=>{(H[c.id]||[]).forEach(d=>rows.push(`${c.name},${new Date(d.ts).toISOString()},${d.cpu},${d.mem},${d.net},${d.dk}`));});
  const blob=new Blob([rows.join('\n')],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`crmtr-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
}

// ════════════════════════════════════════════
// CI/CD PIPELINE INTEGRATION
// Reads build results posted by Jenkins / GitHub Actions
// via POST /api/cicd and displays live pipeline status
// ════════════════════════════════════════════

const STATUS_CFG = {
  SUCCESS:  { col:'#00ff88', icon:'✓', cls:'cicd-ok'   },
  FAILURE:  { col:'#ff3d3d', icon:'✗', cls:'cicd-fail' },
  UNSTABLE: { col:'#ffaa00', icon:'⚠', cls:'cicd-warn' },
  ABORTED:  { col:'#4a5568', icon:'○', cls:'cicd-skip' },
  RUNNING:  { col:'#00d4ff', icon:'↻', cls:'cicd-run'  },
  UNKNOWN:  { col:'#8a95a3', icon:'?', cls:'cicd-skip' },
};

async function loadCICD() {
  try {
    const r = await fetch('/api/cicd');
    const d = await r.json();

    // Update badge — red dot if any pipeline failed
    const failed = (d.pipelines||[]).filter(p=>p.status==='FAILURE').length;
    const badge  = document.getElementById('cicd-badge');
    if (badge) { badge.textContent=failed||''; badge.style.display=failed>0?'inline':'none'; }

    // Last updated
    const lu = document.getElementById('cicd-last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date(d.ts).toLocaleTimeString('en',{hour12:false});

    renderCICDGrid(d.pipelines||[]);
    renderCICDTimeline(d.history||[]);
  } catch(e) {
    const g = document.getElementById('cicd-grid');
    if(g) g.innerHTML = `<div class="cicd-empty">Cannot reach /api/cicd — is server.js running?</div>`;
  }
}

function renderCICDGrid(pipelines) {
  const el = document.getElementById('cicd-grid'); if(!el) return;
  if(!pipelines.length) {
    el.innerHTML = `<div class="cicd-empty">
      <div style="font-size:24px;margin-bottom:8px">⚙</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--t1);margin-bottom:6px">No pipelines connected yet</div>
      <div style="font-family:var(--mono);font-size:9px;color:var(--t3)">Add the POST step to your Jenkinsfile or GitHub Actions workflow</div>
      <div style="margin-top:12px;display:flex;gap:10px;justify-content:center">
        <div class="cicd-demo-btn" onclick="injectDemoBuilds()">▶ Load demo data</div>
      </div>
    </div>`;
    return;
  }

  el.innerHTML = pipelines.map(p => {
    const cfg = STATUS_CFG[p.status] || STATUS_CFG.UNKNOWN;
    const ago = timeSince(p.ts);
    const dur = p.duration ? formatDur(p.duration) : '—';
    const toolCol = p.tool==='Jenkins'?'#d33a2c':p.tool==='GitHub Actions'?'#2ea44f':'#00d4ff';
    return `<div class="cicd-card" style="border-color:${cfg.col}44">
      <div class="cicd-card-top">
        <span class="cicd-tool-badge" style="background:${toolCol}22;color:${toolCol};border-color:${toolCol}44">${p.tool||'CI'}</span>
        <span class="cicd-status-icon ${cfg.cls}" style="color:${cfg.col}">${cfg.icon} ${p.status}</span>
      </div>
      <div class="cicd-pipeline-name">${escHtml(p.pipeline)}</div>
      <div class="cicd-meta">
        <span class="cicd-branch">⎇ ${escHtml(p.branch)}</span>
        ${p.commit?`<span class="cicd-commit">${escHtml(p.commit)}</span>`:''}
      </div>
      <div class="cicd-footer">
        <span class="cicd-ago">${ago}</span>
        <span class="cicd-dur">${dur}</span>
        ${p.url?`<a class="cicd-link" href="${escHtml(p.url)}" target="_blank">↗ open</a>`:''}
      </div>
      <div class="cicd-bar" style="background:${cfg.col}"></div>
    </div>`;
  }).join('');
}

function renderCICDTimeline(history) {
  const el = document.getElementById('cicd-timeline'); if(!el) return;
  const cnt = document.getElementById('cicd-build-count');
  if(cnt) cnt.textContent = `${history.length} builds`;
  if(!history.length){el.innerHTML=`<div style="color:var(--t3);font-family:var(--mono);font-size:10px;padding:20px;text-align:center">No build history yet</div>`;return;}
  el.innerHTML = history.slice(0,30).map(b => {
    const cfg = STATUS_CFG[b.status] || STATUS_CFG.UNKNOWN;
    const t   = new Date(b.ts).toLocaleTimeString('en',{hour12:false});
    return `<div class="cicd-hist-row">
      <span class="cicd-hist-icon" style="color:${cfg.col}">${cfg.icon}</span>
      <span class="cicd-hist-time">${t}</span>
      <span class="cicd-hist-name">${escHtml(b.pipeline)}</span>
      <span class="cicd-hist-branch" style="color:var(--t3)">⎇ ${escHtml(b.branch)}</span>
      <span class="cicd-hist-tool" style="color:var(--t3)">${escHtml(b.tool)}</span>
      <span class="cicd-hist-status" style="color:${cfg.col}">${b.status}</span>
    </div>`;
  }).join('');
}

// Inject demo builds so teacher can see it working without real Jenkins
async function injectDemoBuilds() {
  const demos = [
    {tool:'Jenkins',        pipeline:'CRMTR-Build',    status:'SUCCESS', branch:'main',    commit:'a3f9c12b'},
    {tool:'GitHub Actions', pipeline:'Run Tests',      status:'SUCCESS', branch:'main',    commit:'b4e2d31f'},
    {tool:'Jenkins',        pipeline:'Deploy-Staging', status:'FAILURE', branch:'feature', commit:'c5f3e42a'},
    {tool:'GitHub Actions', pipeline:'Lint & Format',  status:'SUCCESS', branch:'main',    commit:'d6g4f53b'},
    {tool:'Jenkins',        pipeline:'CRMTR-Build',    status:'RUNNING', branch:'develop', commit:'e7h5g64c'},
  ];
  for(const d of demos){
    await fetch('/api/cicd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
  }
  loadCICD();
}

function timeSince(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h ago';
}
function formatDur(ms){
  if(ms<1000) return ms+'ms';
  if(ms<60000) return (ms/1000).toFixed(1)+'s';
  return Math.floor(ms/60000)+'m '+(Math.floor(ms/1000)%60)+'s';
}

// ── NAVIGATION ────────────────────────────
function showTab(id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+id)?.classList.add('active');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+id)?.classList.add('active');
  if(id==='containers') renderContainers();
  if(id==='alerts')     {renderAlerts();renderAlertRules();}
  if(id==='predict')    {renderPredGrid();renderHistTable();const cid=document.getElementById('pred-container-sel')?.value||liveContainers[0]?.id;if(cid&&cid!==predCid) buildPredChart(cid);}
  if(id==='health')     {renderHealthGrid();renderEvents();}
  if(id==='heatmap')    renderHeatmap();
  if(id==='network')    loadNetworkTopology();
  if(id==='inspector')  loadInspector();
  if(id==='cicd')       loadCICD();
}

function selCont(id){ selId=id; renderSidebar(); }
function togglePause(){
  paused=!paused;
  document.getElementById('pause-btn').textContent=paused?'[ RESUME ]':'[ PAUSE ]';
  if(!paused) setStatus(true,`${liveContainers.length} containers running`);
}

function updateClock(){
  document.getElementById('clock').textContent=new Date().toLocaleTimeString('en',{hour12:false});
  const e=Math.floor((Date.now()-t0)/1000);
  document.getElementById('uptime').textContent=`${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor((e%3600)/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
}

function populateSels(){
  ['chart-container-sel','pred-container-sel','inspector-sel'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const prev=el.value;
    el.innerHTML=liveContainers.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(prev&&liveContainers.find(c=>c.id===prev)) el.value=prev;
  });
}

// ── MAIN TICK ─────────────────────────────
async function doTick(){
  if(paused) return; tick++;
  await fetchDockerMetrics();
  await fetchEvents();
  populateSels(); renderSidebar(); renderMiniStats(); tickCharts();
  const ap=document.querySelector('.panel.active'); if(!ap) return;
  if(ap.id==='panel-overview')   renderOverview();
  if(ap.id==='panel-containers') renderContainers();
  if(ap.id==='panel-alerts')     renderAlerts();
  if(ap.id==='panel-predict')    {renderPredGrid();renderHistTable();const cid=document.getElementById('pred-container-sel')?.value||liveContainers[0]?.id;if(cid&&cid!==predCid) buildPredChart(cid);}
  if(ap.id==='panel-health')     {renderHealthGrid();renderEvents();}
  if(ap.id==='panel-heatmap')    renderHeatmap();
  const td=document.getElementById('tick-disp'); if(td) td.textContent=`tick ${tick}`;
}

// ── INIT ──────────────────────────────────
(async function init(){
  setStatus(false,'Checking Docker…');
  updateClock(); setInterval(updateClock,1000);
  try{
    const r=await fetch('/api/docker-check'),d=await r.json();
    if(!d.available){
      setStatus(false,'Docker not running');
      const ban=document.getElementById('docker-err-banner');
      if(ban){ban.style.display='flex';ban.textContent='⚠ Docker Desktop is not running. Start it then refresh.';}
      return;
    }
  }catch(e){setStatus(false,'Server unreachable');return;}
  await fetchDockerMetrics();
  await fetchEvents();
  populateSels(); renderSidebar(); renderMiniStats(); renderOverview(); renderAlertRules();
  initCharts();
  setInterval(doTick, CONFIG.tickMs);
})();
