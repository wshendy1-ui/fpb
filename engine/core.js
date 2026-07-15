/* =========================================================================
   FPB ENGINE — core.js (v1)
   View-agnostic compute core extracted from Fire Potential Dashboard v83.
   Math is VERBATIM; only the plumbing changed: functions that read v83
   globals (area(), state, fx, dd(i)) now take explicit arguments. Every
   symbol carries its v83 source line for provenance.

   Loads as CommonJS (Node: cron, tests) or a browser global (FPBCore).
   ========================================================================= */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.FPBCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

/* ==================== CONSTANTS (v83, verbatim) ==================== */
/* v83:557 NFDRS 2016 fuel model Y parameters */
const FMY={w1:2.5,w10:2.2,w100:3.6,w1000:10.16,sg1:2000,sg10:109,sg100:30,sg1000:8,depth:0.6,mxd:25,ldrought:5,kbdiTh:100};
/* v83:558 */
const KC={hd:8000,rhod:32,std:0.0555,etas:0.4173969,cta:0.0459137,coef:0.04,tauC:384};
/* v83:635 raw-departure fallback thresholds */
const DEV_SEV_THR={tmax:[-8,-4,6,12],rhmin:[-8,-4,8,16],rhrec:[-10,-5,10,20]};
/* v83:639 normal-centered sigma ladder: at-normal = T2 */
const SIGMA_SEV_THR=[-1.0,-0.5,0.75,1.5];
/* v83:640 σ-chip tint tiers only */
const SIGMA_BANDS=[0.5,1.0,1.5,2.0];
/* v83:641-643 */
const SD_KEY={tmax:"tmaxSd",rhmin:"rhminSd",rhrec:"rhmaxSd"};
const MIN_SD={tmax:1.5,rhmin:2.0,rhrec:2.0};
const ANOM_NKEY={tmax:"tmax",rhmin:"rhmin",rhrec:"rhmax"};
/* v83:646 */
const PSEUDO_SIDS={API:1,CSV:1,FILE:1,PASTE:1};
/* v83:647-649 */
const FM_SET=["Y","V","W","X"];
const FM_LAB={Y:"Y — timber",V:"V — grass",W:"W — grass/shrub",X:"X — brush"};
const FM_VARY={erc:1,bi:1,ic:1,sc:1};
/* v83:652-653 severity direction for daily/area reduction */
const IDX_MAX={erc:1,bi:1,ic:1,sc:1,kbdi:1};
const FM_MIN={fm1:1,fm10:1,fm100:1,fm1000:1,lfm:1,lfw:1,woody:1};
/* v83:662 */
const DEF_BREAKS={p80:58,p90:65,p97:73};
/* v83:663 absolute-threshold ladders + weights (field-tunable) */
const THR_DEF={
  tmax:{t:[80,85,90,95],w:0.8,asc:1,lab:"Max temp °F"},
  rhmin:{t:[30,25,20,15],w:1.3,asc:0,lab:"Min RH %"},
  rhrec:{t:[60,45,35,25],w:1.0,asc:0,lab:"RH recovery %"},
  /* wind/gust ladders recalibrated 2026-07-15 (calibration memo, candidate E1):
     original [0,5,10,15]/[5,10,15,20] scored the MEDIAN daily-max July day at
     sev 3/4 (means 3.24/3.25 across 6,580 zone-days), inflating the national
     baseline to T3. E1 anchors the median day (14 mph sust / 22 gust) at sev 2
     and sev 4 at wind-event class. Sigma rows untouched — they were on target. */
  wind:{t:[8,13,18,25],w:1.2,asc:1,lab:"Wind sust. mph"},
  gust:{t:[15,22,30,40],w:0.8,asc:1,lab:"Gusts mph"},
  pot:{t:[5,10,30,50],w:0.7,asc:1,lab:"Thunder prob %"},
  pop:{t:[40,25,15,8],w:0.4,asc:0,lab:"PoP %"},
  cape:{t:[200,500,1000,1500],w:0.4,asc:1,lab:"CAPE J/kg"},
  hdw:{t:[75,150,250,350],w:1.3,asc:1,lab:"HDW index"},
  hainesH:{t:[4,5,5.5,6],w:0.8,asc:1,lab:"Haines High 700/500"},
  hainesM:{t:[4,5,5.5,6],w:0.8,asc:1,lab:"Haines Mid 850/700"},
  ffwi:{t:[20,35,50,65],w:0.9,asc:1,lab:"Fosberg FFWI"},
  vpd:{t:[2,3,4,5],w:0.7,asc:1,lab:"Max VPD kPa"},
  vi:{t:[200,200,500,700],w:0,asc:1,lab:"Ventilation TW×MH/100ft"},
  bi:{t:[30,40,50,60],w:1.2,asc:1,lab:"Burning Index"},
  ic:{t:[30,50,70,85],w:0.8,asc:1,lab:"Ignition Comp"},
  fm100:{t:[14,11,9,7],w:1.2,asc:0,lab:"100-hr FM %"},
  fm1000:{t:[15,12,10,8],w:1.5,asc:0,lab:"1000-hr FM %"},
  lfm:{t:[120,100,80,60],w:0.6,asc:0,lab:"Live herb FM %"},
  lfw:{t:[130,110,95,80],w:0.6,asc:0,lab:"Live woody FM %"},
  kbdi:{t:[200,400,550,650],w:1.0,asc:1,lab:"KBDI"}
};
/* v83:686 row weights outside THR_DEF */
const W_ERC=2.0,W_HAINES=0.8,W_LAL=1.0,W_DRY=1.1,W_RFW=1.5;
/* v83:688 dry-lightning confidence tiers */
const DRYLTG_POT=[5,10,15,25],DRYLTG_LAB=["LOW","MED","HIGH","LIKELY"],DRYLTG_SEV=[2,3,4,4];
/* v83:689-690 */
const ADJ=["LOW","MODERATE","HIGH","VERY HIGH","EXTREME"];
const ADJ_S=["LOW","MOD","HIGH","V HIGH","EXTR"];
/* v83:692 sub-score buckets */
const ROW_BUCKET={erc:"f",bi:"f",ic:"f",fm100:"f",fm1000:"f",lfm:"f",lfw:"f",kbdi:"f",rfw:"o"};
/* v83:695-702 model-agreement confidence */
const CONF_NORM={tmax:5,wind:5,gust:6,rhmin:5,hdw:60,pop:20};
const CONF_LAB=["LOW","MED","HIGH"];
const CONF_VAR_MAJ=0.5;
const CONF_HI=0.5,CONF_MED=0.25;
/* v83:917 Haines variant coefficients (°C deltas) */
const HAINES_VAR={
  High:{upper:500,lower:700,moist:700,sc1:18,sc2:22,mc1:15,mc2:21,moistUsesUpper:false},
  Mid: {upper:700,lower:850,moist:850,sc1:6, sc2:11,mc1:6, mc2:13,moistUsesUpper:false},
  Low: {upper:850,lower:950,moist:850,sc1:4, sc2:8, mc1:6, mc2:10,moistUsesUpper:true}};
