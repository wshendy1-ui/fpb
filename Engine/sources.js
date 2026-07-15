/* =========================================================================
   FPB ENGINE — sources.js (v1)
   Data-source builders and parsers extracted from v83. No DOM, no globals:
   fetch is injected, configuration is an explicit object. Depends on core.
   ========================================================================= */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./core.js"));
  else root.FPBSources = factory(root.FPBCore);
})(typeof self !== "undefined" ? self : this, function (C) {
"use strict";

/* ==================== ENDPOINTS (v83:622-644) ==================== */
const FEMS_URL_DEF="https://fems.fs2c.usda.gov/api/climatology/download-nfdr?stationIds={ids}&startDate={d0}T00:00:00&endDate={d6}T23:59:59&dataFormat=csv&dataset={ds}&fuelModels={fm}";
const OM_BASE_DEF="https://api.open-meteo.com/v1/forecast";
const OM_CUSTOMER_DEF="https://customer-api.open-meteo.com/v1/forecast";
const OM_ARCHIVE_DEF="https://archive-api.open-meteo.com/v1/archive";
/* v83:952-955 request variable lists */
const OM_HOURLY=["temperature_2m","relative_humidity_2m","wind_speed_10m","wind_gusts_10m","cape","precipitation","vapour_pressure_deficit","temperature_950hPa","temperature_850hPa","temperature_700hPa","temperature_500hPa","dew_point_700hPa","dew_point_850hPa","temperature_1000hPa","temperature_975hPa","temperature_925hPa","temperature_900hPa","temperature_800hPa","relative_humidity_1000hPa","relative_humidity_975hPa","relative_humidity_950hPa","relative_humidity_925hPa","relative_humidity_900hPa","relative_humidity_850hPa","relative_humidity_800hPa","relative_humidity_700hPa","surface_pressure","wind_speed_1000hPa","wind_speed_975hPa","wind_speed_950hPa","wind_speed_925hPa","wind_speed_900hPa","wind_speed_850hPa","wind_speed_800hPa","wind_speed_700hPa"];
const OM_DAILY=["temperature_2m_max","temperature_2m_min","precipitation_sum","precipitation_probability_max","wind_speed_10m_max","wind_gusts_10m_max","wind_direction_10m_dominant","sunrise","sunset"];
const OM_EXOTIC=OM_HOURLY.filter(v=>/hPa$|^cape$|^vapour_pressure_deficit$|^surface_pressure$/.test(v));
/* v83:659 */
const OM_MODELS=["gfs_seamless","ecmwf_ifs025","icon_seamless","gem_seamless","jma_seamless","ukmo_seamless","meteofrance_seamless"];

/* ==================== OPEN-METEO (v83:956-997, re-plumbed) ==================== */
/* cfg = {base?, key?, hourly?, daily?}. v83 state.omBase/omKey → cfg. */
function omBaseEff(cfg){
  const b=((cfg&&cfg.base)||OM_BASE_DEF).replace(/[?&]+$/,"");
  if(((cfg&&cfg.key)||"").trim()&&b===OM_BASE_DEF)return OM_CUSTOMER_DEF;
  return b;
}
/* v83:963 */
function omUrl(cfg,pts,model,drop){
  drop=drop||[];
  const HL=(cfg&&cfg.hourly)||OM_HOURLY, DL=(cfg&&cfg.daily)||OM_DAILY;
  const hv=HL.filter(v=>drop.indexOf(v)<0),dv=DL.filter(v=>drop.indexOf(v)<0);
  let u=omBaseEff(cfg)+"?latitude="+pts.map(x=>x.lat).join(",")+"&longitude="+pts.map(x=>x.lon).join(",")
    +"&hourly="+hv.join(",")
    +"&daily="+dv.join(",")
    +"&forecast_days=7&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch"
    +"&models="+encodeURIComponent(model);
  if(pts.every(x=>x.elevFt!=null&&x.elevFt!==""))
    u+="&elevation="+pts.map(x=>Math.round(C.num(x.elevFt)*0.3048)).join(",");
  if(((cfg&&cfg.key)||"").trim())u+="&apikey="+encodeURIComponent(cfg.key.trim());
  return u;
}
/* v83:979 self-healing request: 4xx naming a variable drops exactly that variable;
   an unnamed 4xx sheds the exotic block once; 429 throws for the caller's pacing. */
async function omFetch(fetchFn,cfg,pts,m,drop){
  const HL=(cfg&&cfg.hourly)||OM_HOURLY, DL=(cfg&&cfg.daily)||OM_DAILY;
  for(let k=0;k<6;k++){
    const u=omUrl(cfg,pts,m,drop);
    const r=await fetchFn(u);
    if(r.ok)return await r.json();
    let reason="";
    try{const b=await r.json();reason=String((b&&(b.reason||b.error_message||b.message))||"");}catch(e){}
    if(r.status===429)throw new Error("429 rate-limited"+(reason?(" \u2014 "+reason):""));
    if(r.status>=400&&r.status<500){
      const toks=reason.match(/[A-Za-z][A-Za-z0-9_]+/g)||[];
      const bad=HL.concat(DL).filter(v=>toks.indexOf(v)>=0&&drop.indexOf(v)<0);
      if(bad.length){bad.forEach(v=>{drop.push(v);});continue;}
      if(!drop._blk){drop._blk=1;let added=0;OM_EXOTIC.forEach(v=>{if(drop.indexOf(v)<0){drop.push(v);added++;}});if(added)continue;}
    }
    throw new Error(r.status+(reason?(" "+reason):(" "+u.slice(0,90))));
  }
  throw new Error("request still rejected after dropping variables");
}
/* v83:1096 parseOmOne — VERBATIM. One model response → per-day derived fields. */
function parseOmOne(om){
  const hrRaw=om.hourly||{};
  const hrC={};
  for(const k of C.HAINES_PL){const a=hrRaw[k];hrC[k]=a?a.map(x=>x==null?null:(x-32)*5/9):null;}
  const psfcEst=(om.elevation!=null)?1013.25*Math.pow(1-2.25577e-5*om.elevation,5.25588):null;
  const spArr=hrRaw.surface_pressure||null;
  const dl=om.daily,hr=om.hourly;
  if(!dl||!dl.time)throw new Error("malformed response");
  const days=dl.time.slice(0,7);const d={};
  const A_t=hr&&hr.temperature_2m||[],A_rh=hr&&hr.relative_humidity_2m||[],
        A_w=hr&&hr.wind_speed_10m||[],A_v=hr&&hr.vapour_pressure_deficit||[];
  const idxByDay={};
  (hr&&hr.time||[]).forEach((t,i)=>{const k=t.slice(0,10);(idxByDay[k]=idxByDay[k]||[]).push(i);});
  days.forEach((k,di)=>{
    const o={};
    o.tmax=dl.temperature_2m_max?dl.temperature_2m_max[di]:null;o.tmin=dl.temperature_2m_min?dl.temperature_2m_min[di]:null;
    o.precip=dl.precipitation_sum?dl.precipitation_sum[di]:null;o.pop=dl.precipitation_probability_max?dl.precipitation_probability_max[di]:null;
    o.wind=dl.wind_speed_10m_max?dl.wind_speed_10m_max[di]:null;o.gust=dl.wind_gusts_10m_max?dl.wind_gusts_10m_max[di]:null;
    o.wdir=dl.wind_direction_10m_dominant?dl.wind_direction_10m_dominant[di]:null;
    if(dl.sunrise&&dl.sunset){const dlh=(Date.parse(dl.sunset[di])-Date.parse(dl.sunrise[di]))/3600e3;o.daylen=isNaN(dlh)?null:dlh;}
    const ids=idxByDay[k]||[];
    let rhmin=null,vpdmax=null,vpdsum=0,vpdn=0,hdw=null,hdwS=null,ff=null,cape=null;
    for(const i of ids){
      const rh=A_rh[i],t=A_t[i],w=A_w[i],
            v=A_v[i],c=hr.cape?hr.cape[i]:null;
      if(rh!=null){rhmin=rhmin==null?rh:Math.min(rhmin,rh);}
      if(v!=null){vpdmax=vpdmax==null?v:Math.max(vpdmax,v);vpdsum+=v;vpdn++;}
      if(v!=null&&w!=null){const xs=C.hdwHour(v,w);hdwS=hdwS==null?xs:Math.max(hdwS,xs);}
      let vLay=v,wLay=w;
      const psfcH=(spArr&&spArr[i]!=null)?spArr[i]:psfcEst;
      const hdwLvls=psfcH!=null?C.HDW_LVLS.filter(P=>P<=psfcH+2&&P>=psfcH-50):[];
      for(const P of hdwLvls){
        const tA=hr["temperature_"+P+"hPa"],rA=hr["relative_humidity_"+P+"hPa"],wA=hr["wind_speed_"+P+"hPa"];
        const tF=tA?tA[i]:null,rP=rA?rA[i]:null,wP=wA?wA[i]:null;
        if(tF!=null&&rP!=null){
          const tc=(tF-32)*5/9;
          const es=0.6108*Math.exp(17.27*tc/(tc+237.3));
          const vv=es*(1-Math.min(100,Math.max(0,rP))/100);
          if(vLay==null||vv>vLay)vLay=vv;
        }
        if(wP!=null&&(wLay==null||wP>wLay))wLay=wP;
      }
      if(vLay!=null&&wLay!=null){const x=C.hdwHour(vLay,wLay);hdw=hdw==null?x:Math.max(hdw,x);}
      if(t!=null&&rh!=null&&w!=null){const f=C.ffwiHour(t,rh,w);ff=ff==null?f:Math.max(f,ff);}
      if(c!=null){cape=cape==null?c:Math.max(cape,c);}
    }
    o.rhmin=rhmin;o.vpdmax=vpdmax;o.vpdmean=vpdn?vpdsum/vpdn:null;o.hdw=hdw;o.hdwSfc=hdwS;o.ffwi=ff;o.cape=cape;
    let rec=null;
    const prev=di>0?(idxByDay[days[di-1]]||[]):[];
    for(const i of prev){const hh=+hr.time[i].slice(11,13);if(hh>=20&&A_rh[i]!=null)rec=rec==null?A_rh[i]:Math.max(rec,A_rh[i]);}
    for(const i of ids){const hh=+hr.time[i].slice(11,13);if(hh<=8&&A_rh[i]!=null)rec=rec==null?A_rh[i]:Math.max(rec,A_rh[i]);}
    o.rhrec=rec;
    let hi=hr.time?hr.time.indexOf(k+"T16:00"):-1;
    if(hi<0&&hr.time)hi=hr.time.indexOf(k+"T15:00");
    if(hi<0&&hr.time)hi=hr.time.indexOf(k+"T17:00");
    o.hainesH=hi>=0?C.hainesAt(hrC,hi,C.HAINES_VAR.High):null;
    o.hainesM=hi>=0?C.hainesAt(hrC,hi,C.HAINES_VAR.Mid):null;
    if(o.tmin!=null&&o.vpdmean!=null&&o.daylen!=null)o.gsi=C.gsiDaily((o.tmin-32)*5/9,o.vpdmean,o.daylen);
    d[k]=o;
  });
  return {days:days,d:d,tzOff:om.utc_offset_seconds};
}

/* ==================== FEMS (v83:1322,1837-1999,2056, re-plumbed) ==================== */
/* v83:1322 femsUrlFor → explicit config: {url?,ids[],d0,d6,fuelModels[],dataset} */
function femsUrl(cfg){
  return (cfg.url||FEMS_URL_DEF).replace("{ids}",cfg.ids.join(","))
    .replace("{d0}",cfg.d0).replace("{d6}",cfg.d6)
    .replace("{fm}",encodeURIComponent(cfg.fuelModels.join(",")))
    .replace("{ds}",cfg.dataset);
}
/* v83:1837 header recognition table */
const CSV_FIELDS=[
 {f:"date",lab:"Date / datetime",re:/date|datetime|obstime|observationtime|validtime|timestamp|nfdrdt/},
 {f:"time",lab:"Time (if separate column)",re:/^time$|localtime|nfdrtime|obshour/},
 {f:"stn",lab:"Station ID",re:/stationid|^stid$|^sti$|^nwsid$|stationnumber|^station$/},
 {f:"fuelmodel",lab:"Fuel model (splits ERC/BI/IC/SC per model)",re:/fuelmodel|^fm$/},
 {f:"erc",lab:"ERC",re:/^erc$|energyreleasecomponent|energyrelease|erc/},
 {f:"bi",lab:"BI",re:/^bi$|burningindex|^burning/},
 {f:"ic",lab:"IC",re:/^ic$|ignitioncomponent|ignition/},
 {f:"sc",lab:"SC",re:/^sc$|spreadcomponent|^spread/},
 {f:"fm1000",lab:"1000-hr FM",re:/thousand|(^|[^0-9])1000/},
 {f:"fm100",lab:"100-hr FM",re:/hundred|(^|[^0-9])100(hr|hour)/},
 {f:"fm10",lab:"10-hr FM",re:/ten(hr|hour)|(^|[^0-9])10(hr|hour)/},
 {f:"fm1",lab:"1-hr FM",re:/one(hr|hour)|(^|[^0-9])1(hr|hour)/},
 {f:"lfm",lab:"Herbaceous live FM",re:/herb/},
 {f:"lfw",lab:"Woody live FM",re:/woody/},
 {f:"woody",lab:"Woody live FM",re:/wood/},
 {f:"kbdi",lab:"KBDI",re:/kbdi/}
];
const CSV_META={date:1,time:1,stn:1,fuelmodel:1};
/* v83:1856-1862 */
function normHdr(h){return String(h==null?"":h).toLowerCase().replace(/[^a-z0-9]/g,"");}
function splitDelim(l,d){const out=[];let cur="",q=false;
  for(const ch of l){if(ch==='"'){q=!q;}else if(ch===d&&!q){out.push(cur);cur="";}else cur+=ch;}
  out.push(cur);return out.map(s=>s.trim());}
function sniffDelim(line){let best=",",bn=1;
  for(const d of [",","\t",";","|"]){const n=splitDelim(line,d).length;if(n>bn){bn=n;best=d;}}
  return best;}
/* v83:1832 */
function splitCsvLine(l){const out=[];let cur="",q=false;
  for(const ch of l){if(ch==='"'){q=!q;}else if(ch===","&&!q){out.push(cur);cur="";}else cur+=ch;}
  out.push(cur);return out.map(s=>s.trim());}
/* v83:1863 delimiter sniffing + preamble skip */
function parseFemsCsv(text){
  text=String(text||"").replace(/^\uFEFF/,"");
  if(text.indexOf("\u0000")>=0||/^PK/.test(text))throw new Error("XLSX");
  const lines=text.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2)throw new Error("fewer than two non-empty lines");
  let hi=0,hs=-1,hd=",";
  const lim=Math.min(lines.length-1,40);
  for(let i=0;i<lim;i++){
    const d=sniffDelim(lines[i]);const cells=splitDelim(lines[i],d);
    if(cells.length<3)continue;
    let sc=0;const used={};
    for(const c of cells){const nh=normHdr(c);if(!nh)continue;
      for(const def of CSV_FIELDS){if(!used[def.f]&&def.re.test(nh)){sc++;used[def.f]=1;break;}}}
    if(sc>hs){hs=sc;hi=i;hd=d;}
    if(sc>=4)break;
  }
  const headers=splitDelim(lines[hi],hd);
  const rows=[];
  for(let i=hi+1;i<lines.length;i++){const c=splitDelim(lines[i],hd);if(c.length>1)rows.push(c);}
  if(!rows.length)throw new Error("no data rows under the header line");
  return {headers:headers,rows:rows,delim:hd,headerIdx:hi,score:hs};
}
/* v83:1885 */
function colDateOk(parsed,c){let ok=0,n=0;
  for(let i=0;i<Math.min(parsed.rows.length,20);i++){const v=parsed.rows[i][c];
    if(v==null||v==="")continue;n++;if(C.normDateKey(v))ok++;}
  return n>0&&ok/n>=0.5;}
/* v83:1889 replumbed: area().stations → knownIds (array of id strings) */
function autoMapCsv(parsed,knownIds){
  const map={},used={};
  const norm=parsed.headers.map(normHdr);
  for(const def of CSV_FIELDS){
    let best=-1;
    for(let c=0;c<norm.length;c++){
      if(used[c]||!norm[c])continue;
      if(def.re.test(norm[c])&&(best<0||norm[c].length<norm[best].length))best=c;
    }
    if(best>=0){map[def.f]=best;used[best]=1;}
  }
  if(map.date==null||!colDateOk(parsed,map.date)){
    if(map.date!=null){delete used[map.date];delete map.date;}
    for(let c=0;c<norm.length;c++){if(!used[c]&&colDateOk(parsed,c)){map.date=c;used[c]=1;break;}}
  }
  if(map.stn==null){
    const known={};(knownIds||[]).forEach(id=>{known[String(id)]=1;});
    let best=-1,bestScore=0;
    for(let c=0;c<norm.length;c++){
      if(used[c])continue;
      let hit=0,dig=0,n=0;const seen={};
      for(let i=0;i<Math.min(parsed.rows.length,30);i++){
        const v=String(parsed.rows[i][c]==null?"":parsed.rows[i][c]).trim();
        if(!v)continue;n++;
        if(known[v])hit++;
        if(/^\d{5,8}$/.test(v)){dig++;seen[v]=1;}
      }
      if(!n)continue;
      const sc=(hit/n>=0.5)?2:((dig/n>=0.8&&Object.keys(seen).length<50)?1:0);
      if(sc>bestScore){bestScore=sc;best=c;}
    }
    if(best>=0){map.stn=best;used[best]=1;}
  }
  for(const f of Object.keys(map)){
    if(CSV_META[f])continue;
    const c=map[f];let ok=0,n=0;
    for(let i=0;i<Math.min(parsed.rows.length,20);i++){const v=parsed.rows[i][c];
      if(v==null||v==="")continue;n++;if(C.num(v)!=null)ok++;}
    if(n===0||ok/n<0.4)delete map[f];
  }
  return map;
}
/* v83:1932 */
function hourFrom(dateStr,timeStr){
  let m=/[T ](\d{1,2}):?(\d{2})/.exec(String(dateStr||""));
  if(m)return +m[1];
  m=/^(\d{1,2}):(\d{2})/.exec(String(timeStr||"").trim());
  if(m)return +m[1];
  m=/^(\d{1,2})(\d{2})$/.exec(String(timeStr||"").trim());
  if(m)return +m[1];
  return null;
}
/* v83:1941 */
function mapHasValues(map){return CSV_FIELDS.some(d=>!CSV_META[d.f]&&map[d.f]!=null);}
/* v83:1942 — VERBATIM: per-model index splitting (erc_V …), Y doubles as base */
function collectCsvEntries(parsed,map,srcId,forceSid){
  if(map.date==null||!mapHasValues(map))return null;
  const entries=[];
  for(const c of parsed.rows){
    let M="Y";
    if(map.fuelmodel!=null&&c[map.fuelmodel]){
      const raw=String(c[map.fuelmodel]).trim().toUpperCase();
      const mm=raw.match(/(?:^|16)([VWXYZ])$/)||raw.match(/^([VWXYZ])/);
      if(mm)M=mm[1];
    }
    const day=C.normDateKey(c[map.date]);if(!day)continue;
    const sid=forceSid!=null?String(forceSid):((map.stn!=null&&c[map.stn])?String(c[map.stn]).trim():(srcId||"CSV"));
    const vals={};
    for(const def of CSV_FIELDS){
      if(CSV_META[def.f])continue;
      const col=map[def.f];if(col==null)continue;
      const v=C.num(c[col]);if(v==null)continue;
      if(C.FM_VARY[def.f]){vals[def.f+"_"+M]=v;if(M==="Y")vals[def.f]=v;}
      else vals[def.f]=v;
    }
    if(!Object.keys(vals).length)continue;
    entries.push({sid:sid,day:day,hour:hourFrom(c[map.date],map.time!=null?c[map.time]:null),vals:vals});
  }
  return entries;
}
/* v83:2056 importFemsJson replumbed: returns ENTRIES (storage is the caller's).
   Note: keeps v83's Y-only filter on the JSON path. opts={knownIds?,forceSid?} */
function parseFemsJson(j,opts){
  opts=opts||{};
  const rows=Array.isArray(j)?j:(j.data||j.rows||j.results||[]);
  if(!Array.isArray(rows)||!rows.length)return [];
  const known={};(opts.knownIds||[]).forEach(id=>{known[String(id)]=1;});
  const entries=[];
  for(const r of rows){
    const dRaw=r.nfdrDate||r.date||r.observationTime||r.validTime||r.dateTime||r.nfdr_dt;
    const day=C.normDateKey(dRaw);if(!day)continue;
    let fmv=null;for(const key of Object.keys(r)){if(/fuel.?model/i.test(key)){fmv=r[key];break;}}
    if(fmv&&!/y/i.test(String(fmv)))continue;
    let sid=null;
    for(const key of Object.keys(r)){if(/station.?id|^stid$|ness.?id|wims|raws.?id|station.?num/i.test(key)&&r[key]!=null){sid=String(r[key]).trim();break;}}
    if(sid==null&&r.station&&typeof r.station==="object"){
      for(const key of Object.keys(r.station)){if(/id/i.test(key)&&r.station[key]!=null){sid=String(r.station[key]).trim();break;}}
    }
    if(sid==null){
      for(const key of Object.keys(r)){const v=r[key];if(v!=null&&known[String(v).trim()]){sid=String(v).trim();break;}}
    }
    if(opts.forceSid!=null)sid=String(opts.forceSid);
    sid=sid||"API";
    const vals={};
    for(const def of CSV_FIELDS){
      if(CSV_META[def.f])continue;
      let best=null;
      for(const key of Object.keys(r)){
        const nh=normHdr(key);
        if(def.re.test(nh)&&(best==null||nh.length<best.nl)){const v=C.num(r[key]);if(v!=null)best={v:v,nl:nh.length};}
      }
      if(best)vals[def.f]=best.v;
    }
    if(!Object.keys(vals).length)continue;
    entries.push({sid:sid,day:day,hour:hourFrom(dRaw,r.time||r.nfdrTime||null),vals:vals});
  }
  return entries;
}
/* v83:1976 — VERBATIM daily worst-case reduction */
function reduceEntriesDaily(entries){
  const groups={};const out=[];
  for(const e of entries){(groups[e.sid+"|"+e.day]=groups[e.sid+"|"+e.day]||[]).push(e);}
  for(const k in groups){
    const g=groups[k].slice();const sid=g[0].sid,day=g[0].day;
    g.sort((a,b)=>{
      const ah=a.hour==null?99:Math.abs(a.hour-13),bh=b.hour==null?99:Math.abs(b.hour-13);
      return (ah-bh)||((b.hour==null?-1:b.hour)-(a.hour==null?-1:a.hour));
    });
    const rec={};
    for(const e of g)for(const f in e.vals){
      const v=e.vals[f];if(v==null)continue;
      if(rec[f]==null)rec[f]=v;
      else if(C.IDX_MAX[C.fmBase(f)])rec[f]=Math.max(rec[f],v);
      else if(C.FM_MIN[C.fmBase(f)])rec[f]=Math.min(rec[f],v);
    }
    if(rec.lfw==null&&rec.woody!=null)rec.lfw=rec.woody;
    out.push({sid:sid,day:day,vals:rec});
  }
  return out;
}
/* v83:1701 aggregateFems replumbed:
   {femsBy, stations:[{id,sel}], mode:"mean"|"max", skipStale:bool, today:"YYYY-MM-DD"}
   → {agg, stale}. Math and stale-quarantine logic verbatim; `today` injected
   for testability (v83 uses Date.now()). */
function aggregateFems(o){
  const by=o.femsBy||{};const listed={};
  (o.stations||[]).forEach(s=>{listed[s.id]=!!s.sel;});
  const yd=new Date(Date.parse((o.today||new Date().toISOString().slice(0,10))+"T12:00:00Z")-864e5);
  const yest=yd.getUTCFullYear()+"-"+String(yd.getUTCMonth()+1).padStart(2,"0")+"-"+String(yd.getUTCDate()).padStart(2,"0");
  const yr=by[yest]||{};
  const hasY=sid=>{const r=yr[sid];return !!(r&&Object.keys(r).length);};
  const staleSet={};
  const anyRecent=(o.stations||[]).some(s=>s.sel&&hasY(String(s.id)));
  if(o.skipStale!==false&&anyRecent){
    (o.stations||[]).forEach(s=>{const id=String(s.id);if(s.sel&&!hasY(id))staleSet[id]=1;});
  }
  const mode=o.mode||"mean";const agg={};
  for(const day in by){
    const acc={};let real=0;
    for(const sid in by[day]){
      if(C.PSEUDO_SIDS[sid])continue;
      if(staleSet[sid])continue;
      const inc=(sid in listed)?listed[sid]:true;
      if(!inc)continue;
      const r=by[day][sid];let any=0;
      for(const f in r){const v=r[f];if(v==null)continue;(acc[f]=acc[f]||[]).push(v);any=1;}
      if(any)real++;
    }
    if(!real){
      for(const sid in by[day]){
        if(!C.PSEUDO_SIDS[sid])continue;
        const r=by[day][sid];
        for(const f in r){const v=r[f];if(v==null)continue;(acc[f]=acc[f]||[]).push(v);}
      }
    }
    const out={};
    for(const f in acc){const a=acc[f];
      const worst=C.FM_MIN[C.fmBase(f)]?Math.min.apply(null,a):Math.max.apply(null,a);
      out[f]=Math.round((mode==="max"?worst:a.reduce((x,y)=>x+y,0)/a.length)*10)/10;}
    if(Object.keys(out).length)agg[day]=out;
  }
  return {agg:agg,stale:staleSet};
}

return {
  FEMS_URL_DEF,OM_BASE_DEF,OM_CUSTOMER_DEF,OM_ARCHIVE_DEF,
  OM_HOURLY,OM_DAILY,OM_EXOTIC,OM_MODELS,
  omBaseEff,omUrl,omFetch,parseOmOne,
  femsUrl,CSV_FIELDS,CSV_META,normHdr,splitDelim,sniffDelim,splitCsvLine,
  parseFemsCsv,colDateOk,autoMapCsv,hourFrom,mapHasValues,
  collectCsvEntries,parseFemsJson,reduceEntriesDaily,aggregateFems
};
});
