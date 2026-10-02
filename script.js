(function(){
"use strict";

/* ===== board geometry (read from the reference image) ===== */
const ROWS=12, COLS=11, MG=28, SP0=42;
let SP=SP0, pieceScale=1;   // SP = spacing between intersections (changed by the Settings panel)
const SEA_MAX=1;      // cols 0..1 = open sea (navy only)
const SHORE=2;        // col 2 = shoreline, everyone allowed
const FORDS=[5,7];    // river crossings open to all
const RIVER_LO=5, RIVER_HI=6;   // river runs between these two rows

const T={
  CMD :{n:"Tư lệnh",     c:"TL",v:10000},
  SCH :{n:"Sở chỉ huy",  c:"SCH",v:0},
  NAVY:{n:"Tàu chiến",   c:"TC",v:80},
  AIR :{n:"Không quân",  c:"KQ",v:45},
  ART :{n:"Pháo binh",   c:"PB",v:32},
  SAM :{n:"Tên lửa",     c:"TLa",v:24},
  TANK:{n:"Xe tăng",     c:"XT",v:22},
  AA  :{n:"Cao xạ",      c:"CX",v:14},
  ENG :{n:"Công binh",   c:"CB",v:12},
  INF :{n:"Bộ binh",     c:"BB",v:11},
  MIL :{n:"Dân quân",    c:"DQ",v:11},
};
const LIGHT=["CMD","INF","ENG","MIL","TANK"];   // may ford the deep river unaided
const CARRIER=["TANK","NAVY","AIR"];              // carriers for general troops (Engineers carry ONLY heavy gear, see HEAVY_RIDER)
const RIDER=["CMD","INF","MIL"];                // general troop transport: may board any CARRIER (or own HQ, CMD only)
const HEAVY_RIDER=["AA","ART","SAM"];           // heavy equipment (Cao xạ, Pháo binh, Tên lửa): carried ONLY by an Engineer, to cross the river
const SCH_BREAKERS=["ENG","TANK","ART","AIR"];  // only these may capture a headquarters
function canCapture(attackerType,target){ return target.type!=="SCH" || SCH_BREAKERS.includes(attackerType); }

const ORTHO=[[1,0],[-1,0],[0,1],[0,-1]];
const DIAG=[[1,1],[1,-1],[-1,1],[-1,-1]];
const ALL8=ORTHO.concat(DIAG);

/* Red's 19 pieces, exactly as positioned in the reference diagram [col,row] */
const RED_SETUP=[
  ["CMD",6,0],
  ["NAVY",1,1],["AIR",4,1],["SCH",5,1],["SCH",7,1],["AIR",8,1],
  ["ART",3,2],["SAM",6,2],["ART",9,2],
  ["NAVY",2,3],["AA",4,3],["TANK",5,3],["TANK",7,3],["AA",8,3],
  ["INF",2,4],["ENG",3,4],["MIL",6,4],["ENG",9,4],["INF",10,4],
];

let bd,turn,mode="local",human="RED",sel=null,moves=[],log=[],
    lostR=[],lostB=[],last=null,over=false,warnSide=null,history=[];
let clockMin=0,clockT={RED:0,BLUE:0},lastTick=Date.now();   // clockMin = minutes per side (0 = unlimited)

const K=(r,c)=>r+","+c;
const inB=(r,c)=>r>=0&&r<ROWS&&c>=0&&c<COLS;
const at=(r,c)=>bd[K(r,c)];
const foe=(p,s)=>p&&p.side!==s;

function setup(){
  bd={};
  for(const [t,c,r] of RED_SETUP){
    bd[K(r,c)]={type:t,side:"RED",hero:false,r,c};
    const mr=ROWS-1-r;
    bd[K(mr,c)]={type:t,side:"BLUE",hero:false,r:mr,c};
  }
  turn="RED";sel=null;moves=[];log=[];lostR=[];lostB=[];last=null;over=false;warnSide=null;history=[];
  clockT={RED:clockMin*60000,BLUE:clockMin*60000};lastTick=Date.now();
  if(typeof updClock==="function")updClock();
}

/* ===== terrain ===== */
function isSea(r,c){ return c<=SEA_MAX; }
function isRiverDeep(r,c){ return (r===RIVER_LO||r===RIVER_HI) && !FORDS.includes(c) && c>SEA_MAX; }
function isWater(r,c){ return isSea(r,c) || isRiverDeep(r,c); }
function canStand(t,r,c){
  if(!inB(r,c))return false;
  if(isSea(r,c)) return t==="NAVY"||t==="AIR";
  return true;                       // col 2+ open to all, navy included (shoreline)
}
function navyOk(r,c){
  if(c<=SHORE) return true;                                   // the sea lane itself, any row
  return (r===RIVER_LO||r===RIVER_HI) && c<=FORDS[0];          // deep river, up to the near ford
}
function standOk(t,r,c){
  if(!canStand(t,r,c))return false;
  if(t==="NAVY"&&!navyOk(r,c))return false;
  return true;
}
// heavy ground units (not in LIGHT) may never wade a deep-river cell on a quiet move;
// they may still land there when the move is a capture (crossing to take a piece on the far bank).
function heavyBlocked(t,r,c){ return isRiverDeep(r,c) && !LIGHT.includes(t); }

/* ===== air-defence coverage owned by the enemy of `side` ===== */
function adZone(side){
  const z=new Set();
  for(const p of Object.values(bd)){
    if(p.side===side)continue;
    if(p.type==="AA"||p.type==="NAVY"){   // a warship carries its own AA battery
      z.add(K(p.r,p.c));
      for(const [a,b] of ALL8) if(inB(p.r+a,p.c+b)) z.add(K(p.r+a,p.c+b));
    }
    if(p.type==="SAM"){
      z.add(K(p.r,p.c));
      for(const [a,b] of ORTHO) for(let s=1;s<=2;s++) if(inB(p.r+a*s,p.c+b*s)) z.add(K(p.r+a*s,p.c+b*s));
      for(const [a,b] of DIAG) if(inB(p.r+a,p.c+b)) z.add(K(p.r+a,p.c+b));
    }
  }
  return z;
}

/* ===== generic slider ===== */
function slide(p,dirs,max){
  const out=[];
  for(const [dr,dc] of dirs){
    for(let s=1;s<=max;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(!o){
        if(heavyBlocked(p.type,r,c))break;             // can't wade deep water without being carried
        if(standOk(p.type,r,c))out.push({r,c}); else break;
      } else {
        // capturing across the river is always allowed, even for a heavy unit, at any river segment
        if(foe(o,p.side)&&standOk(p.type,r,c)&&canCapture(p.type,o))out.push({r,c,cap:o});
        break;
      }
    }
  }
  return out;
}
// stand still and capture a Navy target within reach (Infantry/Engineer/AA/Militia); heroic adds a segment
function waterAdjCapture(p){
  const out=[], range=p.hero?2:1;
  for(const [dr,dc] of ALL8){
    for(let s=1;s<=range;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(o){ if(foe(o,p.side)&&o.type==="NAVY"&&isWater(r,c)) out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true}); break; }
    }
  }
  return out;
}
/* fire without moving */
function fire(p,dirs,max,pred){
  const out=[];
  for(const [dr,dc] of dirs){
    for(let s=1;s<=max;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(o){ if(foe(o,p.side)&&(!pred||pred(o,r,c))) out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true}); break; }
    }
  }
  return out;
}

function gen(p){
  if(p.type==="SCH") return [];               // a headquarters never moves or attacks
  const h=p.hero?1:0;
  switch(p.type){
    case "CMD":{
      const out=[];
      for(const [dr,dc] of ORTHO){
        for(let s=1;s<ROWS+COLS;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(!o){ if(standOk("CMD",r,c))out.push({r,c}); else break; }
          else { if(s===1&&foe(o,p.side)&&canCapture("CMD",o))out.push({r,c,cap:o}); break; }
        }
      }
      return out.filter(m=>!faceOff(p,m));
    }
    case "INF": return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "ENG": return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "AA":  return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "MIL": return slide(p,ALL8,1+h).concat(waterAdjCapture(p));
    case "TANK":{
      const shipPred=(o,r,c)=>o.type==="NAVY"&&isWater(r,c);
      return slide(p,ORTHO,2+h).concat(fire(p,ORTHO,2+h,shipPred))
        .concat(p.hero?slide(p,DIAG,2+h).concat(fire(p,DIAG,2+h,shipPred)):[]);   // hero: diagonals too
    }
    case "SAM": return slide(p,ORTHO,2+h).concat(slide(p,DIAG,1+h)).filter(m=>!m.cap||m.cap.type!=="NAVY");
    case "ART": {   // moves AND captures by replacement: straight 1-2 cells, diagonal (45°) 1 cell (+1 if hero)
      const shipPred=(o,r,c)=>o.type==="NAVY"&&isWater(r,c);
      return slide(p,ORTHO,2+h).concat(slide(p,DIAG,1+h))
        .concat(fire(p,ORTHO,2+h,shipPred)).concat(fire(p,DIAG,1+h,shipPred));
    }
    case "AIR": {
      const R=4+h,Z=p.hero?new Set():adZone(p.side),out=[];   // a hero aircraft is stealth: immune to every air-defence zone
      for(const [dr,dc] of ALL8){
        for(let s=1;s<=R;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;                         // only the board edge stops a flight path
          const o=at(r,c), inZ=Z.has(K(r,c));
          if(o && foe(o,p.side) && inZ && canCapture("AIR",o)){
            out.push({r,c,cap:o,trade:true});          // anything inside hostile airspace: one-for-one
            continue;                                   // still free to keep flying past it
          }
          if(!o){ if(!inZ && !isSea(r,c)) out.push({r,c}); continue; }  // safe, empty & landable
          if(inZ) continue;                             // a friendly unit sheltering there: fly on past
          if(foe(o,p.side) && canCapture("AIR",o)){
            const canReplace = !isSea(r,c);              // an aircraft can never finish a move into the sea
            if(canReplace) out.push({r,c,cap:o});
            if(o.type!=="AIR") out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});   // bomb & return to base
          } else if(!foe(o,p.side) && o.type==="NAVY" && !o.rider){
            out.push({r,c,ride:true});                  // land aboard a friendly ship (carrier)
          }
          // any blocker (friend or foe) never stops the flight - keep scanning past it
        }
      }
      return out;
    }
    case "NAVY": {
      const out=[], sailCaps=new Set(), sailR=4+h;
      for(const [dr,dc] of ALL8){      // sails (and fires its missile point-blank) up to 4 segments, any direction
        for(let s=1;s<=sailR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c)||!navyOk(r,c))break;
          const o=at(r,c);
          if(!o){ out.push({r,c}); continue; }
          if(foe(o,p.side)&&canCapture("NAVY",o)){ out.push({r,c,cap:o}); sailCaps.add(K(r,c)); }
          break;
        }
      }
      for(const [dr,dc] of ALL8){      // anti-ship missile: Navy-only target, stand-fire only when not directly sailable
        for(let s=1;s<=sailR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(o&&o.type==="NAVY"&&foe(o,p.side)&&!sailCaps.has(K(r,c)))
            out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});
          // a guided missile isn't stopped by ordinary obstructions - keep scanning past anything else
        }
      }
      const gunR=3+h;                   // onboard gun: dry-land targets only, always stand-fire
      for(const [dr,dc] of ALL8){
        for(let s=1;s<=gunR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(o&&foe(o,p.side)&&o.type!=="NAVY"&&c>SHORE&&canCapture("NAVY",o))
            out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});
        }
      }
      return out;
    }
  }
  return [];
}

function cmdOf(s){
  for(const p of Object.values(bd)) if(p.type==="CMD"&&p.side===s) return p;
  for(const p of Object.values(bd)) if(p.rider&&p.rider.type==="CMD"&&p.rider.side===s) return {type:"CMD",side:s,hero:p.rider.hero,r:p.r,c:p.c,mounted:true};
  return undefined;
}

function faceOff(p,m){
  const e=cmdOf(p.side==="RED"?"BLUE":"RED");
  if(!e)return false;
  if(m.r!==e.r&&m.c!==e.c)return false;
  const a=K(p.r,p.c),b=K(m.r,m.c),sa=bd[a],sb=bd[b];
  delete bd[a]; bd[b]={...p,r:m.r,c:m.c};
  let blocked=false;
  if(m.r===e.r){const lo=Math.min(m.c,e.c),hi=Math.max(m.c,e.c);for(let c=lo+1;c<hi;c++)if(at(m.r,c)){blocked=true;break;}}
  else {const lo=Math.min(m.r,e.r),hi=Math.max(m.r,e.r);for(let r=lo+1;r<hi;r++)if(at(r,m.c)){blocked=true;break;}}
  bd[a]=sa; if(sb)bd[b]=sb; else delete bd[b];
  return !blocked;
}

function cloneBoard(b){
  const out={};
  for(const k in b){ const p=b[k]; out[k]=p.rider?{...p,rider:{...p.rider}}:{...p}; }
  return out;
}

function legal(side){
  const out=[];
  for(const p of Object.values(bd)){
    if(p.side!==side)continue;
    for(const m of gen(p)) out.push({from:{r:p.r,c:p.c},...m,pt:p.type});
    if(p.rider){   // the passenger may hop off and move on its own
      const v={type:p.rider.type,side:p.side,hero:p.rider.hero,r:p.r,c:p.c};
      for(const m of gen(v)) out.push({from:{r:p.r,c:p.c},...m,pt:v.type,off:true});
    }
  }
  for(const p of Object.values(bd)){   // board a friendly carrier
    if(p.side!==side||p.rider)continue;
    const general=RIDER.includes(p.type), heavy=HEAVY_RIDER.includes(p.type);
    if(!general&&!heavy)continue;
    for(const [dr,dc] of (p.type==="MIL"?ALL8:ORTHO)){
      const r=p.r+dr,c=p.c+dc;
      if(!inB(r,c))continue;
      const o=at(r,c);
      if(!o||o.side!==side||o.rider)continue;
      if(general&&(CARRIER.includes(o.type)||(o.type==="SCH"&&p.type==="CMD")))
        out.push({from:{r:p.r,c:p.c},r,c,pt:p.type,ride:true});
      else if(heavy&&o.type==="ENG")
        out.push({from:{r:p.r,c:p.c},r,c,pt:p.type,ride:true});
    }
  }
  return out;
}