/* v83:1094-1095 */
const HDW_LVLS=[1000,975,950,925,900,850,800,700];
const HAINES_PL=["temperature_950hPa","temperature_850hPa","temperature_700hPa","temperature_500hPa","dew_point_700hPa","dew_point_850hPa"];
/* v83:1162 */
const WX_FIELDS=["tmax","tmin","precip","pop","wind","gust","rhmin","vpdmax","vpdmean","hdw","hdwSfc","ffwi","cape","rhrec","gsi","daylen","hainesH","hainesM"];
/* v83:2297 */
const COMPASS16=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
/* v83:2588 benign-driver phrasing for Low/Moderate horizons */
const MOD_PHRASE={
  rhmin:t=>"higher RH (min "+t+"%)",
  rhrec:t=>"good overnight RH recovery ("+t+"%)",
  tmax:t=>"cooler temps ("+t+"°F)",
  wind:t=>"light winds ("+t+" mph)",
  gust:t=>"modest gusts ("+t+" mph)",
  hdw:t=>"low HDW ("+t+")",
  ffwi:t=>"low FFWI ("+t+")",
  vpd:t=>"low VPD ("+t+" kPa)",
  hainesH:t=>"stable air (Haines "+t+")",
  hainesM:t=>"stable air (Haines "+t+")",
  erc:(t,sub)=>"ERC below breakpoints ("+t+(sub?" · "+sub:"")+")",
  bi:t=>"low BI ("+t+")",
  ic:t=>"low ignition component ("+t+")",
  fm100:t=>"moist 100-hr fuels ("+t+"%)",
  fm1000:t=>"moist 1000-hr fuels ("+t+"%)",
  lfm:t=>"green herbaceous fuels ("+t+"%)",
  lfw:t=>"green woody fuels ("+t+"%)",
  kbdi:t=>"low KBDI ("+t+")"
};

