"use strict";
/* Engine regression suite.
   Layer A — PARITY: extracts the ORIGINAL function/const source out of
   fire_potential_dashboard_83.html, evaluates it in a sandbox, and asserts
   the engine returns identical output on fixture grids. Proves the port is
   verbatim for every global-free function.
   Layer B — BOUNDARIES: exact-edge fixtures for re-plumbed functions
   (devSev chain, dry lightning, composite, FEMS aggregation, OM plumbing). */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const C = require("../core.js");
const S = require("../sources.js");

const V83 = process.env.V83_PATH || "/mnt/project/fire_potential_dashboard_83.html";
const src = fs.readFileSync(V83, "utf8");

let pass = 0, fail = 0;
function ck(name, cond){ if(cond) pass++; else { fail++; console.log("FAIL", name); } }
function eq(name, a, b){ ck(name, JSON.stringify(a) === JSON.stringify(b)); if(JSON.stringify(a)!==JSON.stringify(b)&&process.env.VERBOSE)console.log("  got:",JSON.stringify(a),"\n  want:",JSON.stringify(b)); }
function close(name, a, b, tol){ ck(name, a==null&&b==null || Math.abs(a-b) <= (tol||1e-9)); }

/* ---------- source extractor: brace-balanced, string-aware ---------- */
function balancedFrom(text, start, openCh, closeCh, stopAtSemiDepth0){
  let depth = 0, i = start, inStr = null, inCmt = null;
  for (; i < text.length; i++){
    const ch = text[i], two = text.substr(i, 2);
    if (inCmt === "line"){ if (ch === "\n") inCmt = null; continue; }
    if (inCmt === "block"){ if (two === "*/"){ inCmt = null; i++; } continue; }
    if (inStr){ if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (two === "//"){ inCmt = "line"; i++; continue; }
    if (two === "/*"){ inCmt = "block"; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`"){ inStr = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh){ depth--; if (depth === 0 && !stopAtSemiDepth0) return i; }
    else if (stopAtSemiDepth0 && ch === ";" && depth === 0) return i;
  }
  return -1;
}
function extractFn(name){
  const re = new RegExp("(^|\\n)(async )?function " + name + "\\(", "");
  const m = re.exec(src);
  if (!m) throw new Error("function not found in v83: " + name);
  const declStart = m.index + m[1].length;
  const braceStart = src.indexOf("{", declStart);
  const end = balancedFrom(src, braceStart, "{", "}", false);
  return src.slice(declStart, end + 1);
}
function extractConst(name){
  const re = new RegExp("(^|\\n)const " + name + "\\s*=", "");
  const m = re.exec(src);
  if (!m) throw new Error("const not found in v83: " + name);
  const start = m.index + m[1].length;
  const end = balancedFrom(src, src.indexOf("=", start), "{", "}", true);
  return src.slice(start, end + 1);
}
function sandbox(parts){
  const ctx = vm.createContext({ Math, Date, JSON, isNaN, parseFloat, String, Number, Object, Array, console });
  vm.runInContext(parts.join("\n") + "\n", ctx);
  return ctx;
}

/* ================= Layer A — parity ================= */
const O1 = sandbox([
  extractConst("FMY"), extractConst("KC"), extractConst("COMPASS16"),
  extractConst("SIGMA_BANDS"),
  extractFn("ercY"), extractFn("kbdiStep"), extractFn("ffwiHour"), extractFn("hdwHour"),
  extractFn("ramp"), extractFn("gsiDaily"), extractFn("isoDurHours"), extractFn("sevFromThr"),
  extractFn("ercSev"), extractFn("ercBand"), extractFn("hainesTerm"), extractFn("compass16"),
  extractFn("pctlFromQ"), extractFn("sigTier"), extractFn("adjLevel"), extractFn("horizonScore"),
  extractFn("normDateKey"), extractFn("splitCsvLine")
]);
/* numeric grids */
for (const [fm1,fm10,fm100,fm1000,kb] of [[3,4,9,11,120],[8,9,14,16,50],[2,3,7,9,600],[25,25,25,25,0]])
  close("ercY "+fm1, C.ercY(fm1,fm10,fm100,fm1000,kb), O1.ercY(fm1,fm10,fm100,fm1000,kb));
for (const args of [[300,95,0,20,0],[300,95,0.15,20,0.1],[300,95,0.3,20,0.15],[700,45,0,12,0],[0,100,2.5,30,0]])
  eq("kbdiStep "+args.join(","), C.kbdiStep.apply(null,args), O1.kbdiStep.apply(null,args));
for (const [t,rh,w] of [[95,5,15],[85,30,10],[70,80,5],[100,50,25],[60,10,0]])
  close("ffwi "+rh, C.ffwiHour(t,rh,w), O1.ffwiHour(t,rh,w));
close("hdw", C.hdwHour(3.2,18), O1.hdwHour(3.2,18));
for (const s of ["P1D","PT6H","P1DT2H","PT30M","","bogus"]) eq("isoDur "+s, C.isoDurHours(s), O1.isoDurHours(s));
for (const v of [79,80,84,85,89,90,94,95,120,null]) eq("sevAsc "+v, C.sevFromThr(v,[80,85,90,95],1), O1.sevFromThr(v,[80,85,90,95],1));
for (const v of [31,30,26,25,21,20,16,15,5]) eq("sevDesc "+v, C.sevFromThr(v,[30,25,20,15],0), O1.sevFromThr(v,[30,25,20,15],0));
const BP={p80:58,p90:65,p97:73};
for (const v of [40,49.29,49.3,57.9,58,64.9,65,72.9,73,90]) eq("ercSev "+v, C.ercSev(v,BP), O1.ercSev(v,BP));
for (const v of [40,58,65,73]) eq("ercBand "+v, C.ercBand(v,BP), O1.ercBand(v,BP));
for (const z of [0.49,0.5,0.99,1.0,1.49,1.5,1.99,2.0,-1]) eq("sigTier "+z, C.sigTier(z), O1.sigTier(z));
for (const sc of [null,0,0.69,0.7,1.39,1.4,2.09,2.1,2.79,2.8,4]) eq("adjLevel "+sc, C.adjLevel(sc), O1.adjLevel(sc));
{
  const days=[{score:1.2},{score:3.0},{score:null},{score:2.4}];
  eq("horizonScore", C.horizonScore([0,1,2,3],days), O1.horizonScore([0,1,2,3],days));
  eq("horizonScore-key", C.horizonScore([0,1],days,"score"), O1.horizonScore([0,1],days,"score"));
}
const Q=[10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50];
for (const v of [5,10,11,25,49.9,50,60]) close("pctl "+v, C.pctlFromQ(Q,v), O1.pctlFromQ(Q,v));
for (const d of [0,11,22,180,359,361,-5]) eq("compass "+d, C.compass16(d), O1.compass16(d));
for (const s of ["2026-07-13","7/4/2026","07/04/2026","Jul 4 2026","garbage",null]) eq("normDate "+s, C.normDateKey(s), O1.normDateKey(s));
eq("splitCsvLine", S.splitCsvLine('a,"b,c",d'), O1.splitCsvLine('a,"b,c",d'));

/* CSV chain parity */
const O2 = sandbox([
  extractConst("CSV_FIELDS"), extractConst("CSV_META"), extractConst("FM_VARY"),
  extractConst("IDX_MAX"), extractConst("FM_MIN"), "const fmBase=f=>f.replace(/_[VWXYZ]$/,\"\");",
  extractFn("num"), extractFn("normHdr"), extractFn("splitDelim"), extractFn("sniffDelim"),
  extractFn("normDateKey"), extractFn("hourFrom"), extractFn("mapHasValues"),
  extractFn("parseFemsCsv"), extractFn("colDateOk"), extractFn("collectCsvEntries"),
  extractFn("reduceEntriesDaily")
]);
const FEMS_CSV = [
  "FEMS export — generated 2026-07-13",
  "",
  "Station_ID;NFDR_Dt;NFDR_Time;Fuel_Model;ERC;BI;One_Hr_TL_FuelMoisture;Thousand_Hr;Herb;Woody;KBDI",
  '351502;7/12/2026;13:00;16Y;61;38;3.1;10.5;72;98;310',
  '351502;7/12/2026;15:00;16Y;64;41;2.8;10.4;71;97;312',
  '351502;7/12/2026;13:00;16V;70;55;3.1;10.5;72;98;310',
  '"351520";7/12/2026;13:00;Y;58;33;3.4;11.2;80;104;280',
  '351502;7/13/2026;;16Y;66;;2.6;10.1;69;;315'
].join("\n");
{
  const pe = S.parseFemsCsv(FEMS_CSV), po = O2.parseFemsCsv(FEMS_CSV);
  eq("parseFemsCsv", pe, po);
  const map = {stn:0,date:1,time:2,fuelmodel:3,erc:4,bi:5,fm1:6,fm1000:7,lfm:8,lfw:9,kbdi:10};
  const ce = S.collectCsvEntries(pe,map,"API",null), co = O2.collectCsvEntries(po,map,"API",null);
  eq("collectCsvEntries", ce, co);
  eq("reduceEntriesDaily", S.reduceEntriesDaily(ce), O2.reduceEntriesDaily(co));
  eq("colDateOk", S.colDateOk(pe,1), O2.colDateOk(po,1));
  eq("hourFrom", [S.hourFrom("7/12/2026 13:00",null),S.hourFrom(null,"0730"),S.hourFrom("2026-07-12T09:00",null)],
                 [O2.hourFrom("7/12/2026 13:00",null),O2.hourFrom(null,"0730"),O2.hourFrom("2026-07-12T09:00",null)]);
}

/* parseOmOne parity */
const O3 = sandbox([
  extractConst("HAINES_PL"), extractConst("HDW_LVLS"), extractConst("HAINES_VAR"),
  extractFn("hainesTerm"), extractFn("hainesAt"), extractFn("hdwHour"), extractFn("ffwiHour"),
  extractFn("ramp"), extractFn("gsiDaily"), extractFn("parseOmOne")
]);
function omFixture(){
  const days=["2026-07-14","2026-07-15"];
  const time=[],mk=a=>a;
  for(const d of days)for(let h=0;h<24;h++)time.push(d+"T"+String(h).padStart(2,"0")+":00");
  const n=time.length, arr=f=>time.map((t,i)=>f(i,+t.slice(11,13)));
  return {
    elevation:1200, utc_offset_seconds:-25200,
    daily:{time:days,temperature_2m_max:[95,88],temperature_2m_min:[52,50],
      precipitation_sum:[0,0.22],precipitation_probability_max:[10,60],
      wind_speed_10m_max:[14,22],wind_gusts_10m_max:[26,38],wind_direction_10m_dominant:[225,190],
      sunrise:days.map(d=>d+"T05:30"),sunset:days.map(d=>d+"T20:45")},
    hourly:{time,
      temperature_2m:arr((i,h)=>60+30*Math.exp(-Math.pow(h-16,2)/40)),
      relative_humidity_2m:arr((i,h)=>60-45*Math.exp(-Math.pow(h-16,2)/50)),
      wind_speed_10m:arr((i,h)=>6+10*Math.exp(-Math.pow(h-15,2)/60)),
      wind_gusts_10m:arr(()=>18),
      cape:arr((i,h)=>h>=12&&h<=20?600:50),
      precipitation:arr(()=>0),
      vapour_pressure_deficit:arr((i,h)=>0.5+3.2*Math.exp(-Math.pow(h-16,2)/45)),
      surface_pressure:arr(()=>901),
      temperature_950hPa:arr(()=>75), temperature_850hPa:arr(()=>66),
      temperature_700hPa:arr(()=>48), temperature_500hPa:arr(()=>18),
      dew_point_700hPa:arr(()=>10), dew_point_850hPa:arr(()=>30),
      relative_humidity_900hPa:arr(()=>25), relative_humidity_850hPa:arr(()=>20),
      wind_speed_900hPa:arr(()=>20), wind_speed_850hPa:arr(()=>28)
    }
  };
}
{
  const fx=omFixture();
  const e=S.parseOmOne(JSON.parse(JSON.stringify(fx)));
  const o=O3.parseOmOne(JSON.parse(JSON.stringify(fx)));
  eq("parseOmOne-parity", e, o);
  ck("parseOmOne-fields", e.d["2026-07-14"].hdw!=null && e.d["2026-07-14"].hainesH!=null && e.d["2026-07-15"].rhrec!=null);
}

/* ================= Layer B — re-plumbed boundaries ================= */
const MD="2026-07-04";
const Nfull={tmax:{"07-04":100},tmaxSd:{"07-04":10},rhmin:{"07-04":20},rhminSd:{"07-04":4},rhmax:{"07-04":60},rhmaxSd:{"07-04":5}};
for (const [z,want] of [[-1.01,0],[-1.0,0],[-0.99,1],[-0.5,1],[-0.49,2],[0.74,2],[0.75,3],[1.49,3],[1.5,4]])
  eq("devSev-sigma z="+z, C.devSev("tmax",100+z*10,MD,Nfull), want);
eq("devSev-rhmin-sign", C.devSev("rhmin",20-4*1.5,MD,Nfull), 4);
eq("devSev-rhrec-uses-rhmax", C.devSev("rhrec",60-5*1.5,MD,Nfull), 4);
{
  const Nthin=JSON.parse(JSON.stringify(Nfull)); Nthin.tmaxSd["07-04"]=0.5;
  eq("devSev-MIN_SD-floor", C.devSev("tmax",101.5,MD,Nthin), 3); /* z=1.0 floored, not 3.0 raw */
}
const Nmeans={tmax:{"07-04":100},rhmin:{"07-04":20},rhmax:{"07-04":60}};
for (const [d,want] of [[-8,0],[-4,1],[5.99,2],[6,3],[12,4]])
  eq("devSev-dep tmax d="+d, C.devSev("tmax",100+d,MD,Nmeans), want);
eq("devSev-dep-rhmin", C.devSev("rhmin",20-8,MD,Nmeans), 3);
eq("devSev-abs", C.devSev("tmax",95,MD,null), 4);
eq("devBasis", [C.devBasis("tmax",MD,Nfull),C.devBasis("tmax",MD,Nmeans),C.devBasis("tmax",MD,null)], ["sigma","dep","abs"]);

for (const [d,want] of [
  [{pot:5,precip:0,rhmin:30},[2,"DRY LTG"]],[{pot:9.9,precip:0,rhmin:30},[2,"DRY LTG"]],
  [{pot:10,precip:0,rhmin:30},[3,"DRY LTG"]],[{pot:15,precip:0,rhmin:30},[4,"DRY LTG"]],
  [{pot:25,precip:0,rhmin:30},[4,"DRY LTG"]],
  [{pot:20,precip:0.10,rhmin:30},[2,"LTG"]],  /* 0.10 is NOT <0.10 → wet */
  [{pot:20,precip:0,rhmin:35},[2,"LTG"]],     /* 35 is NOT <35 → not dry */
  [{pot:12,precip:0.5,rhmin:50},[0,"\u2014"]],
  [{pot:4,precip:0,rhmin:20},[0,"\u2014"]],
  [{cape:400,precip:0,rhmin:20},[3,"DRY LTG"]],[{cape:1000,precip:0,rhmin:20},[4,"DRY LTG"]],
  [{cape:399,precip:0,rhmin:20},[0,"\u2014"]],[{},[null,null]]
]){ const r=C.dryLightning(d); eq("dryltg "+JSON.stringify(d), [r.v,r.txt], want); }

eq("lalSev", [C.lalSev(2),C.lalSev(3),C.lalSev(4),C.lalSev(5),C.lalSev(6),C.lalSev(null)], [0,1,2,3,4,null]);
eq("lalFromPot", [C.lalFromPot(9),C.lalFromPot(10),C.lalFromPot(30),C.lalFromPot(50),C.lalFromPot(70)], [1,2,3,4,5]);
eq("rfwSev", [C.rfwSev("RFW",true),C.rfwSev("FWW",true),C.rfwSev(null,true),C.rfwSev(null,false)], [4,3,0,null]);
eq("hainesApplicable", [C.hainesApplicableFromElev(914).v,C.hainesApplicableFromElev(913).v,C.hainesApplicableFromElev(null).v,C.hainesApplicableFromElev(200).low], ["H","M",null,true]);
eq("hainesWeight", [C.hainesWeight({v:"H"},"H",0.8),C.hainesWeight({v:"H"},"M",0.8),C.hainesWeight({v:null},"M",0.8)], [0.8,0,0.8]);

{
  const r=C.scoreContribs([
    {id:"tmax",s:3,w:0.8},{id:"erc",s:4,w:2.0},{id:"rfw",s:4,w:1.5},
    {id:"wind",s:null,w:1.2},{id:"gust",s:2,w:0}
  ]);
  close("score", r.score, 16.4/4.3, 1e-12);
  close("score-fuels", r.fuels, 4, 1e-12);
  close("score-wx", r.wx, 3, 1e-12);
  eq("score-contrib-len", r.contrib.length, 3);
  close("contrib-c", r.contrib[0].c, 2.4, 1e-12);
}
{
  const samples=[
    {who:"P1 \u00b7 gfs", d:{tzOff:-25200, d:{D1:{tmax:90,pop:20,rhmin:15,gust:10}}}},
    {who:"P1 \u00b7 ecmwf", d:{d:{D1:{tmax:94,pop:40,rhmin:11,gust:30}}}}
  ];
  const mean=C.aggregateWx(samples,["D1"],"mean");
  eq("aggWx-mean", [mean.d.D1.tmax,mean.d.D1.pop,mean.d.D1.rhmin,mean.tzOff], [92,30,13,-25200]);
  const high=C.aggregateWx(samples,["D1"],"high");
  eq("aggWx-high", [high.d.D1.tmax,high.d.D1.pop,high.d.D1.rhmin,high.d.D1.gust], [94,20,11,30]);
  const conf=C.modelSpread(samples,["D1"]);
  close("modelSpread-n", conf.D1.n, 3/4, 1e-12);   /* tmax, rhmin, pop agree; gust splits */
  eq("modelSpread-vars", [conf.D1.agree,conf.D1.vars], [3,4]);
  eq("modelSpread-why", conf.D1.why, "gust 0/2");
}
{
  const o={
    today:"2026-07-13", mode:"mean", skipStale:true,
    stations:[{id:"1",sel:true},{id:"2",sel:true},{id:"3",sel:false},{id:"4",sel:true}],
    femsBy:{
      "2026-07-12":{ "1":{erc:50}, "4":{erc:44} },
      "2026-07-13":{ "1":{erc:60,fm100:12}, "2":{erc:70,fm100:9}, "3":{erc:99}, "4":{erc:75,fm100:14}, "API":{erc:88} },
      "2026-07-10":{ "API":{erc:40} }
    }
  };
  const r=S.aggregateFems(o);
  eq("fems-stale", r.stale, {"2":1});
  eq("fems-mean", r.agg["2026-07-13"], {erc:67.5,fm100:13});
  eq("fems-pseudo-fill", r.agg["2026-07-10"], {erc:40});
  const rMax=S.aggregateFems(Object.assign({},o,{mode:"max"}));
  eq("fems-worst", rMax.agg["2026-07-13"], {erc:75,fm100:12});
}
{
  const u=S.omUrl({key:"K"},[{lat:45.7,lon:-117.17,elevFt:5000}],"gfs_seamless",["cape"]);
  ck("omUrl-customer", u.indexOf(S.OM_CUSTOMER_DEF)===0);
  ck("omUrl-elev", u.indexOf("&elevation=1524")>=0);
  ck("omUrl-key", u.indexOf("&apikey=K")>=0);
  ck("omUrl-dropped", u.indexOf("cape")<0);
  ck("omUrl-model", u.indexOf("&models=gfs_seamless")>=0);
}
{
  const seq=[
    {ok:false,status:400,json:async()=>({reason:"Cannot initialize WeatherVariable cape"})},
    {ok:false,status:400,json:async()=>({reason:"bad request"})},
    {ok:true,json:async()=>({hello:1})}
  ];
  let calls=0;
  const fetchStub=async()=>seq[calls++];
  const drop=[];
  S.omFetch(fetchStub,{},[{lat:1,lon:1}],"gfs_seamless",drop).then(j=>{
    ck("omFetch-heal-result", j.hello===1);
    ck("omFetch-heal-cape", drop.indexOf("cape")>=0);
    ck("omFetch-heal-exotic", drop.indexOf("surface_pressure")>=0);
    ck("omFetch-calls", calls===3);
    return S.omFetch(async()=>({ok:false,status:429,json:async()=>({reason:"limit"})}),{},[{lat:1,lon:1}],"gfs",[])
      .then(()=>ck("omFetch-429-throws",false),e=>ck("omFetch-429-throws",/429/.test(String(e))));
  }).then(()=>{
    /* browser-global smoke */
    const ctx=vm.createContext({self:{}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,"..","core.js"),"utf8"),ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname,"..","sources.js"),"utf8"),ctx);
    ck("browser-globals", !!(ctx.self.FPBCore&&ctx.self.FPBCore.adjLevel&&ctx.self.FPBSources&&ctx.self.FPBSources.parseOmOne));
    console.log(pass+" passed, "+fail+" failed");
    process.exit(fail?1:0);
  }).catch(e=>{console.error(e);process.exit(1);});
}