// is `side`'s commander currently attacked? Uses raw pseudo-legal generation only - never calls
// legalSafe - so it can't recurse into itself while legalSafe is busy filtering.
function inCheck(side){
  const cmd=cmdOf(side);
  if(!cmd) return false;
  const enemy=side==="RED"?"BLUE":"RED";
  for(const p of Object.values(bd)){
    if(p.side!==enemy) continue;
    if(gen(p).some(x=>x.cap&&x.r===cmd.r&&x.c===cmd.c)) return true;
    if(p.rider){
      const v={type:p.rider.type,side:p.side,hero:p.rider.hero,r:p.r,c:p.c};
      if(gen(v).some(x=>x.cap&&x.r===cmd.r&&x.c===cmd.c)) return true;
    }
  }
  return false;
}

// the actual moves a player may choose: every pseudo-legal move that does not leave their own
// commander in check afterward (this is what makes responding to a check mandatory).
function legalSafe(side){
  return legal(side).filter(m=>{
    const snap=cloneBoard(bd);
    sim(m);
    const safe=!inCheck(side);
    bd=snap;
    return safe;
  });
}

/* ===== apply ===== */
function take(p){ if(!p)return; (p.side==="BLUE"?lostB:lostR).push(p.type); }

function play(m,quiet){
  if(!quiet)history.push({bd:JSON.parse(JSON.stringify(bd)),turn,log:log.slice(),lostR:lostR.slice(),lostB:lostB.slice(),last});
  const fk=K(m.from.r,m.from.c), mv=bd[fk];
  if(!mv)return;
  let got=null, actor=null;

  // destroying an occupied square destroys everything on it - a combined piece goes down together
  function destroyStack(r,c){
    const there=at(r,c);
    if(!there)return null;
    if(there.rider) take({...there.rider,side:there.side});
    take(there);
    delete bd[K(r,c)];
    return there;
  }

  if(m.ride){
    const car=at(m.r,m.c);
    car.rider={type:mv.type,side:mv.side,hero:mv.hero};
    delete bd[fk]; actor=car;
    note(m,mv.type,null,mv.type==="AIR"&&car.type==="NAVY"?"hạ cánh xuống tàu":mv.type==="CMD"&&car.type==="SCH"?"vào sở chỉ huy":"lên xe");
  } else if(m.stay){
    got={...m.cap};
    destroyStack(m.tr,m.tc);
    actor=mv;
    note(m,(m.off&&mv.rider)?mv.rider.type:mv.type,got,"bắn tại chỗ");   // a passenger firing from its carrier never harms the carrier
  } else if(m.off){
    const host=at(m.from.r,m.from.c), rd=host.rider;
    delete host.rider;
    if(m.cap){got={...m.cap};destroyStack(m.r,m.c);}
    if(m.trade){ take({...rd}); note(m,rd.type,got,"đổi mạng"); }
    else {
      bd[K(m.r,m.c)]={type:rd.type,side:rd.side,hero:rd.hero,r:m.r,c:m.c};
      actor=bd[K(m.r,m.c)];
      note(m,rd.type,got,"xuống xe");
    }
  } else if(m.trade){
    got={...m.cap};
    destroyStack(m.r,m.c);
    if(mv.rider) take({...mv.rider,side:mv.side});
    take(mv);
    delete bd[fk];
    note(m,mv.type,got,"đổi mạng");
  } else {
    if(m.cap){ got={...m.cap}; destroyStack(m.r,m.c); }
    delete bd[fk];
    const np={type:mv.type,side:mv.side,hero:mv.hero,r:m.r,c:m.c};
    if(mv.rider)np.rider=mv.rider;
    bd[K(m.r,m.c)]=np; actor=np;
    note(m,mv.type,got,null);
  }

  last={a:m.from,b:{r:m.r,c:m.c}};

  if(actor&&!actor.hero){         // promote whoever now attacks the enemy commander
    if(gen(actor).some(x=>x.cap&&x.cap.type==="CMD")){
      actor.hero=true;
      if(!quiet)toast((actor.side==="RED"?"Đỏ":"Xanh")+": "+T[actor.type].n+" thành quân ANH HÙNG ★");
    }
  }

  if(!cmdOf("RED")) return finish("BLUE","Tư lệnh Đỏ đã bị bắt.");
  if(!cmdOf("BLUE")) return finish("RED","Tư lệnh Xanh đã bị bắt.");

  turn = turn==="RED"?"BLUE":"RED";
  const side=turn==="RED"?"Đỏ":"Xanh", foeSide=turn==="RED"?"BLUE":"RED";
  if(!legalSafe(turn).length){
    if(inCheck(turn)) return finish(foeSide,"Bên "+side+" bị chiếu bí: Tư lệnh bị chiếu và không còn nước giải.");
    return finish(null,"Bên "+side+" hết nước đi nhưng Tư lệnh không bị chiếu (bí nước).");
  }
  if(onlyKingsLeft()) return finish(null,"Hai bên không còn đủ quân để chiếu.");
  if(threefold()) return finish(null,"Thế cờ lặp lại lần thứ 3.");

  warnSide = inCheck(turn)?turn:null;
  if(!quiet){ draw(); setTimeout(aiTurn,60); }
}

function note(m,t,got,tag){
  let s=(log.length+1)+". "+(turn==="RED"?"Đỏ":"Xanh")+" "+T[t].n+" "+m.from.c+","+m.from.r+"→"+(m.tc??m.c)+","+(m.tr??m.r);
  if(got)s+=" (ăn "+T[got.type].n+")";
  if(tag)s+=" ["+tag+"]";
  log.push(s);
}
function posKey(b,t){
  return Object.keys(b).sort().map(k=>{const p=b[k];
    return k+p.type+p.side[0]+(p.hero?1:0)+(p.rider?p.rider.type+p.rider.side[0]+(p.rider.hero?1:0):"");}).join("|")+t;
}
function onlyKingsLeft(){   // neither side owns anything that could ever check the enemy commander
  for(const p of Object.values(bd)){
    if(p.type!=="CMD"&&p.type!=="SCH")return false;
    if(p.rider&&p.rider.type!=="CMD")return false;
  }
  return true;
}
function threefold(){
  const k=posKey(bd,turn); let n=1;
  for(const h of history) if(posKey(h.bd,h.turn)===k) n++;
  return n>=3;
}
function finish(w,why){
  over=true;
  document.getElementById('ovT').textContent=w?((w==="RED"?"ĐỎ":"XANH")+" THẮNG"):"HOÀ";
  document.getElementById('ovP').textContent=why;
  document.getElementById('over').classList.add('on');
  draw();
}

/* ===== icons ===== */
const ICON={
CMD:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M50.0 17.5L58.0 41.5L83.3 41.7L62.9 56.7L70.6 80.8L50.0 66.1L29.4 80.8L37.1 56.7L16.7 41.7L42.0 41.5z"/></svg>`,
INF:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M32 36C32 24.5 40 18.5 50 18.5S68 24.5 68 36z"/><path class="d" d="M50.0 23.8L51.2 27.0L54.6 27.1L51.9 29.2L52.8 32.5L50.0 30.6L47.2 32.5L48.1 29.2L45.4 27.1L48.8 27.0z"/><path class="s" d="M12 44.6h26v3.2H12zM13.5 42.4h3v2.4h-3z"/><path class="s" d="M36 41.6h34v8.4H36z"/><path class="s" d="M70 43l18 5.6 1.4 9.6-19.4-5.6z"/><path class="s" d="M47 50h12l8 15.5-8.4 2.6z"/><path class="s" d="M64 50h7l3.4 10-7.6 1z"/></svg>`,
TANK:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M12.5 39.2h30v3.2h-30z"/><path class="s" d="M35 33h21l6 9.5H31z"/><path class="s" d="M15.5 55.5L29.5 44.5h46l9 9v8h-69z"/><rect class="s" x="21" y="57" width="64" height="12" rx="6"/><g class="d"><circle cx="30" cy="63" r="2.6"/><circle cx="40" cy="63" r="2.6"/><circle cx="50" cy="63" r="2.6"/><circle cx="60" cy="63" r="2.6"/><circle cx="70" cy="63" r="2.6"/><circle cx="78" cy="63" r="2.2"/></g></svg>`,
MIL:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M47 17c8-5 21-1 22 12 .6 7-1.4 12-4.4 15.6H48c-3.6-3-6.2-8-6.2-13.4 0-6.4 1.6-11.4 5.2-14.2z"/><path class="s" d="M52.5 42h11v24h-11z"/><path class="s" d="M28 80l2.4-8.4c.8-2.4 2.6-3.6 5-4.6L50 61l6 4.4 7-4.4 13.6 5.4c3 1.2 5 3 6 5.8L85 80z"/><path class="ld" stroke-width="1.3" stroke-linecap="round" d="M47.5 31c5 .4 11 4.4 12.4 12M55.6 36.6h4.4M61 39.6l-1.3 4.4 2.5.6M57 49.6c2.4.8 4.6.8 6.4-.2"/><path class="ld" stroke-width="1.5" stroke-linecap="round" d="M44 24.5c2-3.4 6-5.4 10-5.4"/><rect class="s" x="21" y="35" width="3.4" height="44" rx="1.2"/><path class="s" d="M22.7 27l2.8 8h-5.6z"/><path class="ld" stroke-width="1.5" d="M25.6 52c7 3 11 8 14 18"/></svg>`,
ENG:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path fill="#58c6ea" d="M12.7 60 A38.6 38.6 0 0 0 87.3 60z"/><path class="s" d="M13.5 49.5h73v10h-73z"/><g class="s"><rect x="17" y="44.5" width="3.4" height="6"/><rect x="33" y="44.5" width="3.4" height="6"/><rect x="49" y="44.5" width="3.4" height="6"/><rect x="65" y="44.5" width="3.4" height="6"/><rect x="80" y="44.5" width="3.4" height="6"/></g><g class="s"><rect x="24" y="59" width="2.2" height="9"/><rect x="40" y="59" width="2.2" height="9"/><rect x="56" y="59" width="2.2" height="9"/><rect x="72" y="59" width="2.2" height="9"/></g></svg>`,
ART:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="ls" stroke="var(--sym)" stroke-width="4.6" d="M47.5 57L31.5 21"/><path class="s" d="M28.6 19.6l6.4-2.8 1.6 3.6-6.4 2.8z"/><path class="ls" stroke="var(--sym)" stroke-width="1.8" d="M52 51.5l4.5 9"/><path class="s" d="M40 55h21v9H40z"/><path class="s" d="M45 52h12v4H45z"/><path class="s" d="M28 65.5h50l4-4.5v12H28z"/><g><circle class="s" cx="34.5" cy="74" r="6"/><circle class="d" cx="34.5" cy="74" r="2.7"/><circle class="s" cx="66.5" cy="74" r="6"/><circle class="d" cx="66.5" cy="74" r="2.7"/></g></svg>`,
AA:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="ls" stroke="var(--sym)" stroke-width="2.8" d="M56 51L26.5 21.5M61.5 47L32 17.5"/><path class="s" d="M48 62l6-11h15l5 11z"/><path class="s" d="M21.5 62h58v6.5h-58z"/><path class="s" d="M78 53h9v12h-9z"/><g><circle class="s" cx="22" cy="69" r="6.6"/><circle class="d" cx="22" cy="69" r="3.3"/><circle class="s" cx="70" cy="72" r="6.6"/><circle class="d" cx="70" cy="72" r="3.3"/></g></svg>`,
SAM:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><g transform="rotate(-40 52 46)"><path class="s" d="M26 43.4h34l9 2.6-9 2.6H26z"/><path class="s" d="M26 43.4l-6-6.2h7.4l4 6.2zM26 48.6l-6 6.2h7.4l4-6.2z"/><path class="s" d="M46 43.4l-3.6-5h5l2.6 5zM46 48.6l-3.6 5h5l2.6-5z"/></g><path class="ls" stroke="var(--sym)" stroke-width="3" d="M49 71l5.5-10"/><path class="s" d="M31 76l9-6h15l5 7.5-2 4.5H33z"/><path class="ld" stroke-width="1.1" d="M42 79h12"/></svg>`,
AIR:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M14 50C17 46.6 26 45.4 36 45.4H76L83 38.5 86 40 81.5 45.6 83.5 50 81.5 54.4 86 60 83 61.5 76 54.6H36C26 54.6 17 53.4 14 50z"/><path class="s" d="M37 46L58 15l9.5 2L64 46zM37 54L58 85l9.5-2L64 54z"/><path class="s" d="M46 32.5c-1.6-2.6-.6-5.6 1.6-6.2 1.8 1.4 2.4 4.2 1.4 7z"/><path class="s" d="M46 67.5c-1.6 2.6-.6 5.6 1.6 6.2 1.8-1.4 2.4-4.2 1.4-7z"/></svg>`,
NAVY:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path fill="#58c6ea" d="M13.7 63 A38.6 38.6 0 0 0 86.3 63z"/><path class="s" d="M13 55.5h74l-8.5 10H21z"/><path class="s" d="M26 48.4c1-3 4-4.6 8-4.6h6c3.6 0 6 1.6 6.6 4.6z"/><path class="ls" stroke="var(--sym)" stroke-width="2.6" d="M31 46.5L17.5 38.5"/><path class="s" d="M47 46h22v9.5H47z"/><path class="s" d="M52 41h13v5H52z"/><g class="d"><rect x="50" y="49" width="3.4" height="3"/><rect x="56" y="49" width="3.4" height="3"/><rect x="62" y="49" width="3.4" height="3"/></g><path class="s" d="M63 21h3v20h-3z"/><path class="s" d="M58.5 27h12v2.2h-12zM60.5 34h8v2h-8z"/><circle class="s" cx="64.5" cy="20" r="2.4"/></svg>`,
SCH:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M14 50.5h5.4v-5.2h6.2v5.2H32v-5.2h6.2v5.2H44v-5.2h6.2v5.2h10V80H14z"/><path class="s" d="M60 58h26v22H60z"/><g class="d"><rect x="23" y="62" width="11" height="8" rx="1"/><path d="M40 80v-8c0-3.5 2.5-5.5 5-5.5s5 2 5 5.5v8z"/><rect x="66" y="66" width="14" height="6" rx="1"/></g><path class="ls" stroke="var(--sym)" stroke-width="3" stroke-linecap="round" d="M73 58V32M73 38L64.5 24M73 38L81.5 24"/><path class="ls" stroke="var(--sym)" stroke-width="2.4" stroke-linecap="round" d="M67 46h12M68.5 52h9"/></svg>`,
};