/* ==================== PURE HELPERS (v83, verbatim) ==================== */
/* v83:650 */ const fmBase=f=>f.replace(/_[VWXYZ]$/,"");
/* v83:693 */ function bucketOf(id){return ROW_BUCKET[id]||"w";}
/* v83:703 */ function confBand(n){return n==null?null:(n>=CONF_HI?2:n>=CONF_MED?1:0);}
/* v83:868 */ function num(x){const v=parseFloat(x);return isNaN(v)?null:v;}

/* v83:559 NFDRS 2016 model-Y ERC */
function ercY(fm1,fm10,fm100,fm1000,kbdi){
  const F=FMY,sum=F.w1+F.w10+F.w100+F.w1000;
  const k=(kbdi>F.kbdiTh)?1+(kbdi-F.kbdiTh)*F.ldrought/((800-F.kbdiTh)*sum):1;
  const fine=(F.w1+F.w10+F.w100)*KC.cta;
  const wn=sum*KC.cta*(1-KC.std)*k;
  const beta=(fine/F.depth)/KC.rhod;
  const sigL=(F.w1*F.sg1+F.w10*F.sg10+F.w100*F.sg100+F.w1000*F.sg1000)/sum;
  const sigA=(F.w1*F.sg1*F.sg1+F.w10*F.sg10*F.sg10+F.w100*F.sg100*F.sg100)/(F.w1*F.sg1+F.w10*F.sg10+F.w100*F.sg100);
  const betaOp=3.348*Math.pow(sigL,-0.8189);
  const gMax=Math.pow(sigL,1.5)/(495+0.0594*Math.pow(sigL,1.5));
  const A=133*Math.pow(sigL,-0.7913);
  const g=gMax*Math.pow(beta/betaOp,A)*Math.exp(A*(1-beta/betaOp));
  const fm=(F.w1*fm1+F.w10*fm10+F.w100*fm100+F.w1000*fm1000)/sum;
  const r=fm/F.mxd;
  const eta=Math.max(0,Math.min(1,1-2*r+1.5*r*r-0.5*r*r*r));
  const I=g*wn*KC.hd*KC.etas*eta;
  return KC.coef*I*(KC.tauC/sigA);
}
/* v83:579 KBDI daily step */
function kbdiStep(Q,tmaxF,rainIn,annP,carry){
  let c=carry||0,net=0;
  if(rainIn>0.001){const tot=c+rainIn;net=Math.max(0,tot-0.20)-Math.max(0,c-0.20);c=tot;}else{c=0;}
  let q=Math.max(0,Q-net*100);
  if(tmaxF>50){
    const dF=(800-q)*(0.968*Math.exp(0.0486*tmaxF)-8.30)/(1+10.88*Math.exp(-0.0441*annP))*0.001;
    q=Math.min(800,q+Math.max(0,dF));
  }
  return {q:q,carry:c};
}
/* v83:590 Fosberg FFWI hourly */
function ffwiHour(tF,rh,mph){
  let m;
  if(rh<10)m=0.03229+0.281073*rh-0.000578*rh*tF;
  else if(rh<=50)m=2.22749+0.160107*rh-0.01478*tF;
  else m=21.0606+0.005565*rh*rh-0.00035*rh*tF-0.483199*rh;
  m=Math.max(0,Math.min(30,m));
  const r=m/30,eta=1-2*r+1.5*r*r-0.5*r*r*r;
  return Math.max(0,eta*Math.sqrt(1+mph*mph)/0.3002);
}
/* v83:600 */ function hdwHour(vpdKPa,mph){return (vpdKPa*10)*(mph*0.44704);}
/* v83:602-603 */
function ramp(x,a,b){return Math.max(0,Math.min(1,(x-a)/(b-a)));}
function gsiDaily(tminC,vpdKPa,daylenHr){return ramp(tminC,-2,5)*(1-ramp(vpdKPa,0.9,4.1))*ramp(daylenHr,10,11);}
/* v83:605 */
function isoDurHours(s){
  const m=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s||"");
  if(!m)return 1;
  const h=(+m[1]||0)*24+(+m[2]||0)+((+m[3]||0)/60);
  return h||1;
}
/* v83:612 severity 0–4 from four thresholds */
function sevFromThr(v,t,asc){
  if(v==null||isNaN(v))return null;
  if(asc)return v>=t[3]?4:v>=t[2]?3:v>=t[1]?2:v>=t[0]?1:0;
  return v<=t[3]?4:v<=t[2]?3:v<=t[1]?2:v<=t[0]?1:0;
}
/* v83:617-618 ERC vs area breakpoints */
function ercSev(v,bp){if(v==null||isNaN(v))return null;if(v>=bp.p97)return 4;if(v>=bp.p90)return 3;if(v>=bp.p80)return 2;if(v>=bp.p80*0.85)return 1;return 0;}
function ercBand(v,bp){if(v==null||isNaN(v))return "";if(v>=bp.p97)return "≥97th %ile";if(v>=bp.p90)return "90–97th";if(v>=bp.p80)return "80–90th";return "<80th %ile";}
/* v83:921 */ function hainesTerm(delta,c1,c2){if(delta==null)return null;return delta<c1?1:delta<c2?2:3;}
/* v83:922 — pure already: H is a °C-converted hourly map, i an hour index */
function hainesAt(H,i,V){
  const uT=(H["temperature_"+V.upper+"hPa"]||[])[i],lT=(H["temperature_"+V.lower+"hPa"]||[])[i],
        dw=(H["dew_point_"+V.moist+"hPa"]||[])[i];
  const mT=V.moistUsesUpper?uT:lT;
  const sd=(uT==null||lT==null)?null:(lT-uT);
  const md=(mT==null||dw==null)?null:(mT-dw);
  const A=hainesTerm(sd,V.sc1,V.sc2),B=hainesTerm(md,V.mc1,V.mc2);
  return (A==null||B==null)?null:(A+B);
}
/* v83:934 replumbed: elevation in, DOM/state out. mode "auto"|"H"|"M". */
function hainesApplicableFromElev(elevM,mode){
  mode=mode||"auto";
  if(mode==="H"||mode==="M")return {v:mode,elevM:null,src:"manual",low:false};
  if(elevM==null)return {v:null,elevM:null,src:"pending",low:false};
  return {v:(elevM>=914?"H":"M"),elevM:elevM,src:"auto",low:elevM<305};
}
/* v83:2495/2498 the weight gate: non-applicable variant scores 0 */
function hainesWeight(applicable,which,w){return (applicable.v==null||applicable.v===which)?w:0;}
/* v83:2297 */ function compass16(deg){return COMPASS16[Math.round(((deg%360)+360)%360/22.5)%16];}
/* v83:2298 percentile from a 21-point quantile ladder */
function pctlFromQ(q,v){
  if(!q||q.length!==21||v==null)return null;
  if(v<=q[0])return 0;if(v>=q[20])return 100;
  let k=0;while(k<20&&q[k+1]<v)k++;
  const a=q[k],b=q[k+1];const f=b>a?(v-a)/(b-a):0;
  return (k+f)*5;
}
/* v83:1825 */
function normDateKey(s){
  if(!s)return null;s=String(s).trim();
  let m=/^(\d{4})-(\d{2})-(\d{2})/.exec(s);if(m)return m[1]+"-"+m[2]+"-"+m[3];
  m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);if(m)return m[3]+"-"+String(m[1]).padStart(2,"0")+"-"+String(m[2]).padStart(2,"0");
  const t=Date.parse(s);if(!isNaN(t))return new Date(t).toISOString().slice(0,10);
  return null;
}

/* ==================== NORMAL-CENTERED SCORING (v83, re-plumbed) ==================== */
/* dateKey = "YYYY-MM-DD"; normals = the wxNormals object (v83 shape / climo files). */
/* v83:2241 wxDep — signed departure from day-of-year normal */
function wxDep(normals,id,dateKey,value){
  if(!normals||value==null||dateKey==null)return null;
  const nm=normals[ANOM_NKEY[id]];if(!nm)return null;
  const nv=nm[dateKey.slice(5)];if(nv==null)return null;
  return value-nv;
}
/* v83:2251 wxSigma — adverse departure in floored SDs (positive = worse) */
function wxSigma(normals,id,dateKey,value){
  const dep=wxDep(normals,id,dateKey,value);if(dep==null)return null;
  const sdm=normals[SD_KEY[id]];if(!sdm)return null;
  let s=sdm[dateKey.slice(5)];if(s==null)return null;
  s=Math.max(s,MIN_SD[id]);
  const adverse=id==="tmax"?dep:-dep;
  return adverse/s;
}
/* v83:2267 */ function sigTier(z){const b=SIGMA_BANDS;return z>=b[3]?4:z>=b[2]?3:z>=b[1]?2:z>=b[0]?1:0;}
/* v83:2268 devSev — normal-centered severity with the graceful fallback chain:
   SD present → sigma · means only → raw departure · no normals → absolute thresholds */