/* ===== rendering ===== */
const stage=document.getElementById('stage'), terr=document.getElementById('terrain');
const X=c=>MG+c*SP, Y=r=>MG+(ROWS-1-r)*SP;
let W=0,H=0;
const calcSize=()=>{W=MG*2+(COLS-1)*SP;H=MG*2+(ROWS-1)*SP;};
calcSize();

function terrainSVG(){
  const riverTop=Y(RIVER_HI), riverBot=Y(RIVER_LO);
  let s=`<svg width="${W}" height="${H}" style="display:block">`;
  s+=`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  s+=`<rect x="${X(0)-MG/2}" y="0" width="${X(SHORE)-X(0)+MG/2}" height="${H}" fill="var(--sea)"/>`;
  s+=`<rect x="0" y="${riverTop}" width="${W}" height="${riverBot-riverTop}" fill="var(--sea)"/>`;
  for(const f of FORDS){                    // ford markings
    s+=`<g stroke="#9a8464" stroke-width="2.4" stroke-linecap="round" opacity=".85">`;
    for(let i=0;i<5;i++){
      const fx=X(f)-9+Math.random()*0, ox=[-7,2,-2,8,4][i], oy=riverTop+5+i*((riverBot-riverTop-10)/4);
      s+=`<line x1="${fx+ox}" y1="${oy}" x2="${fx+ox+3}" y2="${oy+7}"/>`;
    }
    s+=`</g>`;
  }
  s+=`<g stroke="var(--grid)" stroke-width="1.6">`;
  for(let c=0;c<COLS;c++) s+=`<line x1="${X(c)}" y1="${Y(ROWS-1)}" x2="${X(c)}" y2="${Y(0)}"/>`;
  for(let r=0;r<ROWS;r++) s+=`<line x1="${X(0)}" y1="${Y(r)}" x2="${X(COLS-1)}" y2="${Y(r)}"/>`;
  s+=`</g>`;
  s+=`<rect x="${X(0)-MG/2}" y="${Y(ROWS-1)-MG/2}" width="${(COLS-1)*SP+MG}" height="${(ROWS-1)*SP+MG}" fill="none" stroke="var(--frame)" stroke-width="3"/>`;
  s+=`<g fill="#6b6b5e" font-size="10" font-family="Georgia">`;
  for(let c=0;c<COLS;c++) s+=`<text x="${X(c)-3}" y="${H-4}">${c}</text>`;
  for(let r=0;r<ROWS;r++) s+=`<text x="2" y="${Y(r)+4}">${r}</text>`;
  s+=`</g></svg>`;
  return s;
}

function draw(){
  calcSize();
  stage.style.width=W+"px"; stage.style.height=H+"px";
  terr.innerHTML=terrainSVG();
  [...stage.querySelectorAll('.pc,.mk,.lm')].forEach(e=>e.remove());
  const D=SP*0.92*pieceScale, tilt=stage.classList.contains('flat')?0:46;
  // standing pieces: lift by the radius' vertical extent so their lower edge clears the board plane, and slide toward the viewer so the disc stays centred on its intersection on screen
  const _rad=tilt*Math.PI/180, pz=(D/2)*Math.sin(_rad)+1.5, pY=pz*Math.tan(_rad), pT=(dz)=>`translateY(${pY}px) translateZ(${pz+dz}px) rotateX(-${tilt}deg)`;

  if(last){
    for(const q of [last.a,last.b]){
      const d=document.createElement('div');
      d.className='lm';
      d.style.cssText=`left:${X(q.c)-D/2}px;top:${Y(q.r)-D/2}px;width:${D}px;height:${D}px`;
      stage.appendChild(d);
    }
  }
  for(const p of Object.values(bd)){
    const e=document.createElement('div');
    e.className='pc '+p.side+(sel&&sel.r===p.r&&sel.c===p.c?' sel':'');
    e.style.cssText=`left:${X(p.c)-D/2}px;top:${Y(p.r)-D/2}px;width:${D}px;height:${D}px;transform:${pT(0)}`;
    e.innerHTML=ICON[p.type]+(p.hero?'<span class="hero">★</span>':'')+(p.rider?'<span class="car"></span>':'');
    e.title=T[p.type].n+(p.hero?" ★":"")+(p.rider?(p.type==="NAVY"&&p.rider.type==="AIR"?" (tàu sân bay)":" (cõng "+T[p.rider.type].n+")"):"");
    e.onclick=ev=>{ev.stopPropagation();tap(p.r,p.c);};
    stage.appendChild(e);
  }
  const groups=new Map();
  for(const m of moves){
    const key=(m.tr??m.r)+","+(m.tc??m.c);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(m);
  }
  for(const [key,group] of groups){
    const [tr,tc]=key.split(",").map(Number);
    const anyCap=group.some(x=>x.cap);
    const d=document.createElement('div'); let s=anyCap?D*0.5:D*0.34;
    const isRide=!anyCap&&group.some(x=>x.ride);
    if(isRide)s=D*0.78;
    d.className='mk'+(anyCap?' cap':'')+(isRide?' ride':'')+(group.length>1?' multi':'');
    d.style.cssText=`left:${X(tc)-s/2}px;top:${Y(tr)-s/2}px;width:${s}px;height:${s}px;transform:rotateX(-${tilt}deg) translateZ(6px)`;
    stage.appendChild(d);
    const hit=document.createElement('div');
    hit.className='pc hit';
    hit.style.cssText=`left:${X(tc)-D/2}px;top:${Y(tr)-D/2}px;width:${D}px;height:${D}px;background:none;border:none;box-shadow:none;transform:${pT(1)};z-index:5`;
    hit.onclick=ev=>{ev.stopPropagation();chooseAmong(group);};
    stage.appendChild(hit);
  }

  // quân đang chọn là phương tiện (xe tăng, tàu, máy bay, công binh...): làm nổi bật các quân bạn có thể cõng lên
  if(sel&&!over){
    const hosts=legalSafe(turn).filter(m=>m.ride&&m.r===sel.r&&m.c===sel.c);
    const seen=new Set();
    for(const m of hosts){
      const k=m.from.r+","+m.from.c; if(seen.has(k))continue; seen.add(k);
      const d=document.createElement('div'), s2=D*1.22;
      d.className='mk ride-from';
      d.style.cssText=`left:${X(m.from.c)-s2/2}px;top:${Y(m.from.r)-s2/2}px;width:${s2}px;height:${s2}px;transform:rotateX(-${tilt}deg) translateZ(3px)`;
      stage.appendChild(d);
    }
  }

  document.getElementById('turnTxt').textContent="Lượt: "+(turn==="RED"?"Đỏ":"Xanh");
  document.getElementById('dot').className="dot "+turn;
  const w=document.getElementById('warn');
  if(warnSide){w.classList.add('on');w.textContent="TƯ LỆNH "+(warnSide==="RED"?"ĐỎ":"XANH")+" BỊ CHIẾU!";}
  else w.classList.remove('on');
  const cap=(el,arr,cls)=>{el.innerHTML=arr.map(t=>`<span class="${cls}">${T[t].c}</span>`).join("");};
  cap(document.getElementById('lostR'),lostR,'RED');
  cap(document.getElementById('lostB'),lostB,'BLUE');
  document.getElementById('log').innerHTML=log.slice().reverse().map(x=>`<div>${x}</div>`).join("");
}

// human-readable label for one candidate move, so a multi-option cell can be explained clearly
function describeMove(m){
  const host=at(m.from.r,m.from.c), stacked=host&&host.rider;
  if(m.ride){
    const carrier=at(m.r,m.c);
    if(m.pt==="CMD"&&carrier&&carrier.type==="SCH") return "Vào ẩn náu trong Sở chỉ huy";
    return "Cõng lên "+(carrier?T[carrier.type].n:"phương tiện");
  }
  if(m.off) return "Tách ra đi một mình"+(m.cap?" — ăn "+T[m.cap.type].n:"");
  if(m.trade) return "Đổi 1–1 — tiêu diệt "+T[m.cap.type].n+" (cả hai cùng mất)";
  if(m.stay) return "Bắn tại chỗ — tiêu diệt "+T[m.cap.type].n+", đứng nguyên vị trí";
  if(m.cap){
    let s="Thế chỗ — tiêu diệt "+T[m.cap.type].n;
    if(stacked) s+=" (đi cả đôi)";
    return s;
  }
  if(stacked) return "Đi cả đôi (mang theo "+T[host.rider.type].n+")";
  return "Di chuyển tới đây";
}

// when a target cell has more than one legal option (e.g. thế chỗ vs bắn tại chỗ, or đi đôi vs tách ra),
// let the player pick explicitly instead of silently guessing which one they meant.
function chooseAmong(group){
  if(group.length===1){ sel=null; moves=[]; play(group[0]); return; }
  const back=document.createElement('div');
  back.className='mb on';
  const box=document.createElement('div');
  box.className='md';
  box.style.maxWidth='320px';
  box.innerHTML='<h3 style="margin-bottom:10px">Chọn cách đi</h3>';
  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;flex-direction:column;gap:8px';
  group.forEach(m=>{
    const b=document.createElement('button');
    b.className='b p';
    b.style.textAlign='left';
    b.textContent=describeMove(m);
    b.onclick=ev=>{ev.stopPropagation();document.body.removeChild(back);sel=null;moves=[];play(m);};
    wrap.appendChild(b);
  });
  box.appendChild(wrap);
  back.appendChild(box);
  back.onclick=()=>{document.body.removeChild(back);};
  box.onclick=ev=>ev.stopPropagation();
  document.body.appendChild(back);
}

function tap(r,c){
  if(over)return;
  if(mode==="ai"&&turn!==human)return;
  if(sel){
    const group=moves.filter(x=>(x.tr??x.r)===r&&(x.tc??x.c)===c);
    if(group.length){sel=null;moves=[];chooseAmong(group);return;}
  }
  const p=at(r,c);
  if(p&&p.side===turn&&!(p.type==="SCH"&&!p.rider)){ sel={r,c}; moves=legalSafe(turn).filter(m=>m.from.r===r&&m.from.c===c); }
  else { sel=null; moves=[]; }
  draw();
}
stage.onclick=()=>{sel=null;moves=[];draw();};

/* ===== AI ===== */
const score=()=>{let s=0;for(const p of Object.values(bd)){let v=T[p.type].v+(p.hero?8:0);if(p.rider)v+=T[p.rider.type].v*.6;s+=(p.side==="RED"?1:-1)*v;}return s;};
function orderMoves(ms){
  // captures and trades first - lets alpha-beta cut off the (usually weaker) quiet moves sooner
  return ms.slice().sort((a,b)=>((b.cap?1:0)+(b.trade?1:0))-((a.cap?1:0)+(a.trade?1:0)));
}
let nodes=0,deadline=0,useDeadline=false;
const TIMEOUT={};
function ab(d,side,al,be){
  if(useDeadline&&((++nodes)&511)===0&&Date.now()>deadline)throw TIMEOUT;
  if(!cmdOf("RED"))return -1e6-d;
  if(!cmdOf("BLUE"))return 1e6+d;
  if(d<=0)return score();
  const ms=orderMoves(legal(side)); if(!ms.length)return score();
  if(side==="RED"){let v=-Infinity;for(const m of ms){const s=cloneBoard(bd);sim(m);v=Math.max(v,ab(d-1,"BLUE",al,be));bd=s;al=Math.max(al,v);if(al>=be)break;}return v;}
  let v=Infinity;for(const m of ms){const s=cloneBoard(bd);sim(m);v=Math.min(v,ab(d-1,"RED",al,be));bd=s;be=Math.min(be,v);if(al>=be)break;}return v;
}
function sim(m){
  const fk=K(m.from.r,m.from.c),mv=bd[fk]; if(!mv)return;
  if(m.ride){const c2=at(m.r,m.c);c2.rider={type:mv.type,side:mv.side,hero:mv.hero};delete bd[fk];return;}
  if(m.stay){delete bd[K(m.tr,m.tc)];return;}
  if(m.off){const h=at(m.from.r,m.from.c),rd=h.rider;delete h.rider;if(m.cap)delete bd[K(m.r,m.c)];if(!m.trade)bd[K(m.r,m.c)]={type:rd.type,side:rd.side,hero:rd.hero,r:m.r,c:m.c};return;}
  if(m.trade){delete bd[K(m.r,m.c)];delete bd[fk];return;}
  if(m.cap)delete bd[K(m.r,m.c)];
  delete bd[fk];
  const np={type:mv.type,side:mv.side,hero:mv.hero,r:m.r,c:m.c};
  if(mv.rider)np.rider=mv.rider;
  bd[K(m.r,m.c)]=np;
}
let aiTok=0;
// human-like thinking time: the machine picks one of these (seconds) depending on how complex the position is
const AI_TIMES=[0.2,0.4,0.5,0.6,0.7,0.8,0.9,1,1.1,1.2,1.3,1.4,1.5,1.6,1.7,2,2.1,2.2,2.4,2.5,2.6,2.7,2.8,3,3.1,3.2,3.5,3.6,3.7,3.8,4];
function aiThinkTime(ms,best){
  const n=AI_TIMES.length-1;
  let c=Math.min(ms.length,70)/70*0.45;                 // more options -> think longer
  if(warnSide===turn) c+=0.25;                          // own commander in check
  if(best&&(best.cap||best.trade)) c+=0.15;             // capture / trade is a bigger decision
  if(history.length<8) c*=0.45;                         // opening: play quickly
  c+=(Math.random()-0.5)*0.35;                          // human-like randomness
  let idx=Math.round(Math.max(0,Math.min(1,c))*n);
  if(Math.random()<0.08) idx=Math.min(n,idx+6);         // occasional long "deep thought"
  if(Math.random()<0.12) idx=Math.max(0,idx-8);         // occasional quick reply
  let t=AI_TIMES[idx];
  if(clockMin){                                         // time pressure: speed up
    const left=clockT[turn]/1000;
    if(left<10) t=Math.min(t,0.5);
    else if(left<30) t=Math.min(t,1.5);
    t=Math.min(t,Math.max(0.2,left/4));
  }
  return t;
}
/* ===== BOTS ===== */
const BOTS=[
  {id:'r1',name:'Binh nhì',elo:150},
  {id:'r2',name:'Binh nhất',elo:200},
  {id:'r3',name:'Thượng sĩ',elo:220},
  {id:'r4',name:'Thiếu uý',elo:300},
  {id:'r5',name:'Đại uý',elo:400},
  {id:'r6',name:'Thiếu tá',elo:420},
  {id:'r7',name:'Đại tá',elo:600},
  {id:'r8',name:'Thiếu tướng',elo:820},
  {id:'r9',name:'Đại tướng',elo:1000},
];
const ENGINE_ID='engine';
let botId='r6', engElo=1600;
// Elo -> số tầng tính trước (mục tiêu) và ngân sách thời gian suy nghĩ (ms)
const DEPTH_TBL=[[150,1],[200,1],[250,1],[300,2],[500,3],[650,3],[750,5],[1000,7],[1600,10],[2000,15],[3200,20]];
const TIME_TBL=[[150,200],[200,250],[250,300],[300,500],[500,1200],[650,2000],[750,3500],[1000,5000],[1600,7000],[2000,9000],[3200,12000]];
function interp(tbl,x){
  if(x<=tbl[0][0])return tbl[0][1];
  for(let i=1;i<tbl.length;i++){
    if(x<=tbl[i][0]){const [x0,y0]=tbl[i-1],[x1,y1]=tbl[i];return y0+(y1-y0)*(x-x0)/(x1-x0);}
  }
  return tbl[tbl.length-1][1];
}
function profile(elo){
  return {elo,
    depth:Math.round(interp(DEPTH_TBL,elo)),
    ms:interp(TIME_TBL,elo),
    blunder:0.35*Math.pow(Math.max(0,(1100-elo)/850),2)};   // bot yếu thỉnh thoảng đi bừa
}
function curBot(){
  if(botId===ENGINE_ID) return {...profile(engElo),name:'Bộ máy AI'};
  const b=BOTS.find(x=>x.id===botId)||BOTS[2];
  return {...profile(b.elo),name:b.name};
}
function setStat(t){const e=document.getElementById('aiStat'); if(e)e.textContent=t;}

function aiTurn(){
  if(mode!=="ai"||over||turn===human)return;
  const ms=legalSafe(turn); if(!ms.length)return;
  const tok=++aiTok, t0=Date.now(), P=curBot(), side=turn;
  const isRed=side==="RED", opp=isRed?"BLUE":"RED";
  const label=P.name+" (Elo "+P.elo+")";

  const done=(best,info)=>{
    // đánh chậm lại khi Elo cao: ngoài thời gian tính, còn "ngẫm" thêm theo nhịp người
    const slow=P.elo>1000?1+(P.elo-1000)/2200*1.5:1;
    let t=aiThinkTime(ms,best)*slow;
    if(clockMin){const left=clockT[side]/1000; t=Math.min(t,Math.max(0.2,left/4));}
    const wait=Math.max(0,t*1000-(Date.now()-t0));
    setStat(label+" · "+info);
    setTimeout(()=>{ if(tok!==aiTok||mode!=="ai"||over||turn===human)return; play(best); },wait);
  };

  if(ms.length===1) return done(ms[0],"nước duy nhất");
  if(Math.random()<P.blunder) return done(ms[Math.floor(Math.random()*ms.length)],"đi vội, không tính kỹ");

  // iterative deepening, cắt theo thời gian, chạy từng lát nhỏ để giao diện không bị đơ
  const budget=Math.max(150,clockMin?Math.min(P.ms,clockT[side]/8):P.ms);
  const deadlineAt=t0+budget;
  let order=orderMoves(ms.slice().sort(()=>Math.random()-.5));
  let d=1,i=0,bestMove=order[0],reached=0,iterBest=null,iterBs=isRed?-Infinity:Infinity,bs=0;
  const finish=()=>done(bestMove,"tính tới tầng "+reached+"/"+P.depth+" ("+((Date.now()-t0)/1000).toFixed(1)+"s)");

  const step=()=>{
    if(tok!==aiTok||mode!=="ai"||over||turn===human){useDeadline=false;return;}
    if(i===0) setStat(label+" đang tính tầng "+d+"/"+P.depth+"…");
    useDeadline=d>1; deadline=deadlineAt; nodes=0;
    const snap=cloneBoard(bd);
    const chunkEnd=Date.now()+40;
    try{
      while(i<order.length){
        const m=order[i];
        const s=cloneBoard(bd); sim(m);
        const v=ab(d-1,opp,isRed?iterBs:-Infinity,isRed?Infinity:iterBs);
        bd=s;
        if(isRed?v>iterBs:v<iterBs){iterBs=v;iterBest=m;}
        i++;
        if(Date.now()>chunkEnd)break;
      }
    }catch(e){
      useDeadline=false; bd=snap;
      if(e!==TIMEOUT)throw e;
      return finish();                       // hết giờ giữa chừng: dùng kết quả tầng đã tính xong
    }
    useDeadline=false;
    if(i<order.length) return setTimeout(step,0);
    bestMove=iterBest||bestMove; bs=iterBs; reached=d;
    order=[bestMove,...order.filter(x=>x!==bestMove)];
    if(d>=P.depth||Math.abs(bs)>9e5||Date.now()>=deadlineAt) return finish();
    d++; i=0; iterBest=null; iterBs=isRed?-Infinity:Infinity;
    setTimeout(step,0);
  };
  setTimeout(step,30);
}

/* ===== ui ===== */
let tt;
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>e.classList.remove('on'),2400);}
const $=id=>document.getElementById(id);
/* ===== clock ===== */
function fmtClock(ms){
  ms=Math.max(0,ms);
  if(ms<20000) return "0:"+String(Math.floor(ms/1000)).padStart(2,"0")+"."+Math.floor((ms%1000)/100);
  const t=Math.ceil(ms/1000);
  return Math.floor(t/60)+":"+String(t%60).padStart(2,"0");
}
function updClock(){
  const box=$('clocks');
  box.style.display=clockMin?'flex':'none';
  if(!clockMin)return;
  for(const [side,id] of [["RED","ckR"],["BLUE","ckB"]]){
    const e=$(id);
    e.querySelector('b').textContent=fmtClock(clockT[side]);
    e.classList.toggle('act',!over&&turn===side);
    e.classList.toggle('low',clockT[side]<10000);
  }
}
setInterval(()=>{
  const now=Date.now(), dt=now-lastTick; lastTick=now;
  if(!clockMin||over||!history.length){updClock();return;}
  clockT[turn]-=dt;
  if(clockT[turn]<=0){
    clockT[turn]=0; updClock();
    const loser=turn, name=loser==="RED"?"Đỏ":"Xanh";
    sel=null;moves=[];
    return finish(loser==="RED"?"BLUE":"RED","Bên "+name+" đã hết giờ.");
  }
  updClock();
},100);
function setClock(min){
  clockMin=min;
  document.querySelectorAll('.tc,#tcOff').forEach(b=>b.classList.toggle('on',+b.dataset.min===min));
  reset();
}
document.querySelectorAll('.tc,#tcOff').forEach(b=>b.onclick=()=>setClock(+b.dataset.min));

function reset(){aiTok++;useDeadline=false;setStat('');setup();draw();if(mode==="ai"&&human==="BLUE")setTimeout(aiTurn,300);}
const confirmNew=$('confirmNew');
$('bNew').onclick=()=>confirmNew.classList.add('on');
$('newNo').onclick=()=>confirmNew.classList.remove('on');
$('newYes').onclick=()=>{confirmNew.classList.remove('on');reset();};
confirmNew.onclick=e=>{if(e.target===confirmNew)confirmNew.classList.remove('on');};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){confirmNew.classList.remove('on');closeInfo();}});
$('ovB').onclick=()=>{$('over').classList.remove('on');reset();};
$('bFlat').onclick=()=>{stage.classList.toggle('flat');draw();};
/* ===== điều hướng: trang chủ (bàn cờ) / trang luật chơi riêng (#luat-choi) ===== */
function route(){
  const h=location.hash, rules=h==='#luat-choi', info=h==='#thong-tin', fun=h==='#giai-tri';
  $('pageHome').style.display=(rules||info||fun)?'none':'';
  $('pageRules').style.display=rules?'':'none';
  $('pageInfo').style.display=info?'':'none';
  $('pageFun').style.display=fun?'':'none';
  closeInfo();
  window.scrollTo(0,0);
  if(!rules&&!info&&!fun)draw();
}
$('bRules').onclick=()=>{location.hash='#luat-choi';};
$('bInfo').onclick=()=>{location.hash='#thong-tin';};
$('bFun').onclick=()=>{location.hash='#giai-tri';};
$('bInfoRules').onclick=()=>{location.hash='#luat-choi';};
document.querySelectorAll('.goHome').forEach(b=>b.onclick=()=>{location.hash='#trang-chu';});
/* bấm vào ô nội dung ở trang thông tin: mở rộng ô đó lên to */
const infoModal=$('infoModal');
function openInfo(card){
  $('infoModalT').textContent=card.querySelector('h2').textContent;
  $('infoModalB').innerHTML=card.querySelector('.infobody').innerHTML;
  infoModal.classList.add('on');
}
const closeInfo=()=>{infoModal.classList.remove('on');infoModal.querySelectorAll('video').forEach(v=>v.pause());};
document.querySelectorAll('.infocard').forEach(card=>{
  card.tabIndex=0; card.setAttribute('role','button');
  card.onclick=e=>{if(e.target.closest('a'))return; openInfo(card);};
  card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openInfo(card);}};
});
$('infoModalX').onclick=closeInfo;
infoModal.onclick=e=>{if(e.target===infoModal)closeInfo();};
document.querySelectorAll('.infonav a').forEach(a=>a.onclick=e=>{e.preventDefault();const t=document.getElementById(a.dataset.go);if(t)t.scrollIntoView({behavior:'smooth',block:'start'});});
window.addEventListener('hashchange',route);
$('bUndo').onclick=()=>{
  if(!history.length)return;
  let n=(mode==="ai"&&history.length>1)?2:1;
  let s; while(n-->0&&history.length)s=history.pop();
  bd=s.bd;turn=s.turn;log=s.log;lostR=s.lostR;lostB=s.lostB;last=s.last;
  aiTok++;over=false;sel=null;moves=[];warnSide=null;$('over').classList.remove('on');lastTick=Date.now();draw();updClock();
};
$('mLocal').onclick=()=>{mode="local";$('mLocal').classList.add('on');$('mAI').classList.remove('on');
  $('aiBox').style.display='none';$('modeTxt').textContent="2 người · 1 máy";reset();};
$('mAI').onclick=()=>{mode="ai";$('mAI').classList.add('on');$('mLocal').classList.remove('on');
  $('aiBox').style.display='flex';updMode();reset();};
function updMode(){
  if(mode==="ai"){const P=curBot(); $('modeTxt').textContent="Đấu với "+P.name+" · Elo "+P.elo;}
  else $('modeTxt').textContent="2 người · 1 máy";
}
function renderBot(){
  const P=curBot(), eng=botId===ENGINE_ID;
  $('eloBox').style.display=eng?'block':'none';
  $('eloRange').value=engElo;
  $('eloTxt').textContent="Elo "+P.elo+" · tối đa ~"+Math.round(P.ms/100)/10+"s/nước";
  document.querySelectorAll('.elopre').forEach(b=>b.classList.toggle('on',+b.dataset.e===engElo));
  $('botCard').innerHTML="<b>"+P.name+"</b><span>Elo "+P.elo+"</span>";
  updMode();
}
$('bot').innerHTML=BOTS.map(b=>{const p=profile(b.elo);return `<option value="${b.id}">${b.name} — Elo ${b.elo}</option>`;}).join('')
  +`<option value="${ENGINE_ID}">Bộ máy AI — tuỳ chỉnh Elo 250–3200</option>`;
$('bot').value=botId;
$('bot').onchange=e=>{botId=e.target.value;renderBot();};
$('eloRange').oninput=e=>{engElo=+e.target.value;renderBot();};
document.querySelectorAll('.elopre').forEach(b=>b.onclick=()=>{engElo=+b.dataset.e;renderBot();});

$('sRed').onclick=()=>{human="RED";$('sRed').classList.add('on');$('sBlue').classList.remove('on');reset();};
$('sBlue').onclick=()=>{human="BLUE";$('sBlue').classList.add('on');$('sRed').classList.remove('on');reset();};

$('leg').innerHTML=Object.entries(T).map(([k,v])=>`<div><i>${ICON[k]}</i>${v.n}</div>`).join("");
$('ruleList').innerHTML=[
 ["CMD","đi ngang/dọc bao xa cũng được (không chéo), miễn không vướng vật cản; ăn quân chỉ trong phạm vi 1 đoạn. Có thể bước vào Sở chỉ huy của mình để ẩn náu (đứng lên trên), và rời đi bất cứ lúc nào."],
 ["SCH","đứng yên tuyệt đối, không tự đi/ăn quân, chỉ là vật cản. Chỉ Công binh, Xe tăng, Pháo binh, Không quân phá được. Nếu Tư lệnh đang ẩn trong đó mà bị phá, Tư lệnh bị diệt."],
 ["INF","đi/ăn ngang dọc 1 đoạn (tiến, lùi, sang ngang). Đứng tại chỗ bắn tàu chiến cách 1 đoạn (kể cả chéo) nếu tàu ở dưới nước. Bộ binh anh hùng ★ đi/ăn thêm cả đường chéo và xa thêm 1 đoạn."],
 ["ENG","như Bộ binh; đặc biệt chỉ Công binh mới cõng được khí tài nặng (Pháo binh, Cao xạ, Tên lửa) để vượt đoạn sông sâu. Công binh không cõng Tư lệnh, Bộ binh hay Dân quân."],
 ["AA","như Bộ binh; tạo vùng cấm bay bán kính 1 quanh nó. Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["MIL","như Bộ binh nhưng đi/ăn/bắn tàu được cả 8 hướng kể cả chéo 45°."],
 ["TANK","đi/ăn ngang dọc 1–2 đoạn; đứng tại chỗ bắn tàu chiến trong tầm đó, không cần thế chỗ. Xe tăng anh hùng ★ đi/ăn/bắn thêm cả đường chéo."],
 ["SAM","đi/ăn quân mặt đất và trên không trong vành đai 2 đoạn (trục) / 1 đoạn (chéo). Không thể nhắm vào tàu chiến. Tạo vùng cấm bay lớn. Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["ART","đi và ăn thẳng (ngang/dọc) 1–2 đoạn; đi và ăn chéo 45° 1 đoạn. Ăn quân bằng cách thế chỗ như quân thường. Đứng tại chỗ bắn được tàu chiến trong đúng tầm đó (thẳng 1–2, chéo 1). Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["AIR","bay 8 hướng 1–4 đoạn, vượt qua mọi vật cản. Ăn quân được chọn thế chỗ hoặc bay về chỗ cũ nếu thế chỗ không an toàn (riêng ăn máy bay địch bắt buộc thế chỗ). Không được hạ cánh xuống biển. Bay vào vùng cấm phòng không: nếu có mục tiêu ở đó thì cả hai cùng bị tiêu diệt (1 đổi 1); nếu ô trống thì coi như bị bắn rơi (không đi được). Có thể hạ cánh đậu trên Tàu chiến của mình. Không quân anh hùng ★ trở thành máy bay tàng hình: miễn nhiễm mọi hoả lực phòng không."],
 ["NAVY","tổ hợp 3 trong 1. Tự thân di chuyển thẳng/ngang/chéo tối đa 4 đoạn, bị chặn bởi vật cản đầu tiên trên đường đi (không bay qua được), chỉ trong dải biển và đoạn sông sâu tới chỗ ngầm gần nhất. Tên lửa hải đối hải: ăn tàu địch trong tầm đó, phải thế chỗ nếu đi thẳng tới được, nếu không (bị chắn) thì bắn tại chỗ. Pháo hạm: bắn mục tiêu trên bộ trong tầm 1–3 đoạn, luôn bắn tại chỗ (không thế chỗ). Cao xạ trên tàu tạo vùng cấm bay bán kính 1. Có thể chở Tư lệnh/Bộ binh/Dân quân hoặc làm tàu sân bay chở Không quân."],
].map(([k,d])=>`<li><b>${T[k].n}</b>: ${d}</li>`).join("");

(function buildSetupInfo(){
  const grid={};
  for(const [t,c,r] of RED_SETUP){ grid[r+","+c]=["RED",t]; grid[(ROWS-1-r)+","+c]=["BLUE",t]; }
  let h='<table class="smap"><tr><th></th>';
  for(let c=0;c<COLS;c++) h+='<th>'+c+'</th>';
  h+='</tr>';
  for(let r=ROWS-1;r>=0;r--){
    h+='<tr'+((r===RIVER_LO||r===RIVER_HI)?' class="rv"':'')+'><th>'+r+'</th>';
    for(let c=0;c<COLS;c++){
      const g=grid[r+","+c];
      const cls=(c<=SEA_MAX?'sea ':'')+(c===SHORE?'shore ':'');
      h+='<td class="'+cls+'">'+(g?'<span class="'+g[0]+'" title="'+T[g[1]].n+'">'+T[g[1]].c+'</span>':((r===RIVER_LO||r===RIVER_HI)&&FORDS.includes(c)?'<i>ngầm</i>':''))+'</td>';
    }
    h+='</tr>';
  }
  h+='</table>';
  $('setupMap').innerHTML=h;
  const byRow={};
  for(const [t,c,r] of RED_SETUP)(byRow[r]=byRow[r]||[]).push([c,t]);
  let l='';
  for(const r of Object.keys(byRow).map(Number).sort((a,b)=>a-b)){
    byRow[r].sort((a,b)=>a[0]-b[0]);
    l+='<li><b>Hàng '+r+'</b> (Xanh: hàng '+(ROWS-1-r)+'): '+byRow[r].map(([c,t])=>T[t].n+' (cột '+c+')').join(', ')+'</li>';
  }
  $('setupList').innerHTML=l;
})();
/* ===== settings: board zoom, piece size, background colour ===== */
const BG_DEFAULT='#131a15';
const BG_CHOICES=['#131a15','#000000','#1c2430','#2b1d14','#3a1f2b','#2f4a3a','#8a8f98','#e8e4d8'];
const PAGE_DEFAULT='#19261f';
const PAGE_CHOICES=['#19261f','#000000','#0f1720','#2a1a10','#2d1620','#1f3a2c','#3b3f4a','#4a3f2a'];
const PANEL_DEFAULT='#1d3124';
const PANEL_CHOICES=['#1d3124','#000000','#1c2430','#33210f','#3a1f2b','#2f4a3a','#3b3f4a','#4a3f2a'];
const mixWhite=(hex,t)=>'#'+[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*(1-t)+255*t).toString(16).padStart(2,'0')).join('');
const SET={board:100,piece:100,bg:BG_DEFAULT,page:PAGE_DEFAULT,panel:PANEL_DEFAULT};
try{const o=JSON.parse(localStorage.getItem('ctl-settings')||'null'); if(o){
  if(+o.board>=60&&+o.board<=180)SET.board=+o.board;
  if(+o.piece>=60&&+o.piece<=150)SET.piece=+o.piece;
  if(/^#[0-9a-f]{6}$/i.test(o.bg))SET.bg=o.bg;
  if(/^#[0-9a-f]{6}$/i.test(o.page))SET.page=o.page;
  if(/^#[0-9a-f]{6}$/i.test(o.panel))SET.panel=o.panel;
}}catch(e){}
function applySettings(redraw){
  SP=Math.round(SP0*SET.board/100);
  pieceScale=SET.piece/100;
  document.querySelector('.boardbox').style.background=SET.bg;
  document.querySelector('.scene').style.perspective=Math.round(1400*SET.board/100)+'px';
  $('setBoard').value=SET.board; $('vBoard').textContent=SET.board+'%';
  $('setPiece').value=SET.piece; $('vPiece').textContent=SET.piece+'%';
  document.documentElement.style.setProperty('--bg',SET.page);
  document.documentElement.style.setProperty('--panel',SET.panel);
  document.documentElement.style.setProperty('--panel2',SET.panel.toLowerCase()===PANEL_DEFAULT?'#202b23':mixWhite(SET.panel,.07));
  $('setPanel').value=SET.panel;
  [...$('swatchesPanel').children].forEach(b=>b.classList.toggle('on',b.dataset.c.toLowerCase()===SET.panel.toLowerCase()));
  $('setPage').value=SET.page;
  [...$('swatchesPage').children].forEach(b=>b.classList.toggle('on',b.dataset.c.toLowerCase()===SET.page.toLowerCase()));
  $('setBg').value=SET.bg;
  [...$('swatches').children].forEach(b=>b.classList.toggle('on',b.dataset.c.toLowerCase()===SET.bg.toLowerCase()));
  document.documentElement.dataset.page=SET.page.toLowerCase();
  window.dispatchEvent(new Event('ctl-theme'));
  try{localStorage.setItem('ctl-settings',JSON.stringify(SET));}catch(e){}
  if(redraw)draw();
}
$('swatches').innerHTML=BG_CHOICES.map(c=>`<button type="button" data-c="${c}" title="${c}" style="background:${c}"></button>`).join('');
$('swatches').onclick=e=>{const b=e.target.closest('button'); if(!b)return; SET.bg=b.dataset.c; applySettings(false);};
$('swatchesPage').innerHTML=PAGE_CHOICES.map(c=>`<button type="button" data-c="${c}" title="${c}" style="background:${c}"></button>`).join('');
$('swatchesPage').onclick=e=>{const b=e.target.closest('button'); if(!b)return; SET.page=b.dataset.c; applySettings(false);};
$('setPage').oninput=e=>{SET.page=e.target.value; applySettings(false);};
$('swatchesPanel').innerHTML=PANEL_CHOICES.map(c=>`<button type="button" data-c="${c}" title="${c}" style="background:${c}"></button>`).join('');
$('swatchesPanel').onclick=e=>{const b=e.target.closest('button'); if(!b)return; SET.panel=b.dataset.c; applySettings(false);};
$('setPanel').oninput=e=>{SET.panel=e.target.value; applySettings(false);};
$('setBg').oninput=e=>{SET.bg=e.target.value; applySettings(false);};
const clampTo=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
$('setBoard').oninput=e=>{SET.board=+e.target.value; applySettings(true);};
$('setPiece').oninput=e=>{SET.piece=+e.target.value; applySettings(true);};
$('boardMinus').onclick=()=>{SET.board=clampTo(SET.board-10,60,180); applySettings(true);};
$('boardPlus').onclick=()=>{SET.board=clampTo(SET.board+10,60,180); applySettings(true);};
$('pieceMinus').onclick=()=>{SET.piece=clampTo(SET.piece-10,60,150); applySettings(true);};
$('piecePlus').onclick=()=>{SET.piece=clampTo(SET.piece+10,60,150); applySettings(true);};
$('setReset').onclick=()=>{SET.board=100;SET.piece=100;SET.bg=BG_DEFAULT;SET.page=PAGE_DEFAULT;SET.panel=PANEL_DEFAULT; applySettings(true);};
$('bSet').onclick=()=>$('settings').classList.add('on');
$('bSetClose').onclick=()=>$('settings').classList.remove('on');
applySettings(false);
renderBot();
setup();draw();
route();
})();

/* ===== Cờ caro (trang Giải trí) ===== */
(function(){
/*LOGIC-START*/
const CARO_WIN={3:3,4:4,5:4};            // số quân liên tiếp cần để thắng theo cỡ bàn
const caroCache={};
function caroLines(n){
  if(caroCache[n])return caroCache[n];
  const k=CARO_WIN[n],L=[];
  for(let r=0;r<n;r++)for(let c=0;c<n;c++)for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]){
    const er=r+dr*(k-1),ec=c+dc*(k-1);
    if(er<0||er>=n||ec<0||ec>=n)continue;
    const w=[];for(let i=0;i<k;i++)w.push((r+dr*i)*n+c+dc*i);
    L.push(w);
  }
  const byCell=Array.from({length:n*n},()=>[]);
  L.forEach(w=>w.forEach(i=>byCell[i].push(w)));
  return caroCache[n]={L,byCell};
}
function caroWinner(b,n){            // trả về {p,line} hoặc null
  for(const w of caroLines(n).L){
    const p=b[w[0]];
    if(p&&w.every(i=>b[i]===p))return {p,line:w};
  }
  return null;
}
function caroEmpty(b){const e=[];for(let i=0;i<b.length;i++)if(!b[i])e.push(i);return e;}
function caroWinsAt(b,n,i,p){        // đặt p vào ô i có thắng ngay không
  for(const w of caroLines(n).byCell[i]){
    if(w.every(j=>j===i||b[j]===p))return true;
  }
  return false;
}
function caroCellScore(b,n,i,me){    // điểm tấn công + phòng thủ của một ô trống
  const opp=3-me;let s=0;
  const pw=[0,2,12,120,3000,50000];
  for(const w of caroLines(n).byCell[i]){
    let a=0,o=0;
    for(const j of w){if(b[j]===me)a++;else if(b[j]===opp)o++;}
    if(a&&o)continue;
    if(!o)s+=pw[a+1];else s+=pw[o+1]*0.9;
  }
  const m=(n-1)/2;s+=2-(Math.abs(i%n-m)+Math.abs(Math.floor(i/n)-m))*0.3;
  return s;
}
function caroEval(b,n,me){
  const opp=3-me;let s=0;const pw=[0,1,10,100,1000,10000];
  for(const w of caroLines(n).L){
    let a=0,o=0;
    for(const j of w){if(b[j]===me)a++;else if(b[j]===opp)o++;}
    if(a&&o)continue;
    if(!o&&a)s+=pw[a];else if(!a&&o)s-=pw[o];
  }
  return s;
}
function caroCandidates(b,n){
  const e=caroEmpty(b);
  if(e.length===b.length)return e;
  if(n===3)return e;
  const near=e.filter(i=>{
    const r=Math.floor(i/n),c=i%n;
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      const rr=r+dr,cc=c+dc;
      if(rr>=0&&rr<n&&cc>=0&&cc<n&&b[rr*n+cc])return true;
    }
    return false;
  });
  return near.length?near:e;
}
function caroSearch(b,n,turn,me,depth,alpha,beta){
  const w=caroWinner(b,n);
  if(w)return w.p===me?100000+depth:-100000-depth;
  const cand=caroCandidates(b,n);
  if(!cand.length)return 0;
  if(depth===0)return caroEval(b,n,me);
  cand.sort((x,y)=>caroCellScore(b,n,y,turn)-caroCellScore(b,n,x,turn));
  if(turn===me){
    let best=-Infinity;
    for(const i of cand){
      b[i]=turn;const v=caroSearch(b,n,3-turn,me,depth-1,alpha,beta);b[i]=0;
      if(v>best)best=v;if(best>alpha)alpha=best;if(alpha>=beta)break;
    }
    return best;
  }else{
    let best=Infinity;
    for(const i of cand){
      b[i]=turn;const v=caroSearch(b,n,3-turn,me,depth-1,alpha,beta);b[i]=0;
      if(v<best)best=v;if(best<beta)beta=best;if(alpha>=beta)break;
    }
    return best;
  }
}
function caroPickRandom(a){return a[Math.floor(Math.random()*a.length)];}
function caroBestHeur(b,n,me){
  const e=caroEmpty(b);let best=-Infinity,pool=[];
  for(const i of e){
    const s=caroCellScore(b,n,i,me);
    if(s>best+1e-9){best=s;pool=[i];}else if(Math.abs(s-best)<1e-9)pool.push(i);
  }
  return caroPickRandom(pool);
}
function caroAIMove(b,n,me,level){   // level: easy | mid | hard
  const e=caroEmpty(b);
  if(level==='easy'){
    // dễ: phần lớn đi ngẫu nhiên, chỉ thỉnh thoảng mới biết thắng/chặn
    if(Math.random()<0.3){
      for(const i of e)if(caroWinsAt(b,n,i,me))return i;
      for(const i of e)if(caroWinsAt(b,n,i,3-me))return i;
    }
    return caroPickRandom(e);
  }
  for(const i of e)if(caroWinsAt(b,n,i,me))return i;
  for(const i of e)if(caroWinsAt(b,n,i,3-me))return i;
  if(level==='mid')return caroBestHeur(b,n,me);
  // khó: minimax cắt tỉa alpha-beta
  if(e.length===b.length){
    const m=Math.floor(n/2);
    return n%2?m*n+m:caroPickRandom([(m-1)*n+m-1,(m-1)*n+m,m*n+m-1,m*n+m]);
  }
  const depth={3:9,4:6,5:4}[n];
  const cand=caroCandidates(b,n);
  cand.sort((x,y)=>caroCellScore(b,n,y,me)-caroCellScore(b,n,x,me));
  let best=-Infinity,pool=[];
  for(const i of cand){
    b[i]=me;const v=caroSearch(b,n,3-me,me,depth-1,-Infinity,Infinity);b[i]=0;
    if(v>best){best=v;pool=[i];}else if(v===best)pool.push(i);
  }
  return caroPickRandom(pool);
}
/*LOGIC-END*/

if(typeof document==='undefined'||!document.getElementById('crBoard'))return;
const $=id=>document.getElementById(id);
let n=3,mode='local',level='mid',human=1,board,turn,over,busy=false,timer=null;
const score={1:0,2:0,d:0};
const XS='<svg viewBox="0 0 100 100"><path d="M24 24L76 76M76 24L24 76" stroke="#de3a2b" stroke-width="13" stroke-linecap="round" fill="none"/></svg>';
const OS='<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="28" stroke="#2c8fd6" stroke-width="12" fill="none"/></svg>';

function setOn(sel,btn){document.querySelectorAll(sel).forEach(b=>b.classList.toggle('on',b===btn));}
function newGame(){
  clearTimeout(timer);busy=false;
  board=new Array(n*n).fill(0);turn=1;over=false;
  build();status();
  if(mode==='ai'&&human===2)aiTurn();
}
function build(){
  const el=$('crBoard');
  el.style.gridTemplateColumns='repeat('+n+',1fr)';
  el.innerHTML='';
  for(let i=0;i<n*n;i++){
    const c=document.createElement('button');
    c.type='button';c.className='cr-cell';c.dataset.i=i;
    c.setAttribute('aria-label','Ô '+(Math.floor(i/n)+1)+','+(i%n+1));
    c.onclick=()=>play(i);
    el.appendChild(c);
  }
}
function paint(win){
  const cells=$('crBoard').children;
  for(let i=0;i<cells.length;i++){
    cells[i].innerHTML=board[i]===1?XS:board[i]===2?OS:'';
    cells[i].classList.toggle('filled',!!board[i]);
    cells[i].classList.toggle('win',!!win&&win.line.includes(i));
  }
}
function name(p){
  if(mode==='ai')return p===human?'Bạn':'Máy';
  return p===1?'X':'O';
}
function status(msg){
  $('crTurn').textContent=msg||('Lượt: '+(turn===1?'X':'O')+(mode==='ai'?' ('+name(turn)+')':''));
  $('crS1').textContent=score[1];$('crS2').textContent=score[2];$('crSd').textContent=score.d;
  $('crL1').textContent=mode==='ai'?(human===1?'Bạn (X)':'Máy (X)'):'X';
  $('crL2').textContent=mode==='ai'?(human===2?'Bạn (O)':'Máy (O)'):'O';
}
function play(i){
  if(over||busy||board[i])return;
  if(mode==='ai'&&turn!==human)return;
  move(i);
}
function move(i){
  board[i]=turn;
  const w=caroWinner(board,n);
  if(w){
    over=true;score[w.p]++;paint(w);
    status(mode==='ai'?(w.p===human?'Bạn thắng!':'Máy thắng!'):('X O'[w.p===1?0:2]+' thắng!'));
    return;
  }
  if(!caroEmpty(board).length){over=true;score.d++;paint();status('Hòa!');return;}
  turn=3-turn;paint();status();
  if(mode==='ai'&&turn!==human)aiTurn();
}
function aiTurn(){
  busy=true;paint();status('Máy đang nghĩ...');
  timer=setTimeout(()=>{
    busy=false;
    if(over)return;
    move(caroAIMove(board.slice(),n,turn,level));
  },380);
}
function sync(){
  $('crAiRow').style.display=mode==='ai'?'':'none';
  $('crSideRow').style.display=mode==='ai'?'':'none';
  $('crRule').textContent='Luật: '+n+'×'+n+' ô, nối '+CARO_WIN[n]+' quân liên tiếp (ngang, dọc hoặc chéo) để thắng. X đi trước.';
}
document.querySelectorAll('.cr-mode').forEach(b=>b.onclick=()=>{mode=b.dataset.m;setOn('.cr-mode',b);sync();score[1]=score[2]=score.d=0;newGame();});
document.querySelectorAll('.cr-lv').forEach(b=>b.onclick=()=>{level=b.dataset.l;setOn('.cr-lv',b);newGame();});
document.querySelectorAll('.cr-side').forEach(b=>b.onclick=()=>{human=+b.dataset.s;setOn('.cr-side',b);score[1]=score[2]=score.d=0;newGame();});
document.querySelectorAll('.cr-size').forEach(b=>b.onclick=()=>{n=+b.dataset.n;setOn('.cr-size',b);sync();newGame();});
$('crNew').onclick=newGame;
$('crReset').onclick=()=>{score[1]=score[2]=score.d=0;newGame();};
sync();newGame();
})();

/* ===== trang Giải trí: bấm ô nào thì ô đó mở to, các ô còn lại thu nhỏ bên phải ===== */
(function(){
const gz=document.getElementById('gz');if(!gz)return;
const tiles=[...gz.querySelectorAll('.gz-tile')],panels=[...gz.querySelectorAll('.gz-panel')];
tiles.forEach(t=>t.onclick=()=>{
  const was=t.classList.contains('on');
  tiles.forEach(x=>x.classList.remove('on'));
  panels.forEach(p=>p.classList.remove('on'));
  if(was){gz.classList.remove('open');return;}
  t.classList.add('on');
  panels.filter(p=>p.dataset.g===t.dataset.g).forEach(p=>p.classList.add('on'));
  gz.classList.add('open');
});
})();

/* ===== Sudoku 4x4 (trang Giải trí) ===== */
(function(){
/*SD-LOGIC-START*/
const SD_BLOCK=i=>Math.floor(Math.floor(i/4)/2)*2+Math.floor((i%4)/2);
function sdPeers(i){
  const r=Math.floor(i/4),c=i%4,b=SD_BLOCK(i),p=[];
  for(let j=0;j<16;j++)if(j!==i&&(Math.floor(j/4)===r||j%4===c||SD_BLOCK(j)===b))p.push(j);
  return p;
}
const SD_PEERS=Array.from({length:16},(_,i)=>sdPeers(i));
function sdOk(g,i,v){for(const j of SD_PEERS[i])if(g[j]===v)return false;return true;}
function sdShuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function sdSolved(){            // tạo ngẫu nhiên một bảng đã giải xong hợp lệ
  const g=new Array(16).fill(0);
  (function fill(i){
    if(i===16)return true;
    for(const v of sdShuffle([1,2,3,4])){
      if(sdOk(g,i,v)){g[i]=v;if(fill(i+1))return true;g[i]=0;}
    }
    return false;
  })(0);
  return g;
}
function sdCount(g,limit){      // đếm số lời giải (dừng khi đạt limit)
  let n=0;
  (function go(){
    if(n>=limit)return;
    let k=-1;
    for(let i=0;i<16;i++)if(!g[i]){k=i;break;}
    if(k<0){n++;return;}
    for(let v=1;v<=4;v++)if(sdOk(g,k,v)){g[k]=v;go();g[k]=0;}
  })();
  return n;
}
function sdPuzzle(target){      // bỏ bớt số nhưng vẫn chỉ có đúng 1 lời giải
  const sol=sdSolved(),p=sol.slice();
  let given=16;
  for(const i of sdShuffle([...Array(16).keys()])){
    if(given<=target)break;
    const keep=p[i];p[i]=0;
    if(sdCount(p.slice(),2)===1)given--;else p[i]=keep;
  }
  return {puzzle:p,solution:sol};
}
function sdConflicts(g){        // các ô đang trùng số với ô cùng hàng/cột/khối
  const bad=new Set();
  for(let i=0;i<16;i++)if(g[i])for(const j of SD_PEERS[i])if(g[j]===g[i]){bad.add(i);bad.add(j);}
  return bad;
}
/*SD-LOGIC-END*/

if(typeof document==='undefined'||!document.getElementById('sdBoard'))return;
const $=id=>document.getElementById(id);
const TARGET=7;
let puzzle,solution,cur,sel=-1,start=0,done=false,timerId=null,best=null;
const cells=new Array(16);

function fmt(ms){const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
function build(){
  const el=$('sdBoard');el.innerHTML='';
  for(let b=0;b<4;b++){
    const blk=document.createElement('div');blk.className='sd-block';
    const br=Math.floor(b/2)*2,bc=(b%2)*2;
    for(let k=0;k<4;k++){
      const i=(br+Math.floor(k/2))*4+bc+(k%2);
      const c=document.createElement('button');
      c.type='button';c.className='sd-cell';
      c.setAttribute('aria-label','Hàng '+(Math.floor(i/4)+1)+', cột '+(i%4+1));
      c.onclick=()=>select(i);
      cells[i]=c;blk.appendChild(c);
    }
    el.appendChild(blk);
  }
}
function paint(){
  const bad=sdConflicts(cur);
  const rel=sel>=0?new Set(SD_PEERS[sel]):new Set();
  for(let i=0;i<16;i++){
    const c=cells[i];
    c.textContent=cur[i]||'';
    c.classList.toggle('given',!!puzzle[i]);
    c.classList.toggle('sel',i===sel);
    c.classList.toggle('rel',rel.has(i));
    c.classList.toggle('bad',bad.has(i));
  }
}
function select(i){sel=i;paint();}
function setVal(v){
  if(done||sel<0||puzzle[sel])return;
  cur[sel]=v;paint();check();
}
function check(){
  if(cur.some(x=>!x)||sdConflicts(cur).size)return;
  done=true;clearInterval(timerId);
  const t=Date.now()-start;
  if(best===null||t<best)best=t;
  $('sdMsg').textContent='Hoàn thành! Thời gian: '+fmt(t);
  $('sdMsg').classList.add('ok');
  $('sdBest').textContent=fmt(best);
  $('sdTime').textContent=fmt(t);
}
function tick(){$('sdTime').textContent=fmt(Date.now()-start);}
function begin(){
  done=false;sel=-1;
  clearInterval(timerId);start=Date.now();tick();
  timerId=setInterval(tick,500);
  $('sdMsg').textContent='Điền số 1–4 vào các ô trống.';
  $('sdMsg').classList.remove('ok');
  paint();
}
function newGame(){
  const r=sdPuzzle(TARGET);
  puzzle=r.puzzle;solution=r.solution;cur=puzzle.slice();
  begin();
}
function retry(){cur=puzzle.slice();begin();}
document.querySelectorAll('.sd-num').forEach(b=>b.onclick=()=>setVal(+b.dataset.v));
$('sdNew').onclick=newGame;
$('sdRetry').onclick=retry;
document.addEventListener('keydown',e=>{
  const pg=$('pageFun'),pn=document.querySelector('.gz-panel[data-g="sudoku"]');
  if(!pg||pg.style.display==='none'||!pn||!pn.classList.contains('on'))return;
  if(e.key>='1'&&e.key<='4'){setVal(+e.key);return;}
  if(e.key==='Backspace'||e.key==='Delete'||e.key==='0'){setVal(0);return;}
  const mv={ArrowLeft:-1,ArrowRight:1,ArrowUp:-4,ArrowDown:4}[e.key];
  if(mv){
    e.preventDefault();
    let i=sel<0?0:sel;
    const r=Math.floor(i/4),c=i%4;
    if(e.key==='ArrowLeft'&&c>0)i--;else if(e.key==='ArrowRight'&&c<3)i++;
    else if(e.key==='ArrowUp'&&r>0)i-=4;else if(e.key==='ArrowDown'&&r<3)i+=4;
    select(i);
  }
});
build();newGame();
})();
/* ===== Ai là triệu phú (trang Giải trí) ===== */
(function(){
const root=document.getElementById('qz');if(!root)return;
const L='ABCD';
const Q=[
 {s:'Vật lí',q:'Một vật dao động điều hòa có quỹ đạo là một đoạn thẳng dài 10 cm. Biên độ dao động của vật là bao nhiêu?',o:['5 cm','10 cm','20 cm','2,5 cm'],a:0,e:'A = chiều dài quỹ đạo / 2 = 10 / 2 = 5 cm.'},
 {s:'Vật lí',q:'Đồ thị của dao động điều hòa có dạng là đường nào sau đây?',o:['Đường thẳng.','Đường hình sin.','Đường parabol.','Đường tròn.'],a:1,e:'Li độ là hàm sin (hoặc cosin) của thời gian nên đồ thị có dạng hình sin.'},
 {s:'Vật lí',q:'Một vật nhỏ dao động điều hòa theo một quỹ đạo có chiều dài 10 cm. Biên độ của dao động là',o:['10 cm.','5 cm.','2,5 cm.','1,125 cm.'],a:1,e:'A = L / 2 = 10 / 2 = 5 cm.'},
 {s:'Vật lí',q:'Chọn phát biểu sai trong các phương án sau:',o:['Dao động điều hòa thì tuần hoàn.','Dao động là chuyển động qua lại quanh một vị trí đặc biệt gọi là vị trí cân bằng.','Dao động điều hòa là dao động trong đó li độ của vật là một hàm tan (hay cotan) của thời gian.','Dao động tuần hoàn là dao động mà trạng thái của vật được lặp lại như cũ, theo hướng cũ sau những khoảng thời gian bằng nhau xác định.'],a:2,e:'A, B, D đúng. C sai vì dao động điều hòa có li độ là hàm cosin (hay sin) của thời gian.'},
 {s:'Vật lí',q:'Một chất điểm dao động điều hòa với biên độ 5 cm và thời gian thực hiện được 1 dao động là 1/3 s. Tính tốc độ trung bình trong một dao động (đơn vị m/s, lấy đến 1 chữ số sau dấu phẩy thập phân).',num:0.6,unit:'m/s',ans:'0,6',e:'v = S / t = 4A / T = 4 × 5 / (1/3) = 60 cm/s = 0,6 m/s.'},
 {s:'Tiếng Anh',q:'Mark the letter A, B, C, or D to indicate the best arrangement of utterances or sentences to make a meaningful exchange or text.\n\na. Tom: Good morning, Alice! Did you sleep well?\nb. Alice: Yes, thank you. How about you?\nc. Alice: Good morning, Tom!',o:['a – b – c','c – b – a','b – c – a','c – a – b'],a:3,e:'Alice chào trước (c), Tom chào lại và hỏi thăm (a), Alice trả lời rồi hỏi lại (b).'},
 {s:'Tiếng Anh',q:'Mark the letter A, B, C, or D to indicate the best arrangement of utterances or sentences to make a meaningful exchange or text.\n\na. Jack: Morning, Emily! It was good, thanks. I went hiking with some friends. How about you?\nb. Emily: Good morning, Jack! How was your weekend?\nc. Emily: Sounds fun! I had a relaxing weekend at home. Hey, have you seen the agenda?\nd. Emily: Alright, thanks. Oh, and don’t forget, we have that client presentation at 2 PM.\ne. Jack: Not yet. Let me check my email.',o:['a – b – c – d – e','c – b – a – e – d','b – a – c – e – d','c – a – b – d – e'],a:2,e:'Emily chào và hỏi về cuối tuần (b), Jack trả lời (a), Emily đáp lại và hỏi về lịch (c), Jack chưa xem (e), Emily nhắc buổi thuyết trình (d).'},
 {s:'Tiếng Anh',q:'Mark the letter A, B, C, or D to indicate the best arrangement of utterances or sentences to make a meaningful exchange or text.\n\na. Furthermore, highly educated women have opportunities to become leaders at work.\nb. Secondly, educated women can both take care of their children and fulfil their job requirements.\nc. In conclusion, there should be no sex discrimination in our society nowadays.\nd. Their incomes are higher and higher. Why has the situation changed lately?\ne. Firstly, girls who stay at school longer can build their good backgrounds.\nf. The number of women who become highly educated labourers is increasing.',o:['f – d – e – b – a – c','d – a – c – f – e – b','b – a – e – c – d – f','d – c – e – a – b – f'],a:0,e:'Mở bài nêu hiện tượng (f), đặt câu hỏi (d), rồi các ý Firstly (e), Secondly (b), Furthermore (a) và kết luận (c).'},
 {s:'Tiếng Anh',q:'Mark the letter A, B, C, or D to indicate the best arrangement of utterances or sentences to make a meaningful exchange or text.\n\na. All in all, sharing child-rearing and housework helps make a full house.\nb. That is why more and more fathers are loved by both their wives and their children.\nc. Additionally, housework helps men sympathise with their wives.\nd. Firstly, they have a chance to bond with their children and improve their relationships.\ne. In my opinion, men sometimes should stay home, take care of their children and do housework.\nf. Secondly, children instructed by their fathers should become stronger and stronger.',o:['f – a – c – d – b – e','e – d – f – c – a – b','e – f – b – d – c – a','b – d – e – c – f – a'],a:1,e:'Nêu ý kiến (e), các lý do Firstly (d), Secondly (f), Additionally (c), tổng kết (a) rồi câu kết (b).'},
 {s:'Tiếng Anh',q:'Choose the word whose underlined part is pronounced differently from the others (phần -ed ở cuối từ).',o:['walked','rained','missed','stopped'],a:1,e:'“walked, missed, stopped” đọc đuôi -ed là /t/, còn “rained” đọc là /d/.'},
 {s:'Toán',q:'Đổi góc α = π/4 ra độ ta được kết quả là:',o:['30°','45°','60°','90°'],a:1,e:'π/4 × 180°/π = 45°.'},
 {s:'Toán',q:'Tập giá trị của hàm số y = sin x là:',o:['[0; 1]','[−1; 1]','(−∞; +∞)','[−1; 0]'],a:1,e:'Với mọi x ta có −1 ≤ sin x ≤ 1.'},
 {s:'Toán',q:'Cho cấp số cộng (uₙ) có số hạng đầu u₁ = 3 và công sai d = 2. Số hạng thứ 5 của cấp số cộng là:',o:['9','11','13','7'],a:1,e:'u₅ = u₁ + 4d = 3 + 4 × 2 = 11.'},
 {s:'Toán',q:'Trong không gian, cho hai đường thẳng song song. Có bao nhiêu mặt phẳng chứa cả hai đường thẳng đó?',o:['0','1','2','Vô số'],a:1,e:'Hai đường thẳng song song xác định duy nhất một mặt phẳng.'},
 {s:'Toán',q:'Đổi số đo của góc 70° sang đơn vị radian.',o:['70π','7/18','7π/18','7/(18π)'],a:2,e:'70° = 70 × π/180 = 7π/18.'},
 {s:'Toán',q:'Tính độ dài ℓ của cung trên đường tròn có bán kính bằng 20 cm và số đo π/16.',o:['ℓ = 3,93 cm.','ℓ = 2,94 cm.','ℓ = 3,39 cm.','ℓ = 1,49 cm.'],a:0,e:'ℓ = R × α = 20 × π/16 ≈ 3,93 cm.'},
 {s:'Toán',q:'Tính giá trị biểu thức P = tan10°.tan20°.tan30°.....tan80°',o:['P = 0.','P = 1.','P = 4.','P = 8.'],a:1,e:'Các cặp góc phụ nhau có tích tan bằng 1 (tan10°·tan80° = 1, …, tan40°·tan50° = 1) nên P = 1.'},
 {s:'Toán',q:'Tìm giá trị lớn nhất M và giá trị nhỏ nhất m của hàm số y = 3sinx − 2',o:['M = 1, m = −5.','M = 3, m = 1.','M = 2, m = −2.','M = 0, m = −2.'],a:0,e:'Vì −1 ≤ sin x ≤ 1 nên −3 ≤ 3sin x ≤ 3, suy ra −5 ≤ y ≤ 1. Vậy M = 1, m = −5.'},
 {s:"Địa lí",q:"Tháng 5/2008, quốc gia nào quyết định rời khỏi Tổ chức các nước xuất khẩu dầu mỏ (OPEC)?",o:["Malaysia", "Indonesia", "Philippines", "Brunei"],a:1,e:"Tháng 5/2008, Indonesia quyết định rời OPEC."},
 {s:"Địa lí",q:"Nằm bên dãy Hoàng Liên Sơn, Mù Căng Chải là huyện vùng sâu, vùng xa của tỉnh nào?",o:["Lào Cai", "Lai Châu", "Yên Bái", "Sơn La"],a:2,e:"Mù Căng Chải là huyện của tỉnh Yên Bái."},
 {s:"Địa lí",q:"Khi vị trí của Mặt Trời, Mặt Trăng và Trái Đất như thế nào thì dao động của thủy triều là lớn nhất?",o:["Tạo thành một góc vuông", "Mặt Trời và Mặt Trăng ở hai phía vuông góc với Trái Đất", "Nằm thẳng hàng với nhau", "Mặt Trăng nằm giữa Trái Đất và Mặt Trời nhưng lệch khỏi đường thẳng"],a:2,e:"Khi ba thiên thể thẳng hàng (ngày trăng tròn, không trăng), lực hút cộng hưởng nên thủy triều lớn nhất."},
 {s:"Thể thao",q:"EURO lần đầu tiên được tổ chức tại quốc gia nào?",o:["Italia", "Pháp", "Đức", "Tây Ban Nha"],a:1,e:"EURO lần đầu (1960) do Pháp đăng cai vòng chung kết."},
 {s:"Vật lí",q:"Cáp quang là dây dẫn sáng, ứng dụng hiện tượng vật lý nào để truyền tín hiệu?",o:["Khúc xạ ánh sáng", "Giao thoa ánh sáng", "Phản xạ toàn phần", "Tán sắc ánh sáng"],a:2,e:"Ánh sáng truyền trong lõi cáp nhờ phản xạ toàn phần liên tiếp."},
 {s:"Văn học",q:"Điền từ còn thiếu trong câu ca dao về nạn giặc cướp:\n\n“Thương em anh cũng muốn vô\nSợ truông nhà Hồ, sợ phá …”",o:["Tam Giang", "Hàm Luông", "Vàm Cỏ", "Cửa Đại"],a:0,e:"Câu ca dao nhắc “truông nhà Hồ” và “phá Tam Giang”."},
 {s:"Vật lí",q:"Một vật rơi tự do ở Bắc bán cầu có xu hướng bị lệch về phía nào so với phương thẳng đứng do sự tự quay của Trái Đất?",o:["Tây", "Nam", "Bắc", "Đông"],a:3,e:"Do Trái Đất quay từ tây sang đông nên vật rơi tự do bị lệch về phía Đông."},
 {s:"Sinh học",q:"Ai là người đưa ra thuyết tiến hóa trung tính vào năm 1971?",o:["Charles Darwin", "Gregor Mendel", "Motoo Kimura", "Thomas Hunt Morgan"],a:2,e:"Thuyết tiến hóa trung tính do Motoo Kimura đề xuất."},
 {s:"Hóa học",q:"Khi hòa tan amoni nitrat (NH₄NO₃) vào nước, nhiệt độ của dung dịch thay đổi như thế nào?",o:["Tăng lên", "Giảm xuống", "Không thay đổi", "Tăng rồi giảm"],a:1,e:"Sự hòa tan NH₄NO₃ thu nhiệt nên dung dịch lạnh đi."},
 {s:"Hóa học",q:"Loại phân bón nào sau đây có hàm lượng nitơ (đạm) lớn nhất?",o:["NH₄NO₃", "(NH₄)₂SO₄", "CO(NH₂)₂", "NH₄HCO₃"],a:2,e:"Urê CO(NH₂)₂ chứa khoảng 46% N, cao nhất trong các phương án."},
 {s:"Hóa học",q:"Số electron tối đa có thể chứa trong một phân lớp p là bao nhiêu?",o:["2", "6", "10", "14"],a:1,e:"Phân lớp p có 3 obitan, mỗi obitan chứa tối đa 2 electron nên tối đa 6 electron."},
 {s:"Hóa học",q:"Thủy ngân có khả năng hòa tan nhiều kim loại ở nhiệt độ thường, tạo thành hợp kim gọi là gì?",o:["Hợp kim", "Hỗn hống", "Amalgam sắt", "Dung dịch rắn"],a:1,e:"Hợp kim của thủy ngân với kim loại khác gọi là hỗn hống."},
 {s:"Văn học",q:"“Ngư tiều y thuật vấn đáp” là tác phẩm của nhà thơ nào?",o:["Nguyễn Khuyến", "Nguyễn Đình Chiểu", "Nguyễn Trãi", "Cao Bá Quát"],a:1,e:"Tác phẩm của Nguyễn Đình Chiểu."},
 {s:"Hóa học",q:"Chỉ số nào đặc trưng cho tính chống kích nổ của nhiên liệu dùng cho động cơ xăng? Chỉ số càng cao thì khả năng chống kích nổ càng tốt.",o:["Chỉ số cetan", "Chỉ số octan", "Chỉ số axit", "Chỉ số nhiệt"],a:1,e:"Chỉ số octan đặc trưng cho khả năng chống kích nổ của xăng."},
 {s:"Văn học",q:"“Tát nước đầu đình” thuộc loại bài ca giao duyên. Tuy không có hình thức đối đáp nam nữ, bài ca chủ yếu là lời của ai?",o:["Cô gái", "Chàng trai", "Người mẹ", "Người kể chuyện"],a:1,e:"Bài ca chủ yếu là lời của chàng trai."},
 {s:"Văn học",q:"Trong đoạn văn của Nam Cao:\n\n“............. là cái liềm vàng giữa đồng sao ............. là cái đĩa bạc trên tấm thảm nhung da trời ............. tỏa xuống trần gian ............. tuôn suối mát để những hồn khao khát ngụp lặn.”\n\nTừ được nhắc đến và miêu tả xuyên suốt đoạn văn là gì?",o:["Mặt Trời", "Ánh sáng", "Trăng", "Bầu trời"],a:2,e:"Đoạn văn miêu tả trăng (liềm vàng, đĩa bạc)."},
 {s:"Lịch sử",q:"Ngày 21/6/1925, Nguyễn Ái Quốc sáng lập và trực tiếp chỉ đạo xuất bản tờ báo nào, cơ quan của Hội Việt Nam Cách mạng Thanh niên?",o:["Người cùng khổ", "Thanh niên", "Việt Nam độc lập", "Cứu quốc"],a:1,e:"Báo Thanh niên ra số đầu ngày 21/6/1925."},
 {s:"Lịch sử",q:"Hiện vật nào được xem là biểu tượng tiêu biểu của văn hóa Đông Sơn?",o:["Tượng Phật", "Trống đồng", "Thạp đồng", "Chuông đồng"],a:1,e:"Trống đồng là biểu tượng tiêu biểu của văn hóa Đông Sơn."},
 {s:"Vật lí",q:"Đơn vị đo cường độ dòng điện là gì?",o:["Vôn", "Oát", "Ampe", "Jun"],a:2,e:"Cường độ dòng điện đo bằng ampe (A)."},
 {s:"Văn học",q:"Câu thơ “Trăm năm trong cõi người ta” là câu mở đầu của tác phẩm nào?",o:["Chinh phụ ngâm", "Truyện Kiều", "Lục Vân Tiên", "Cung oán ngâm khúc"],a:1,e:"Đây là câu mở đầu Truyện Kiều của Nguyễn Du."},
 {s:"Vật lí",q:"Đơn vị đo công suất trong hệ SI là gì?",o:["Jun", "Oát", "Vôn", "Ampe"],a:1,e:"Công suất đo bằng oát (W)."},
 {s:"Đố mẹo",q:"Một người đi dưới trời mưa rất to, không mang ô, không đội mũ nhưng tóc không bị ướt. Vì sao?",o:["Người đó đứng dưới mái hiên", "Người đó chạy rất nhanh", "Người đó bị hói", "Người đó mặc áo mưa"],a:2,e:"Người đó bị hói nên không có tóc để ướt."},
 {s:"Đố mẹo",q:"Một tháng có 28 ngày. Hỏi có bao nhiêu tháng có 28 ngày?",o:["1", "2", "6", "12"],a:3,e:"Tháng nào cũng có ít nhất 28 ngày nên cả 12 tháng đều thỏa."},
 {s:"Thể thao",q:"“Albicelestes” là biệt danh của đội tuyển bóng đá quốc gia nào?",o:["Tây Ban Nha", "Bồ Đào Nha", "Séc", "Argentina"],a:3,e:"“Albicelestes” nghĩa là trắng-xanh, biệt danh của đội tuyển Argentina."},
 {s:"Văn học",q:"“Ai muốn cao ngồi ghế/ Ai muốn thấp ngồi đòn/ Ai muốn đỏ bôi son/ Ai muốn vàng bôi nghệ…” là những câu hát thuộc thể loại gì?",o:["Ca dao", "Tục ngữ", "Đồng dao", "Thành ngữ"],a:2,e:"Đây là những câu hát dân gian dành cho trẻ em, thuộc thể loại đồng dao."},
 {s:"Lịch sử",q:"“Bạch đầu quân” là tên gọi của lực lượng dân quân nào trong kháng chiến chống Mỹ?",o:["Các cụ già", "Thanh niên", "Phụ nữ", "Nhi đồng"],a:0,e:"“Bạch đầu quân” chỉ lực lượng dân quân gồm những người cao tuổi."},
 {s:"Văn học",q:"“Cánh đồng bất tận” là một tác phẩm nổi tiếng của Nguyễn Ngọc Tư đã được chuyển thể thành phim, lấy bối cảnh vùng đất nào?",o:["Đồng bằng Bắc Bộ", "Tây Nguyên", "Đồng bằng sông Cửu Long"],a:2,e:"Tác phẩm lấy bối cảnh miền Tây Nam Bộ, gắn với sông nước và những cánh đồng rộng lớn."},
 {s:"Địa lí",q:"Địa danh Làng Khuốc trong câu ca dao “Hỡi cô thắt dải lưng xanh/ Có xem chèo Khuốc với anh thì về” thuộc tỉnh nào?",o:["Thái Bình", "Nam Định", "Hải Dương", "Ninh Bình"],a:0,e:"Làng Khuốc thuộc tỉnh Thái Bình."},
 {s:"Văn học",q:"Địa danh nào còn thiếu trong câu ca dao sau: “Ai về … cùng ta/ Nhớ ngày giỗ tổ tháng ba mùng mười”?",o:["Quảng Trị", "Nam Định", "Thanh Hóa", "Phú Thọ"],a:3,e:"Giỗ Tổ Hùng Vương mùng 10 tháng 3 diễn ra ở Phú Thọ."},
 {s:"Văn học",q:"Địa danh nào được nhắc đến trong câu ca sau: “Hỡi cô thắt dải lưng xanh/ Có về … với anh thì về/ … có bến Đò Chè/ Có dinh tổng đốc có nghề ươm tơ”?",o:["Thanh Hoá", "Thái Bình", "Bình Định", "Nam Định"],a:3,e:"Câu ca nhắc tới Nam Định (bến Đò Chè, dinh tổng đốc)."},
 {s:"Địa lí",q:"Địa danh nào sau đây ở miền Trung nước ta?",o:["Quảng Ngãi", "Cà Mau", "Lạng Sơn", "Hòa Bình"],a:0,e:"Quảng Ngãi thuộc miền Trung."},
 {s:"Địa lí",q:"Địa danh nào trong ngôn ngữ Tày – Nùng có nghĩa là “núi hoa”?",o:["Phia Móóc", "Phia Bi-oóc", "Phia Đeng", "Phia Đin"],a:1,e:"Phia Bi-oóc có nghĩa là “núi hoa”."},
 {s:"Địa lí",q:"Địa danh Quán Gánh – Thường Tín – Hà Nội nổi tiếng với loại bánh nào?",o:["Bánh bao", "Bánh giầy", "Bánh đậu xanh", "Bánh sắn"],a:3,e:"Quán Gánh nổi tiếng với bánh sắn."},
 {s:"Địa lí",q:"Địa danh tỉnh Gia Định cũ ở miền Nam nước ta ngày nay được dùng để chỉ phần trung tâm quận nào của TP Hồ Chí Minh?",o:["Thủ Đức", "Bình Thạnh", "Gò Vấp", "Phú Nhuận"],a:1,e:"Gia Định cũ ứng với phần trung tâm quận Bình Thạnh."},
 {s:"Thể thao",q:"Đĩa nước Hoa Hồng Vệ Nữ là phần thưởng cao quý dành cho các tay vợt vô địch đơn nữ tại giải Grand Slam quần vợt nào?",o:["Úc mở rộng", "Mỹ mở rộng", "Wimbledon", "Pháp mở rộng"],a:2,e:"Venus Rosewater Dish là chiếc đĩa trao cho nhà vô địch đơn nữ Wimbledon."},
 {s:"Lịch sử",q:"Đình Nghênh Lương được xây dựng tại địa danh nào của nước ta?",o:["Kinh thành Thăng Long", "Cố đô Hoa Lư", "Cố đô Huế", "Thành Cổ Loa"],a:2,e:"Đình Nghênh Lương nằm ở Cố đô Huế."},
 {s:"Văn học",q:"Đoàn Phú Tứ đã tả màu và hương của thứ gì không xanh, không nồng, thanh thanh?",o:["Không gian", "Thời gian", "Trời", "Thu"],a:1,e:"Trong bài thơ “Màu thời gian”: màu thời gian không xanh, hương thời gian không nồng, thanh thanh."},
 {s:"Thể thao",q:"Đội bóng nào của giải Ngoại hạng Anh có biệt danh là “mèo đen”?",o:["Liverpool", "Sunderland", "Oxford", "Newcastle United"],a:1,e:"Sunderland có biệt danh “Black Cats” (mèo đen)."},
 {s:"Thể thao",q:"Đội bóng nào giành được ngôi vô địch tại World Cup đầu tiên năm 1930?",o:["Uruguay", "Argentina", "Brazil", "Đức"],a:0,e:"Uruguay vô địch World Cup 1930."}
];
/* ---- Luật tính điểm & thời gian ---- */
const REWARD=20000;        // trả lời đúng: +20.000 USD
const PENALTY=2500;        // trả lời sai: -2.500 USD
const MAX_WRONG=5;         // sai QUÁ 5 lần (tức lần sai thứ 6) thì thua
const TIME_LIMIT=30;       // giây cho mỗi câu
const TIMEOUT_IS_WRONG=false; // false: hết giờ chỉ bỏ qua câu (không trừ tiền, không tính lần sai). Đổi thành true nếu muốn hết giờ bị tính là sai
const MILLION=1000000, HUNDRED_K=100000;
const TIMEOUT_NEXT_MS=2500; // hết giờ: hiện đáp án vài giây rồi tự sang câu khác

let i=0,score=0,money=0,wrong=0,timerId=null,nextId=null;
const usd=n=>(n<0?'-':'')+String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+' USD';
function h(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function stopTimers(){clearInterval(timerId);clearTimeout(nextId);timerId=null;nextId=null;}
function restart(){i=0;score=0;money=0;wrong=0;render();}

function renderLose(){
  stopTimers();root.innerHTML='';
  const end=h('div','qz-end lose');
  end.append(
    h('p','qz-big','Bạn đã thua!'),
    h('p','qz-msg','Bạn đã trả lời sai quá '+MAX_WRONG+' lần (số tiền còn lại: '+usd(money)+'). Hãy chơi lại từ đầu.')
  );
  const again=h('button','b p','Chơi lại từ đầu');again.type='button';again.onclick=restart;
  end.append(again);root.append(end);
}
function renderEnd(){
  stopTimers();root.innerHTML='';
  let msg,cls;
  if(money>MILLION){msg='Xin chúc mừng bạn đã trở thành triệu phú!';cls='win';}
  else if(money>=HUNDRED_K){msg='Xin chúc mừng bạn đạt được số tiền '+usd(money)+'!';cls='mid';}
  else{msg='Xin chúc bạn may mắn lần sau!';cls='low';}
  const end=h('div','qz-end '+cls);
  end.append(
    h('p','qz-big',msg),
    h('p','qz-msg','Số tiền: '+usd(money)+' · '+score+' / '+Q.length+' câu đúng · '+wrong+' lần sai')
  );
  const again=h('button','b p','Chơi lại');again.type='button';again.onclick=restart;
  end.append(again);root.append(end);
}

function render(){
  stopTimers();root.innerHTML='';
  if(i>=Q.length){renderEnd();return;}
  const q=Q[i];let done=false;

  const rule=h('p','qz-rule','Đúng +'+usd(REWARD)+' · Sai −'+usd(PENALTY)+'');
  const top=h('div','qz-top');
  top.append(h('span','qz-tag',q.s+' · Câu '+(i+1)+'/'+Q.length));
  const stats=h('div','qz-stats');
  const sMoney=h('span','qz-money'),sWrong=h('span'),sRight=h('span');
  stats.append(sMoney,sWrong,sRight);
  function paintStats(){
    sMoney.textContent='Tiền: '+usd(money);
    sMoney.classList.toggle('neg',money<0);
    sWrong.textContent='Sai: '+wrong+'/'+MAX_WRONG;
    sRight.textContent='Đúng: '+score;
  }
  paintStats();

  /* đồng hồ đếm ngược: tự tạm dừng khi người chơi không nhìn thấy câu hỏi (đổi trang, đổi trò, ẩn tab) */
  const tBox=h('div','qz-timer'),tTxt=h('span','qz-time'),tBar=h('span','qz-timebar'),tFill=document.createElement('i');
  tBar.append(tFill);tBox.append(tTxt,tBar);
  let left=TIME_LIMIT*1000,last=Date.now();
  function paintTimer(){
    tTxt.textContent='⏱ '+Math.ceil(left/1000)+' s';
    tFill.style.width=(left/(TIME_LIMIT*1000)*100)+'%';
    tBox.classList.toggle('low',left<=10000);
  }
  paintTimer();

  const fb=h('div','qz-fb');
  const nx=h('button','b p qz-next',i===Q.length-1?'Xem kết quả':'Câu tiếp');
  nx.type='button';nx.style.display='none';
  function advance(){
    stopTimers();
    if(wrong>MAX_WRONG){renderLose();return;}
    i++;render();
  }
  nx.onclick=advance;

  function finish(ok,msg,timedOut){
    if(done)return;
    done=true;clearInterval(timerId);timerId=null;
    if(ok){score++;money+=REWARD;}
    else{wrong++;money-=PENALTY;}
    const lost=wrong>MAX_WRONG;
    const delta=ok?'+'+usd(REWARD):'−'+usd(PENALTY);
    fb.className='qz-fb '+(ok?'ok':'bad');
    fb.textContent=msg+' ('+delta+') '+q.e+(lost?' Bạn đã sai quá '+MAX_WRONG+' lần!':'');
    if(lost)nx.textContent='Xem kết quả';
    nx.style.display='';
    paintStats();
    if(timedOut){nextId=setTimeout(advance,TIMEOUT_NEXT_MS);}   // hết giờ: tự sang câu khác
    else nx.focus();
  }

  root.append(rule,top,stats,tBox,h('p','qz-q',q.q));
  let lockInput=()=>{};
  if(q.o){
    const box=h('div','qz-opts');
    const btns=q.o.map((t,k)=>{
      const b=h('button','b qz-opt',L[k]+'. '+t);b.type='button';
      b.onclick=()=>{
        if(done)return;
        btns.forEach((x,j)=>{x.disabled=true;if(j===q.a)x.classList.add('right');});
        if(k!==q.a)b.classList.add('wrong');
        finish(k===q.a,k===q.a?'Chính xác!':'Chưa đúng. Đáp án: '+L[q.a]+'.');
      };
      box.append(b);return b;
    });
    lockInput=()=>btns.forEach((x,j)=>{x.disabled=true;if(j===q.a)x.classList.add('right');});
    root.append(box);
  }else{
    const row=h('div','qz-numrow');
    const inp=h('input','qz-inp');inp.type='text';inp.inputMode='decimal';inp.placeholder='Nhập đáp án ('+q.unit+')';
    const ck=h('button','b',"Kiểm tra");ck.type='button';
    const go=()=>{
      if(done)return;
      const v=parseFloat(inp.value.trim().replace(',','.'));
      if(isNaN(v)){inp.focus();return;}
      inp.disabled=true;ck.disabled=true;
      const ok=Math.abs(v-q.num)<1e-9;
      finish(ok,ok?'Chính xác!':'Chưa đúng. Đáp án: '+q.ans+' '+q.unit+'.');
    };
    ck.onclick=go;inp.onkeydown=e=>{if(e.key==='Enter')go();};
    lockInput=()=>{inp.disabled=true;ck.disabled=true;};
    row.append(inp,ck);root.append(row);
  }
  root.append(fb,nx);

  function timeUp(){
    lockInput();
    const ans=q.o?'Đáp án: '+L[q.a]+'.':'Đáp án: '+q.ans+' '+q.unit+'.';
    if(TIMEOUT_IS_WRONG)finish(false,'Hết giờ! '+ans,true);
    else{                       // chế độ không phạt: chỉ báo hết giờ rồi sang câu khác
      done=true;clearInterval(timerId);timerId=null;
      fb.className='qz-fb bad';fb.textContent='Hết giờ! '+ans+' '+q.e;
      nx.style.display='';nextId=setTimeout(advance,TIMEOUT_NEXT_MS);
    }
  }
  timerId=setInterval(()=>{
    const now=Date.now(),dt=now-last;last=now;
    if(done)return;
    if(document.hidden||root.offsetParent===null)return;   // đang không hiển thị: tạm dừng đếm
    left-=dt;
    if(left<=0){left=0;paintTimer();timeUp();return;}
    paintTimer();
  },100);
}
render();
})();