function devSev(id,value,dateKey,normals,thr){
  thr=thr||THR_DEF;
  const bin=(a,t)=>(a<=t[0]?0:a<=t[1]?1:a>=t[3]?4:a>=t[2]?3:2);
  const z=wxSigma(normals,id,dateKey,value);
  if(z!=null)return bin(z,SIGMA_SEV_THR);
  const d=wxDep(normals,id,dateKey,value);
  if(d!=null)return bin(id==="tmax"?d:-d,DEV_SEV_THR[id]);
  return sevFromThr(value,thr[id].t,thr[id].asc);
}
/* which basis devSev used — for UI badges and verification records */
function devBasis(id,dateKey,normals){
  if(normals&&normals[SD_KEY[id]]&&normals[SD_KEY[id]][String(dateKey).slice(5)]!=null)return "sigma";
  if(normals&&normals[ANOM_NKEY[id]]&&normals[ANOM_NKEY[id]][String(dateKey).slice(5)]!=null)return "dep";
  return "abs";
}

/* v83:2450 dry-lightning flag — verbatim gate: <0.10" wetting AND RH<35 */
function dryLightning(d){
  if(d.pot==null&&d.cape==null)return{v:null,txt:null};
  const dry=(d.precip==null||d.precip<0.10)&&(d.rhmin==null||d.rhmin<35);
  let txt="\u2014",sub=null,sev=0;
  if(d.pot!=null){
    if(dry&&d.pot>=DRYLTG_POT[0]){
      const t=d.pot>=DRYLTG_POT[3]?3:d.pot>=DRYLTG_POT[2]?2:d.pot>=DRYLTG_POT[1]?1:0;
      txt="DRY LTG";sev=DRYLTG_SEV[t];
      sub=DRYLTG_LAB[t]+(t===3?"":" conf")+" \u00b7 PoT "+Math.round(d.pot)+"%";
    }else if(d.pot>=15){txt="LTG";sev=2;sub="wetting rain likely";}
  }else if(dry&&d.cape>=400){
    const t=d.cape>=1000?2:1;
    txt="DRY LTG";sev=DRYLTG_SEV[t];
    sub=DRYLTG_LAB[t]+" conf \u00b7 CAPE "+Math.round(d.cape);
  }
  return{v:sev,txt:txt,sub:sub,flag:sev>0};
}
/* v83:2490-2493 LAL */
function lalFromPot(pot){return pot<10?1:pot<30?2:pot<50?3:pot<70?4:5;}
function lalSev(v){return v==null?null:(v>=6?4:v>=5?3:v>=4?2:v>=3?1:0);}
/* v83:2525 RFW/FWW — null (not 0) when the alerts feed is down */
function rfwSev(v,alertsOk){return v==="RFW"?4:v==="FWW"?3:(alertsOk?0:null);}

/* ==================== COMPOSITE (v83, re-plumbed) ==================== */
/* v83:2528 scoreDay math over precomputed entries [{id,s,w,...}].
   The adapter (UI row system or cron) computes each row's severity; this
   fuses them exactly as v83 does, including fuels/weather sub-buckets. */
function scoreContribs(entries){
  let sw=0,swx=0;const contrib=[];
  const B={f:{s:0,w:0},w:{s:0,w:0}};
  for(const r of entries){
    const s=r.s,w=r.w;
    if(s==null||!w)continue;
    sw+=w*s;swx+=w;contrib.push(Object.assign({c:w*s},r));
    const b=bucketOf(r.id);if(B[b]){B[b].s+=w*s;B[b].w+=w;}
  }
  return{score:swx?sw/swx:null,
    fuels:B.f.w?B.f.s/B.f.w:null,
    wx:B.w.w?B.w.s/B.w.w:null,
    contrib:contrib};
}
/* v83:2543 */ function adjLevel(sc){return sc==null?null:sc<0.7?0:sc<1.4?1:sc<2.1?2:sc<2.8?3:4;}
/* v83:2544 */
function horizonScore(idxs,days,key){
  const ss=idxs.map(i=>days[i][key||"score"]).filter(s=>s!=null);
  if(!ss.length)return null;
  return 0.6*Math.max(...ss)+0.4*(ss.reduce((a,b)=>a+b,0)/ss.length);
}
/* v83:2549 replumbed: confByDay = modelSpread output, dayKeys = fx.days */
function horizonConf(idxs,confByDay,dayKeys){
  if(!confByDay)return null;
  let worst=null;
  for(const i of idxs){const c=confByDay[dayKeys[i]];
    if(c&&(worst==null||c.n<worst.n))worst=c;}
  return worst;
}
/* v83:2556 replumbed: contrib entries carry {id,nm?,cv} instead of a row ref */
function horizonDrivers(idxs,days){
  const best={};
  for(const i of idxs)for(const c of days[i].contrib){
    if(c.s<2)continue;
    if(!best[c.id]||c.c>best[c.id].c)best[c.id]=Object.assign({i:i},c);
  }
  return Object.values(best).sort((a,b)=>b.c-a.c).slice(0,3)
    .map(c=>{const t=c.cv&&c.cv.sub&&c.id==="erc"?c.cv.sub:((c.cv&&c.cv.txt)||"");
      return ((c.nm||c.id).split("(")[0].trim())+(t?" "+t:"");});
}
/* v83:2588 replumbed likewise */
function horizonModerators(idxs,days){
  const best={};
  for(const i of idxs)for(const c of days[i].contrib){
    if(c.s==null||c.s>1||!c.cv||c.cv.v==null)continue;
    if(!MOD_PHRASE[c.id])continue;
    const sc=c.w*(2-c.s);
    if(!best[c.id]||sc>best[c.id].mSc)best[c.id]=Object.assign({mSc:sc,i:i},c);
  }
  return Object.values(best).sort((a,b)=>b.mSc-a.mSc).slice(0,3)
    .map(c=>MOD_PHRASE[c.id](c.cv.txt!=null?c.cv.txt:String(c.cv.v),c.cv.sub));
}

/* ==================== MULTI-MODEL AGGREGATION (v83, re-plumbed) ==================== */
/* WX_DIR (v83:1163): per-field direction for "high-risk" aggregation */
const WX_DIR=(function(){
  const d={tmin:1,precip:0,pop:0,vpdmean:1,gust:1,daylen:null,gsi:0,hainesH:1,hainesM:1,hdwSfc:1};
  const map={tmax:"tmax",rhmin:"rhmin",rhrec:"rhrec",wind:"wind",hdw:"hdw",ffwi:"ffwi",vpdmax:"vpd",cape:"cape",hainesH:"hainesH",hainesM:"hainesM"};
  for(const f in map){if(THR_DEF[map[f]])d[f]=THR_DEF[map[f]].asc;}
  return d;
})();
/* v83:1170 aggregateWx replumbed: samples=[{who,d:parseOmOne-output}] → {d,who,tzOff}.
   NWS-field preservation and alert rebuild stay in the adapter (they merge state). */
function aggregateWx(samples,dayKeys,mode){
  mode=mode||"mean";
  const out={d:{},who:{},tzOff:null};
  if(!samples||!samples.length)return out;
  const s0=samples.find(s=>s.d.tzOff!=null);if(s0)out.tzOff=s0.d.tzOff;
  for(const k of dayKeys){
    const o=out.d[k]={};
    const whoDay=out.who[k]={};
    for(const f of WX_FIELDS){
      const vals=[],who=[];
      for(const s of samples){const v=(s.d.d[k]||{})[f];if(v!=null&&!isNaN(v)){vals.push(v);who.push(s.who+" "+(Math.round(v*10)/10));}}
      if(!vals.length){o[f]=null;continue;}
      const dir=WX_DIR[f];
      o[f]=(mode==="high"&&dir!=null)
        ?(dir?Math.max.apply(null,vals):Math.min.apply(null,vals))
        :vals.reduce((a,b)=>a+b,0)/vals.length;
      whoDay[f]=who.join(" \u00b7 ");
    }
  }
  return out;
}
/* v83:704 modelSpread replumbed: (samples,dayKeys) → conf map */
function modelSpread(samples,dayKeys){
  const out={};
  if(!samples||samples.length<2)return out;
  const models={};
  samples.forEach(s=>{const m=(s.who.split(" \u00b7 ")[1]||"?");(models[m]=models[m]||[]).push(s);});
  const mk=Object.keys(models);
  if(mk.length<2)return out;
  for(const k of (dayKeys||[])){
    let nv=0,na=0;const splits=[];
    for(const f in CONF_NORM){
      const vals=[];
      for(const m of mk){
        const vs=models[m].map(s=>((s.d.d||{})[k]||{})[f]).filter(v=>v!=null&&!isNaN(v));
        if(vs.length)vals.push(vs.reduce((a,b)=>a+b,0)/vs.length);
      }
      if(vals.length<2)continue;
      nv++;
      const so=vals.slice().sort((a,b)=>a-b);
      const med=so.length%2?so[(so.length-1)/2]:(so[so.length/2-1]+so[so.length/2])/2;
      const nin=vals.filter(v=>Math.abs(v-med)<=CONF_NORM[f]).length;
      if(nin/vals.length>=CONF_VAR_MAJ)na++;
      else splits.push(f+" "+nin+"/"+vals.length);
    }
    if(nv<2)continue;
    out[k]={n:na/nv,agree:na,vars:nv,why:splits.slice(0,2).join(", "),models:mk.length+" models"};
  }
  return out;
}

return {
  FMY,KC,DEV_SEV_THR,SIGMA_SEV_THR,SIGMA_BANDS,SD_KEY,MIN_SD,ANOM_NKEY,PSEUDO_SIDS,
  FM_SET,FM_LAB,FM_VARY,IDX_MAX,FM_MIN,DEF_BREAKS,THR_DEF,
  W_ERC,W_HAINES,W_LAL,W_DRY,W_RFW,DRYLTG_POT,DRYLTG_LAB,DRYLTG_SEV,ADJ,ADJ_S,
  ROW_BUCKET,CONF_NORM,CONF_LAB,CONF_VAR_MAJ,CONF_HI,CONF_MED,
  HAINES_VAR,HDW_LVLS,HAINES_PL,WX_FIELDS,WX_DIR,COMPASS16,MOD_PHRASE,
  fmBase,bucketOf,confBand,num,
  ercY,kbdiStep,ffwiHour,hdwHour,ramp,gsiDaily,isoDurHours,
  sevFromThr,ercSev,ercBand,hainesTerm,hainesAt,hainesApplicableFromElev,hainesWeight,
  compass16,pctlFromQ,normDateKey,
  wxDep,wxSigma,sigTier,devSev,devBasis,
  dryLightning,lalFromPot,lalSev,rfwSev,
  scoreContribs,adjLevel,horizonScore,horizonConf,horizonDrivers,horizonModerators,
  aggregateWx,modelSpread
};
});
