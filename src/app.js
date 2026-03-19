// ═══════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════
let db = null;
let page = 1, dpage = 1;
let dDeckFilter = null; // null | 'deck' | 'sideboard'
const PG = 48;
let view = 'g', dview = 'g';
let collOnly = false;
let coll = new Set(JSON.parse(localStorage.getItem('lv_coll')||'[]'));
let curTab = 'browse';

// Decks: { id, name, cards: {cardId: qty} }
let decks = JSON.parse(localStorage.getItem('lv_decks')||'[]');
// Migrate any legacy plain-number card entries to {qty, foil} objects; ensure sideboard exists
(function(){decks.forEach(d=>{
  if(!d.sideboard)d.sideboard={};
  Object.entries(d.cards).forEach(([id,v])=>{if(typeof v==='number')d.cards[id]={qty:v,foil:false}});
  Object.entries(d.sideboard).forEach(([id,v])=>{if(typeof v==='number')d.sideboard[id]={qty:v,foil:false}});
})})();
let curDeckId = null;  // null = "home", else deck id

// Browse filters
const F = {ink:new Set(),rarity:new Set(),type:new Set(),typeExact:new Set(),classification:new Set(),set:new Set(),keywords:new Set(),inkwell:null,cmin:0,cmax:10,lmin:null,lmax:null,smin:null,smax:null,wmin:null,wmax:null,q:''};
// Deck picker filters (independent)
const DF = {ink:new Set(),rarity:new Set(),type:new Set(),typeExact:new Set(),classification:new Set(),set:new Set(),keywords:new Set(),inkwell:null,cmin:0,cmax:10,lmin:null,lmax:null,smin:null,smax:null,wmin:null,wmax:null,q:''};

const IC = {Amber:'#f59e0b',Amethyst:'#a855f7',Emerald:'#10b981',Ruby:'#ef4444',Sapphire:'#3b82f6',Steel:'#94a3b8'};
const RA = {Common:'C',Uncommon:'U',Rare:'R',Super_rare:'SR',Legendary:'L',Enchanted:'E',Promo:'P',Epic:'Ep',Iconic:'Ic'};
const RC = {Common:'rC',Uncommon:'rU',Rare:'rR',Super_rare:'rS',Legendary:'rL',Enchanted:'rE',Promo:'rP',Epic:'rEp',Iconic:'rIc'};

// ═══════════════════════════════════════════════════════════════════
// LOADING
// ═══════════════════════════════════════════════════════════════════
function setBar(p,msg){document.getElementById('bar').style.width=p+'%';if(msg)document.getElementById('lmsg').textContent=msg}
function showErr(msg){const e=document.getElementById('lerr');e.textContent=msg;e.style.display='block';document.getElementById('lretry').style.display='inline-block'}

// ═══════════════════════════════════════════════════════════════════
// DB
// ═══════════════════════════════════════════════════════════════════
async function initDB(){
  const SQL=await initSqlJs({locateFile:f=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`});
  db=new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS cards(
    id TEXT PRIMARY KEY,name TEXT,version TEXT,layout TEXT,released_at TEXT,
    img_s TEXT,img_n TEXT,img_l TEXT,cost INTEGER,inkwell INTEGER,ink TEXT,
    types TEXT,classes TEXT,ctxt TEXT,move_cost INTEGER,str INTEGER,wil INTEGER,
    lore INTEGER,rarity TEXT,ills TEXT,cnum TEXT,flavor TEXT,set_code TEXT,set_name TEXT,
    keywords TEXT,price_usd TEXT
  );
  CREATE INDEX IF NOT EXISTS in_name ON cards(name);
  CREATE INDEX IF NOT EXISTS in_ink  ON cards(ink);
  CREATE INDEX IF NOT EXISTS in_rar  ON cards(rarity);
  CREATE INDEX IF NOT EXISTS in_set  ON cards(set_code);
  CREATE INDEX IF NOT EXISTS in_cost ON cards(cost);
  CREATE INDEX IF NOT EXISTS in_namever ON cards(name,version);
  -- One canonical row per logical card (name+version).
  -- Uses MIN(id) as the tiebreaker — always selects exactly one row per group
  -- regardless of set_code format (numeric "1","2" vs alpha "P1","cp","D23" etc.)
  -- COALESCE(version,'') and REPLACE chains normalize NULL/''/Unicode apostrophes.
  DROP VIEW IF EXISTS card_canonical;
  CREATE VIEW card_canonical AS
    SELECT c.*
    FROM cards c
    INNER JOIN (
      SELECT MIN(id) AS canon_id
      FROM cards
      GROUP BY
        REPLACE(REPLACE(REPLACE(name, char(8217), char(39)), char(8216), char(39)), char(700), char(39)),
        COALESCE(version,'')
    ) best ON c.id = best.canon_id;`);
}

async function fetchJSON(url,timeout=15000){
  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),timeout);
  try{const r=await fetch(url,{signal:ctrl.signal});clearTimeout(tid);if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}
  catch(e){clearTimeout(tid);throw e}
}

// Normalize Unicode punctuation variants to plain ASCII equivalents so that
// names like "A Pirate\u2019s Life" and "A Pirate\u0027s Life" group as one card.

async function loadCards(){
  setBar(10,'Fetching set list from Lorcast API…');
  let sets;
  try{const d=await fetchJSON('https://api.lorcast.com/v0/sets');sets=d.results||[];if(!sets.length)throw new Error('No sets')}
  catch(e){throw new Error(`Could not load sets: ${e.message}. Serve this file via a local web server.`)}
  setBar(15,`Found ${sets.length} sets. Fetching cards…`);
  const stmt=db.prepare(`INSERT OR REPLACE INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.run('BEGIN');
  let total=0;
  for(let i=0;i<sets.length;i++){
    const s=sets[i];setBar(15+Math.round((i/sets.length)*78),`Fetching Set ${s.code}: ${s.name} (${i+1}/${sets.length})…`);
    try{
      const cards=await fetchJSON(`https://api.lorcast.com/v0/sets/${s.code}/cards`);
      const arr=Array.isArray(cards)?cards:(cards.results||[]);
      for(const c of arr){
        const name=normStr(c.name);
        const ver=normStr(c.version?c.version.trim()||null:null);
        stmt.run([c.id,name,ver,c.layout||null,c.released_at||null,c.image_uris?.digital?.small||null,c.image_uris?.digital?.normal||null,c.image_uris?.digital?.large||null,c.cost??null,c.inkwell?1:0,c.ink||null,JSON.stringify(c.type||[]),JSON.stringify(c.classifications||[]),c.text||null,c.move_cost??null,c.strength??null,c.willpower??null,c.lore??null,c.rarity||null,JSON.stringify(c.illustrators||[]),c.collector_number||null,c.flavor_text||null,s.code,s.name,JSON.stringify(c.keywords||[]),c.prices?.usd||null]);
        total++;
      }
    }catch(e){console.warn(`Set ${s.code}:`,e.message)}
  }
  db.run('COMMIT');stmt.free();
  if(!total)throw new Error('No cards inserted — CORS issue? Try: python -m http.server 8080');
  return{sets,total};
}

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════
async function boot(){
  document.getElementById('lerr').style.display='none';
  document.getElementById('lretry').style.display='none';
  document.getElementById('lmsg').textContent='Initializing…';setBar(0);
  try{
    await initDB();setBar(8,'DB ready…');
    const{sets,total}=await loadCards();
    setBar(95,'Building interface…');
    buildSetChips(sets);
    buildClassChips();
    buildActionSubChips();
    buildKeywordChips();
    run();updColl();updDeckBadge();
    setBar(100,`Loaded ${total.toLocaleString()} cards!`);
    await new Promise(r=>setTimeout(r,300));
    document.getElementById('load').style.display='none';
    document.getElementById('app').style.display='flex';
  }catch(e){setBar(0,'');showErr(e.message);console.error(e)}
}

function buildSetChips(sets){
  const sorted=sets.sort((a,b)=>String(a.code).localeCompare(String(b.code),undefined,{numeric:true}));
  ['setChips','dsetChips'].forEach(id=>{
    const c=document.getElementById(id);c.innerHTML='';
    sorted.forEach(s=>{
      const b=document.createElement('button');b.className='chip';
      const dk=id==='dsetChips'?'data-set':'data-set';b.setAttribute(dk,s.code);
      b.textContent=s.name.length>18?s.name.substring(0,16)+'…':s.name;b.title=s.name;
      b.onclick=id==='dsetChips'?()=>dtf('set',s.code,b):()=>tf('set',s.code,b);
      c.appendChild(b);
    });
  });
}

function buildClassChips(){
  // Extract all unique classifications from the loaded DB
  const res=db.exec(`SELECT DISTINCT classes FROM cards WHERE classes IS NOT NULL AND classes != '[]'`);
  if(!res[0])return;
  const allClasses=new Set();
  for(const[row] of res[0].values){
    try{JSON.parse(row).forEach(c=>c&&allClasses.add(c))}catch{}
  }

  // Group into known categories, put unknowns in "Other"
  const ORIGIN=['Storyborn','Floodborn','Dreamborn'];
  const ROLE=['Hero','Villain','Ally','Support'];
  const TITLE=['Prince','Princess','King','Queen','Knight','Captain','Sorcerer','Pirate','Fairy','Mage','Inventor'];
  const SPECIES=['Dragon','Giant','Merfolk','Alien','Robot','Animal','Deity'];
  // Everything else goes to Other
  const grouped={Origin:[],Role:[],Title:[],Species:[],Other:[]};
  const placed=new Set();
  ORIGIN.forEach(c=>{if(allClasses.has(c)){grouped.Origin.push(c);placed.add(c)}});
  ROLE.forEach(c=>{if(allClasses.has(c)){grouped.Role.push(c);placed.add(c)}});
  TITLE.forEach(c=>{if(allClasses.has(c)){grouped.Title.push(c);placed.add(c)}});
  SPECIES.forEach(c=>{if(allClasses.has(c)){grouped.Species.push(c);placed.add(c)}});
  [...allClasses].sort().forEach(c=>{if(!placed.has(c))grouped.Other.push(c)});

  // Render into both sidebars
  [['bClassChips','bClassSection',false],['dClassChips','dClassSection',true]].forEach(([chipsId,sectionId,isDeck])=>{
    const container=document.getElementById(chipsId);
    if(!container)return;
    container.innerHTML='';
    let hasAny=false;
    Object.entries(grouped).forEach(([groupName,items])=>{
      if(!items.length)return;
      hasAny=true;
      const lbl=document.createElement('span');lbl.className='chip-group-lbl';lbl.textContent=groupName;
      container.appendChild(lbl);
      items.forEach(cls=>{
        const b=document.createElement('button');
        b.className='chip';b.setAttribute('data-class',cls);b.textContent=cls;b.title=cls;
        b.onclick=isDeck?()=>dtf('classification',cls,b):()=>tf('classification',cls,b);
        container.appendChild(b);
      });
    });
    // Hide toggle if no classes
    const toggleBtn=document.getElementById(isDeck?'dClassToggle':'bClassToggle');
    const section=document.getElementById(sectionId);
    if(!hasAny){section.style.display='none'}else{toggleBtn.style.display='block'}
  });
}

function toggleClassExpand(prefix){
  const chips=document.getElementById(prefix+'ClassChips');
  const btn=document.getElementById(prefix+'ClassToggle');
  const collapsed=chips.classList.toggle('collapsed');
  chips.classList.toggle('expanded',!collapsed);
  btn.textContent=collapsed?'Show all ▾':'Show less ▴';
}

function buildActionSubChips(){
  // Find every unique type that co-occurs with "Action" (i.e. action subtypes)
  const res=db.exec(`SELECT DISTINCT types FROM cards WHERE types LIKE '%"Action"%'`);
  if(!res[0])return;
  const subtypes=new Set();
  for(const[row] of res[0].values){
    try{
      const arr=JSON.parse(row);
      // A subtype card has Action PLUS at least one other type
      if(arr.includes('Action')&&arr.length>1){
        arr.filter(t=>t!=='Action').forEach(t=>subtypes.add(t));
      }
    }catch{}
  }
  if(!subtypes.size)return;
  const sorted=[...subtypes].sort();
  [['bActionSubChips',false],['dActionSubChips',true]].forEach(([id,isDeck])=>{
    const el=document.getElementById(id);
    if(!el)return;
    el.innerHTML='';
    // Small label
    const lbl=document.createElement('span');
    lbl.className='chip-group-lbl';lbl.style.borderTop='none';lbl.style.marginTop='0';lbl.style.paddingTop='0';
    lbl.textContent='Action subtypes';
    el.appendChild(lbl);
    sorted.forEach(sub=>{
      const b=document.createElement('button');
      b.className='chip';b.setAttribute('data-type',sub);
      b.textContent=sub;
      b.onclick=isDeck?()=>dtf('type',sub,b):()=>tf('type',sub,b);
      el.appendChild(b);
    });
  });
}

function buildKeywordChips(){
  // Extract all unique keywords from the loaded DB
  const res=db.exec(`SELECT DISTINCT keywords FROM cards WHERE keywords IS NOT NULL AND keywords != '[]'`);
  if(!res[0])return;
  const allKw=new Set();
  for(const[row] of res[0].values){
    try{JSON.parse(row).forEach(k=>k&&allKw.add(k))}catch{}
  }
  if(!allKw.size)return;
  const sorted=[...allKw].sort();
  [['bKwChips',false],['dKwChips',true]].forEach(([id,isDeck])=>{
    const el=document.getElementById(id);if(!el)return;
    el.innerHTML='';
    sorted.forEach(kw=>{
      const b=document.createElement('button');
      b.className='chip';b.setAttribute('data-kw',kw);b.textContent=kw;
      b.onclick=isDeck?()=>dtf('keywords',kw,b):()=>tf('keywords',kw,b);
      el.appendChild(b);
    });
  });
}
// ═══════════════════════════════════════════════════════════════════
function switchTab(tab){
  curTab=tab;
  document.getElementById('tabBrowse').style.display=tab==='browse'?'flex':'none';
  document.getElementById('tabDecks').style.display=tab==='decks'?'flex':'none';
  document.getElementById('ntBrowse').classList.toggle('on',tab==='browse');
  document.getElementById('ntDecks').classList.toggle('on',tab==='decks');
  // search bar feeds both
  if(tab==='decks'){
    if(curDeckId===null)renderDecksHome();
    else{drun();}
  }
}

// ═══════════════════════════════════════════════════════════════════
// BROWSE FILTERS
// ═══════════════════════════════════════════════════════════════════
function tf(k,v,btn){
  if(k==='inkwell'){if(F.inkwell===v){F.inkwell=null;btn.classList.remove('on')}else{document.querySelectorAll('#browseSide [data-iw]').forEach(b=>b.classList.remove('on'));F.inkwell=v;btn.classList.add('on')}}
  else{F[k].has(v)?(F[k].delete(v),btn.classList.remove('on')):(F[k].add(v),btn.classList.add('on'))}
  page=1;run();
}
function updCost(){let mn=+document.getElementById('rmin').value,mx=+document.getElementById('rmax').value;if(mn>mx)[mn,mx]=[mx,mn];F.cmin=mn;F.cmax=mx;document.getElementById('cmn').textContent=mn;document.getElementById('cmx').textContent=mx>=10?'10+':mx;page=1;run()}

// Shared handler for lore/strength/willpower range sliders.
// stat = 'l'|'s'|'w', side = 'b'(browse)|'d'(deck)
function updStat(stat,side){
  const isB=side==='b';
  const F_=isB?F:DF;
  const pfx=side+stat;
  let mn=+document.getElementById(pfx+'min').value,mx=+document.getElementById(pfx+'max').value;
  if(mn>mx)[mn,mx]=[mx,mn];
  const maxVal=stat==='l'?4:10;
  // Only activate filter if not at full default range
  const active=!(mn===0&&mx===maxVal);
  F_[stat+'min']=active?mn:null;
  F_[stat+'max']=active?mx:null;
  document.getElementById(pfx+'mn').textContent=active?mn:'—';
  document.getElementById(pfx+'mx').textContent=active?mx:'—';
  const clrBtn=document.getElementById(pfx+'clr');
  if(clrBtn)clrBtn.style.display=active?'inline':'none';
  if(isB){page=1;run();}else{dpage=1;drun();}
}

function clrStat(stat,side){
  const isB=side==='b';
  const F_=isB?F:DF;
  const pfx=side+stat;
  const maxVal=stat==='l'?4:10;
  F_[stat+'min']=null;F_[stat+'max']=null;
  document.getElementById(pfx+'min').value=0;
  document.getElementById(pfx+'max').value=maxVal;
  document.getElementById(pfx+'mn').textContent='—';
  document.getElementById(pfx+'mx').textContent='—';
  const clrBtn=document.getElementById(pfx+'clr');
  if(clrBtn)clrBtn.style.display='none';
  if(isB){page=1;run();}else{dpage=1;drun();}
}

function clrAll(){
  ['ink','rarity','type','typeExact','classification','set','keywords'].forEach(k=>F[k].clear());
  F.inkwell=null;F.cmin=0;F.cmax=10;F.q='';
  document.getElementById('srch').value='';
  document.getElementById('rmin').value=0;document.getElementById('rmax').value=10;
  document.getElementById('cmn').textContent='0';document.getElementById('cmx').textContent='10+';
  ['l','s','w'].forEach(s=>clrStat(s,'b'));
  document.querySelectorAll('#browseSide .chip.on').forEach(b=>b.classList.remove('on'));
  page=1;run();
}

// DECK FILTERS
function dtf(k,v,btn){
  if(k==='inkwell'){if(DF.inkwell===v){DF.inkwell=null;btn.classList.remove('on')}else{document.querySelectorAll('#deckSide [data-iw]').forEach(b=>b.classList.remove('on'));DF.inkwell=v;btn.classList.add('on')}}
  else{DF[k].has(v)?(DF[k].delete(v),btn.classList.remove('on')):(DF[k].add(v),btn.classList.add('on'))}
  dpage=1;drun();
}
function updDCost(){let mn=+document.getElementById('drmin').value,mx=+document.getElementById('drmax').value;if(mn>mx)[mn,mx]=[mx,mn];DF.cmin=mn;DF.cmax=mx;document.getElementById('dcmn').textContent=mn;document.getElementById('dcmx').textContent=mx>=10?'10+':mx;dpage=1;drun()}
function dclrAll(){
  ['ink','rarity','type','typeExact','classification','set','keywords'].forEach(k=>DF[k].clear());
  DF.inkwell=null;DF.cmin=0;DF.cmax=10;DF.q=document.getElementById('srch').value.trim();
  document.getElementById('drmin').value=0;document.getElementById('drmax').value=10;
  document.getElementById('dcmn').textContent='0';document.getElementById('dcmx').textContent='10+';
  ['l','s','w'].forEach(s=>clrStat(s,'d'));
  document.querySelectorAll('#deckSide .chip.on').forEach(b=>b.classList.remove('on'));
  dpage=1;drun();
}

// ═══════════════════════════════════════════════════════════════════
// BROWSE RENDER
// ═══════════════════════════════════════════════════════════════════
function run(){
  if(!db)return;
  const tot=runQ(F,true,page,collOnly);
  const cards=runQ(F,false,page,collOnly);
  renderCards(cards,'grid','gbtn','lbtn',view,false);
  renderPag(tot,page,p=>{page=p;run();},document.getElementById('cnt'));
  // Show both unique-card count and raw print count when unfiltered
  const rawTot=collOnly?tot:db.exec('SELECT COUNT(*) FROM cards')[0]?.values[0][0]||0;
  const label=tot===rawTot||collOnly
    ?`${tot.toLocaleString()} unique cards`
    :`${tot.toLocaleString()} unique cards (${rawTot.toLocaleString()} total prints)`;
  document.getElementById('rc').textContent=label;
}

// Rarity sort weight expression (lower number = rarer)

function runQ(f,cnt,pg,co){
  const [from,fromP]=buildFrom(f.rarity);
  const c=[],p=[];
  if(f.q){c.push(`(name LIKE ? OR version LIKE ? OR ctxt LIKE ? OR flavor LIKE ? OR classes LIKE ?)`);const s=`%${f.q}%`;p.push(s,s,s,s,s)}
  if(f.ink.size){c.push(`ink IN(${[...f.ink].map(()=>'?').join(',')})`);p.push(...f.ink)}
  // rarity is handled entirely by buildFrom — no extra WHERE clause needed
  const typeClauses=[];
  if(f.type.size){f.type.forEach(t=>{typeClauses.push(`types LIKE ?`);p.push(`%"${t}"%`)})}
  if(f.typeExact&&f.typeExact.size){f.typeExact.forEach(t=>{typeClauses.push(`(json_array_length(types)=1 AND types LIKE ?)`);p.push(`%"${t}"%`)})}
  if(typeClauses.length)c.push(`(${typeClauses.join(' OR ')})`);
  if(f.classification&&f.classification.size){c.push(`(${[...f.classification].map(()=>'classes LIKE ?').join(' OR ')})`);f.classification.forEach(cl=>p.push(`%"${cl}"%`))}
  if(f.set.size){
    if(f.rarity&&f.rarity.size>0){
      // Row IS the matching print — its set_code is already correct, just filter directly
      c.push(`set_code IN(${[...f.set].map(()=>'?').join(',')})`);p.push(...f.set);
    } else {
      const ph=[...f.set].map(()=>'?').join(',');
      c.push(`EXISTS(SELECT 1 FROM cards p WHERE p.name=card_canonical.name AND COALESCE(p.version,'')=COALESCE(card_canonical.version,'') AND p.set_code IN(${ph}))`);
      p.push(...f.set);
    }
  }
  if(f.inkwell!==null){c.push(`inkwell=?`);p.push(+f.inkwell)}
  c.push(`(cost>=? AND (cost<=? OR ?>=10))`);p.push(f.cmin,f.cmax,f.cmax);
  if(f.lmin!==null){c.push(`lore>=? AND lore<=?`);p.push(f.lmin,f.lmax)}
  if(f.smin!==null){c.push(`str>=? AND str<=?`);p.push(f.smin,f.smax)}
  if(f.wmin!==null){c.push(`wil>=? AND wil<=?`);p.push(f.wmin,f.wmax)}
  if(f.keywords&&f.keywords.size){c.push(`(${[...f.keywords].map(()=>'keywords LIKE ?').join(' AND ')})`);f.keywords.forEach(k=>p.push(`%"${k}"%`))}
  if(co){if(!coll.size)c.push('1=0');else{c.push(`id IN(${[...coll].map(()=>'?').join(',')})`);p.push(...coll)}}
  const w=c.length?'WHERE '+c.join(' AND '):'';
  const allP=[...fromP,...p];
  if(cnt){const r=db.exec(`SELECT COUNT(*) FROM ${from} ${w}`,allP);return r[0]?.values[0][0]||0}
  const sm={na:'name ASC,version ASC',nd:'name DESC,version DESC',ca:'cost ASC,name ASC',cd:'cost DESC,name ASC',rar:`${RARITY_RANK},name ASC`,col:'CAST(set_code AS INTEGER) ASC,CAST(cnum AS INTEGER) ASC'};
  const srt=sm[document.getElementById('srt').value]||'name ASC';
  const res=db.exec(`SELECT * FROM ${from} ${w} ORDER BY ${srt} LIMIT ${PG} OFFSET ${(pg-1)*PG}`,allP);
  if(!res[0])return[];const{columns,values}=res[0];return values.map(r=>{const o={};columns.forEach((col,i)=>o[col]=r[i]);return o});
}

// ═══════════════════════════════════════════════════════════════════
// DECK PICKER RENDER
// ═══════════════════════════════════════════════════════════════════
function toggleDeckFilter(which){
  dDeckFilter=dDeckFilter===which?null:which;
  document.getElementById('dFiltDeck').classList.toggle('on',dDeckFilter==='deck');
  document.getElementById('dFiltSB').classList.toggle('on',dDeckFilter==='sideboard');
  dpage=1;drun();
}

function drun(){
  if(!db)return;
  const tot=drunQ(DF,true,dpage);
  const cards=drunQ(DF,false,dpage);
  const deck=getCurDeck();
  renderCards(cards,'dgrid','dgbtn','dlbtn',dview,true,deck);
  renderPag(tot,dpage,p=>{dpage=p;drun();},document.getElementById('deckBuilder'));
  document.getElementById('drc').textContent=`${tot.toLocaleString()} cards`;
}

function drunQ(f,cnt,pg){
  const [from,fromP]=buildFrom(f.rarity);
  const c=[],p=[];

  // When a deck/sideboard filter is active, restrict to those card IDs only
  if(dDeckFilter){
    const deck=getCurDeck();
    const ids=deck?Object.keys(dDeckFilter==='sideboard'?(deck.sideboard||{}):deck.cards):[];
    if(!ids.length){
      // No cards in that pool — return nothing
      if(cnt)return 0;
      return[];
    }
    c.push(`id IN(${ids.map(()=>'?').join(',')})`);p.push(...ids);
  }

  if(f.q){c.push(`(name LIKE ? OR version LIKE ? OR ctxt LIKE ? OR flavor LIKE ? OR classes LIKE ?)`);const s=`%${f.q}%`;p.push(s,s,s,s,s)}
  if(f.ink.size){c.push(`ink IN(${[...f.ink].map(()=>'?').join(',')})`);p.push(...f.ink)}
  const typeClauses=[];
  if(f.type.size){f.type.forEach(t=>{typeClauses.push(`types LIKE ?`);p.push(`%"${t}"%`)})}
  if(f.typeExact&&f.typeExact.size){f.typeExact.forEach(t=>{typeClauses.push(`(json_array_length(types)=1 AND types LIKE ?)`);p.push(`%"${t}"%`)})}
  if(typeClauses.length)c.push(`(${typeClauses.join(' OR ')})`);
  if(f.classification&&f.classification.size){c.push(`(${[...f.classification].map(()=>'classes LIKE ?').join(' OR ')})`);f.classification.forEach(cl=>p.push(`%"${cl}"%`))}
  if(f.set.size){
    if(f.rarity&&f.rarity.size>0){
      c.push(`set_code IN(${[...f.set].map(()=>'?').join(',')})`);p.push(...f.set);
    } else {
      const ph=[...f.set].map(()=>'?').join(',');
      c.push(`EXISTS(SELECT 1 FROM cards p WHERE p.name=card_canonical.name AND COALESCE(p.version,'')=COALESCE(card_canonical.version,'') AND p.set_code IN(${ph}))`);
      p.push(...f.set);
    }
  }
  if(f.inkwell!==null){c.push(`inkwell=?`);p.push(+f.inkwell)}
  c.push(`(cost>=? AND (cost<=? OR ?>=10))`);p.push(f.cmin,f.cmax,f.cmax);
  if(f.lmin!==null){c.push(`lore>=? AND lore<=?`);p.push(f.lmin,f.lmax)}
  if(f.smin!==null){c.push(`str>=? AND str<=?`);p.push(f.smin,f.smax)}
  if(f.wmin!==null){c.push(`wil>=? AND wil<=?`);p.push(f.wmin,f.wmax)}
  if(f.keywords&&f.keywords.size){c.push(`(${[...f.keywords].map(()=>'keywords LIKE ?').join(' AND ')})`);f.keywords.forEach(k=>p.push(`%"${k}"%`))}
  const w=c.length?'WHERE '+c.join(' AND '):'';
  const allP=[...fromP,...p];
  if(cnt){const r=db.exec(`SELECT COUNT(*) FROM ${from} ${w}`,allP);return r[0]?.values[0][0]||0}
  const sm={na:'name ASC,version ASC',nd:'name DESC',ca:'cost ASC,name ASC',cd:'cost DESC,name ASC',rar:`${RARITY_RANK},name ASC`};
  const srt=sm[document.getElementById('dsrt').value]||'name ASC';
  const res=db.exec(`SELECT * FROM ${from} ${w} ORDER BY ${srt} LIMIT ${PG} OFFSET ${(pg-1)*PG}`,allP);
  if(!res[0])return[];const{columns,values}=res[0];return values.map(r=>{const o={};columns.forEach((col,i)=>o[col]=r[i]);return o});
}

// ═══════════════════════════════════════════════════════════════════
// CARD RENDERING (shared)
// ═══════════════════════════════════════════════════════════════════

// ── INK SVG ICONS ─────────────────────────────────────────────────
// Each Lorcana ink has a distinct icon shape. We render them as inline SVGs.
const INK_SVG={
  Amber:`<svg class="ink-icon" width="12" height="12" viewBox="0 0 24 24"><path fill="#f59e0b" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  Amethyst:`<svg class="ink-icon" width="12" height="12" viewBox="0 0 24 24"><path fill="#a855f7" d="M12 2L2 8l2 13h16l2-13L12 2zm0 3.5l7 4.5-1.5 9.5h-11L5 10l7-4.5z"/></svg>`,
  Emerald:`<svg class="ink-icon" width="12" height="12" viewBox="0 0 24 24"><path fill="#10b981" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>`,
  Ruby:`<svg class="ink-icon" width="12" height="12" viewBox="0 0 24 24"><path fill="#ef4444" d="M12 2L4 8l1 6 7 8 7-8 1-6-8-6z"/></svg>`,
  Sapphire:`<svg class="ink-icon" width="12" height="12" viewBox="0 0 24 24"><path fill="#3b82f6" d="M12 2L2 7l2.5 8L12 22l7.5-7L22 7 12 2zm0 3.5L19 8l-1.8 5.5L12 18l-5.2-4.5L5 8l7-2.5z"/></svg>`,
  Steel:`<svg class="ink-icon" width="12" height="12" viewBox="0 0 24 24"><path fill="#94a3b8" d="M12 2L4 6v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4zm0 2.18l6 3V12c0 4.52-3.14 8.74-6 10-2.86-1.26-6-5.48-6-10V7.18l6-3z"/></svg>`
};

function inkIcon(ink,size=12){
  if(!ink||!INK_SVG[ink])return`<div class="ib" style="background:${IC[ink]||'#888'};width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0"></div>`;
  return INK_SVG[ink].replace(/width="12"/,`width="${size}"`).replace(/height="12"/,`height="${size}"`);
}

function fmtPrice(p){return p?`$${parseFloat(p).toFixed(2)}`:''}

// ── HOVER PREVIEW ─────────────────────────────────────────────────
const pv=document.getElementById('cardPreview');
let pvTimer=null;

function showPreview(card,el){
  clearTimeout(pvTimer);
  pvTimer=setTimeout(()=>{
    document.getElementById('pvImg').src=card.img_n||card.img_l||'';
    document.getElementById('pvName').textContent=card.name||'';
    document.getElementById('pvVer').textContent=card.version||'';
    const rar=card.rarity||'Common';
    document.getElementById('pvChips').innerHTML=`
      ${card.ink?`<span class="mc ink" style="background:${IC[card.ink]};color:#000;padding:1px 7px;border-radius:99px;font-family:'DM Mono',monospace;font-size:.6rem">◆ ${card.ink}</span>`:''}
      <span class="mc ${RC[rar]||''}" style="border-color:currentColor;font-family:'DM Mono',monospace;font-size:.6rem;padding:1px 7px;border-radius:99px;border:1px solid">${rar.replace('_',' ')}</span>`;
    const stats=[];
    if(card.cost!=null)stats.push(['Cost',card.cost]);
    if(card.str!=null)stats.push(['STR',card.str]);
    if(card.wil!=null)stats.push(['WIL',card.wil]);
    if(card.lore!=null)stats.push(['Lore',card.lore]);
    document.getElementById('pvStats').innerHTML=stats.map(([l,v])=>`<div class="pv-stat"><div class="pv-stat-l">${l}</div><div class="pv-stat-v">${v}</div></div>`).join('');
    document.getElementById('pvText').innerHTML=card.ctxt?ftxt(card.ctxt):'';
    document.getElementById('pvPrice').textContent=card.price_usd?`$${parseFloat(card.price_usd).toFixed(2)}`:'';
    positionPreview(el);
    pv.classList.add('show');
  },350);
}

function hidePreview(){
  clearTimeout(pvTimer);
  pv.classList.remove('show');
}

function positionPreview(el){
  const r=el.getBoundingClientRect();
  const pw=340,ph=280;
  let left=r.right+10,top=r.top;
  if(left+pw>window.innerWidth)left=r.left-pw-10;
  if(top+ph>window.innerHeight)top=window.innerHeight-ph-10;
  if(top<8)top=8;
  pv.style.left=left+'px';pv.style.top=top+'px';
}

function renderCards(cards,gridId,gBtnId,lBtnId,v,deckMode,deck){
  const g=document.getElementById(gridId);
  g.innerHTML='';
  v==='l'?g.classList.add('lv'):g.classList.remove('lv');
  if(!cards.length){g.innerHTML=`<div class="empty"><div style="font-size:2rem">✦</div><div>No cards found.</div></div>`;return}
  // In browse mode, show which cards are in the active deck
  const activeDeck=getCurDeck();
  const deckCardIds=deck?new Set(Object.keys(deck.cards)):activeDeck?new Set(Object.keys(activeDeck.cards)):new Set();
  const sbCardIds=deck?new Set(Object.keys(deck.sideboard||{})):activeDeck?new Set(Object.keys(activeDeck.sideboard||{})):new Set();
  for(const c of cards){
    const el=document.createElement('div');
    const isColl=coll.has(c.id);
    const inDeck=deckCardIds.has(c.id);
    const inSB=sbCardIds.has(c.id);
    const qty=deck&&deck.cards[c.id]?(deck.cards[c.id]?.qty??deck.cards[c.id]):activeDeck&&activeDeck.cards[c.id]?(activeDeck.cards[c.id]?.qty??activeDeck.cards[c.id]):0;
    const sbQty=deck&&deck.sideboard?.[c.id]?(deck.sideboard[c.id]?.qty??deck.sideboard[c.id]):activeDeck&&activeDeck.sideboard?.[c.id]?(activeDeck.sideboard[c.id]?.qty??activeDeck.sideboard[c.id]):0;
    el.className='ci'+(isColl&&!deckMode?' coll':'')+(inDeck&&deckMode?' in-deck':'')+(inDeck&&!deckMode?' browsing-in-deck':'');
    const rar=c.rarity||'Common';
    const img=v==='l'?c.img_s:c.img_n;
    const imgH=img?`<img src="${h(img)}" alt="${h(c.name)}" loading="lazy" onerror="this.style.display='none';this.nextSibling&&(this.nextSibling.style.display='flex')">`:'';
    const ph=`<div class="iph"${img?' style="display:none"':''}>✦</div>`;
    const price=c.price_usd?`<span class="price-badge">$${parseFloat(c.price_usd).toFixed(2)}</span>`:'';

    if(v==='g'){
      el.innerHTML=`<div class="iw">${imgH}${ph}</div>
      <div class="cinfo">
        <div class="cn">${h(c.name)}</div>
        <div class="cv">${c.version?h(c.version):'&nbsp;'}</div>
        <div class="cm">
          ${c.ink?inkIcon(c.ink,9):''}
          <div class="rb ${RC[rar]||'rC'}">${RA[rar]||'?'}</div>
          ${c.cost!=null?`<div class="cb">${c.cost}◆</div>`:''}
          ${price}
        </div>
      </div>
      ${deckMode?`<div class="add-btn">
        <div class="deck-btn-add" onclick="event.stopPropagation();addToDeck('${c.id}')">＋ Add${qty>0?` (${qty})`:''}</div>
        ${qty>0?`<div class="deck-btn-remove" onclick="event.stopPropagation();removeFromDeck('${c.id}')">－ Remove</div>`:''}
        <div class="deck-btn-sb" onclick="event.stopPropagation();addToSideboard('${c.id}')" title="Add to sideboard">SB${sbQty>0?` (${sbQty})`:''}</div>
      </div><div class="cbadge">${qty||''}</div>`:`<div class="cbadge">✓</div>`}
      ${inDeck&&!deckMode?`<div class="deck-in-badge">${qty>1?qty+'×':'In deck'}</div>`:''}`;
    }else{
      el.innerHTML=`<div class="iw" style="border-radius:4px">${imgH}${ph}</div>
      <div class="cinfo">
        <div class="cn">${h(c.name)}${c.version?` &mdash; <em style="font-weight:300;color:var(--mut)">${h(c.version)}</em>`:''}</div>
        <div class="cm" style="margin-top:3px">
          ${c.ink?inkIcon(c.ink,9):''}
          <span style="font-family:'DM Mono',monospace;font-size:.58rem;color:var(--dim)">${JSON.parse(c.types||'[]').join(', ')}</span>
          <div class="rb ${RC[rar]||'rC'}">${RA[rar]||'?'}</div>
          ${price}
        </div>
      </div>
      <div class="lstats">
        ${c.cost!=null?`<div class="ls">Cost <b>${c.cost}</b></div>`:''}
        ${c.str!=null?`<div class="ls">STR <b>${c.str}</b></div>`:''}
        ${c.wil!=null?`<div class="ls">WIL <b>${c.wil}</b></div>`:''}
        ${c.lore!=null?`<div class="ls">Lore <b>${c.lore}</b></div>`:''}
      </div>
      ${deckMode?`<div style="flex-shrink:0;display:flex;align-items:center;gap:4px;margin-left:.5rem">
        <div class="qty-btn" onclick="event.stopPropagation();addToDeck('${c.id}')">+</div>
        ${qty?`<span class="qty-num">${qty}</span><div class="qty-btn" onclick="event.stopPropagation();removeFromDeck('${c.id}')">−</div>`:''}
      </div>`:`<div class="cbadge" style="position:static;margin-left:.4rem">${isColl?'✓':''}</div>`}`;
    }
    el.onclick=()=>openCard(c.id,deckMode);
    // Hover preview — only grid mode, only when not on mobile
    if(v==='g'&&window.matchMedia('(hover:hover)').matches){
      el.addEventListener('mouseenter',()=>showPreview(c,el));
      el.addEventListener('mouseleave',hidePreview);
    }
    g.appendChild(el);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PAGINATION (shared)
// ═══════════════════════════════════════════════════════════════════
function renderPag(tot,pg,setCb,scrollEl){
  const pagId=scrollEl===document.getElementById('cnt')?'pag':'dpag';
  const pag=document.getElementById(pagId);
  pag.innerHTML='';
  const tp=Math.ceil(tot/PG);if(tp<=1)return;
  const mk=(lbl,p,on,dis)=>{const b=document.createElement('button');b.className='pb'+(on?' on':'');b.textContent=lbl;b.disabled=!!dis;b.onclick=()=>{setCb(p);if(scrollEl)scrollEl.scrollTop=0};return b};
  pag.appendChild(mk('←',pg-1,false,pg===1));
  const nums=new Set([1,tp]);for(let i=Math.max(2,pg-2);i<=Math.min(tp-1,pg+2);i++)nums.add(i);
  let prev=null;[...nums].sort((a,b)=>a-b).forEach(n=>{if(prev!==null&&n-prev>1){const d=document.createElement('span');d.className='pi';d.textContent='…';pag.appendChild(d)}pag.appendChild(mk(n,n,n===pg));prev=n});
  pag.appendChild(mk('→',pg+1,false,pg===tp));
  const pi=document.createElement('span');pi.className='pi';pi.textContent=`${pg}/${tp}`;pag.appendChild(pi);
}

// ═══════════════════════════════════════════════════════════════════
// CARD DETAIL MODAL
// ═══════════════════════════════════════════════════════════════════
function openCard(id,deckMode){
  const r=db.exec('SELECT * FROM cards WHERE id=?',[id]);if(!r[0])return;
  const{columns,values}=r[0];const c={};columns.forEach((col,i)=>c[col]=values[0][i]);

  // Fetch all prints of this card (same name+version), normalizing NULL/''/whitespace as equivalent
  const printsRes=db.exec(
    `SELECT id,set_code,set_name,rarity,cnum,img_s,img_l FROM cards
     WHERE name=? AND COALESCE(version,'')=COALESCE(?,'')
     ORDER BY CAST(set_code AS INTEGER) ASC`,
    [c.name, c.version]
  );
  const prints=[];
  if(printsRes[0]){
    const{columns:pc,values:pv}=printsRes[0];
    pv.forEach(row=>{const o={};pc.forEach((col,i)=>o[col]=row[i]);prints.push(o)});
  }

  const types=JSON.parse(c.types||'[]');
  const rar=c.rarity||'Common';
  const isColl=coll.has(c.id);
  const inkSt=c.ink?`background:${IC[c.ink]};color:#000`:'';
  const hasSt=[c.cost,c.str,c.wil,c.lore].some(v=>v!=null);
  const deckHtml=(()=>{
    if(!deckMode||!curDeckId)return'';
    const deck=getCurDeck();if(!deck)return'';
    const e=cardEntry(deck,c.id);
    const qty=e?e.qty:0;
    const se=sbEntry(deck,c.id);
    const sqty=se?se.qty:0;
    return`<div class="deck-add-row" style="flex-direction:column;align-items:stretch;gap:.5rem">
      <div style="display:flex;align-items:center;gap:.5rem">
        <span style="font-family:'Cinzel',serif;font-size:.65rem;color:var(--mut);flex-shrink:0;width:64px">Deck</span>
        <div style="display:flex;align-items:center;gap:.4rem;flex:1">
          <div class="qty-btn" onclick="removeFromDeck('${c.id}');openCard('${c.id}',true)">−</div>
          <span class="qty-num" style="min-width:22px;text-align:center">${qty}</span>
          <div class="qty-btn" onclick="addToDeck('${c.id}');openCard('${c.id}',true)">+</div>
        </div>
        ${qty>0?`<button class="btn danger" style="font-size:.58rem;padding:.25rem .5rem" onclick="setDeckQty('${c.id}',0);openCard('${c.id}',true)">Remove all</button>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:.5rem">
        <span style="font-family:'Cinzel',serif;font-size:.65rem;color:rgba(99,102,241,.9);flex-shrink:0;width:64px">Sideboard</span>
        <div style="display:flex;align-items:center;gap:.4rem;flex:1">
          <div class="qty-btn" onclick="removeFromSideboard('${c.id}');openCard('${c.id}',true)">−</div>
          <span class="qty-num" style="min-width:22px;text-align:center">${sqty}</span>
          <div class="qty-btn" onclick="addToSideboard('${c.id}');openCard('${c.id}',true)">+</div>
        </div>
        ${sqty>0?`<button class="btn danger" style="font-size:.58rem;padding:.25rem .5rem" onclick="setSideboardQty('${c.id}',0);openCard('${c.id}',true)">Remove all</button>`:''}
      </div>
    </div>`;
  })();

  // Build printings HTML
  const printsHtml=prints.length>1?`
    <div class="mprints">
      <div class="mprints-lbl">Printings (${prints.length})</div>
      ${prints.map(p=>{
        const prar=p.rarity||'Common';
        const inColl=coll.has(p.id);
        return`<div class="mprint-row${p.id===id?' active-print':''}" onclick="switchPrint('${p.id}','${id}')" id="mpr_${p.id}">
          ${p.img_s?`<img class="mprint-thumb" src="${h(p.img_s)}" loading="lazy" onerror="this.style.display='none'">`:`<div class="mprint-thumb-ph">✦</div>`}
          <div class="mprint-info">
            <div class="mprint-set">${h(p.set_name||p.set_code)}</div>
            <div class="mprint-meta">#${h(p.cnum||'?')}</div>
          </div>
          <div class="mprint-rar ${RC[prar]||'rC'}">${RA[prar]||prar[0]}</div>
          <div class="mprint-collbadge${inColl?' on':''}" id="mpcb_${p.id}" title="In collection">✓</div>
        </div>`;
      }).join('')}
    </div>`
  :`<div class="msi"><span>Set: <b>${h(c.set_name||c.set_code||'—')}</b></span><span>No. <b>#${h(c.cnum||'?')}</b></span>${c.price_usd?`<span style="color:var(--green)">$${parseFloat(c.price_usd).toFixed(2)}</span>`:''}</div>`;

  document.getElementById('mimg').innerHTML=c.img_l
    ?`<img id="mimg-img" src="${h(c.img_l)}" alt="${h(c.name)}">`
    :`<div class="miph"><div style="font-size:2.5rem">✦</div><div style="font-family:'DM Mono',monospace;font-size:.7rem;color:var(--dim)">${h(c.name)}</div></div>`;

  document.getElementById('mbod').innerHTML=`
    <div><div class="mt">${h(c.name)}</div>${c.version?`<div class="mv">${h(c.version)}</div>`:''}</div>
    <div class="mch">
      ${c.ink?`<span class="mc ink" style="${inkSt};display:inline-flex;align-items:center;gap:3px">${inkIcon(c.ink,10)} ${c.ink}</span>`:''}
      <span class="mc ${RC[rar]||''}" style="border-color:currentColor">${rar.replace('_',' ')}</span>
      ${types.map(t=>`<span class="mc">${t}</span>`).join('')}
      ${c.inkwell?`<span class="mc" style="color:var(--al);border-color:var(--ad)">Inkable</span>`:''}
    </div>
    ${hasSt?`<div class="mst">
      ${c.cost!=null?`<div class="ms"><div class="msl">Cost</div><div class="msv">${c.cost}</div></div>`:''}
      ${c.str!=null?`<div class="ms"><div class="msl">Strength</div><div class="msv">${c.str}</div></div>`:''}
      ${c.wil!=null?`<div class="ms"><div class="msl">Willpower</div><div class="msv">${c.wil}</div></div>`:''}
      ${c.lore!=null?`<div class="ms"><div class="msl">Lore</div><div class="msv">${c.lore}</div></div>`:''}
    </div>`:''}
    ${c.ctxt?`<div class="mtxt">${ftxt(c.ctxt)}</div>`:''}
    ${c.flavor?`<div class="mfl">&ldquo;${h(c.flavor)}&rdquo;</div>`:''}
    ${printsHtml}
    ${deckHtml}
    <div class="ctog ${isColl?'on':''}" id="ctog" onclick="togCard('${c.id}')">
      <span class="cl2">${isColl?'In your collection':'Add to collection'}</span>
      <div class="ck">${isColl?'✓':''}</div>
    </div>`;

  document.getElementById('dmod').classList.remove('h');
}

// Switch which print is displayed in the modal image panel
function switchPrint(printId, originalId){
  // Update active highlight
  document.querySelectorAll('.mprint-row').forEach(r=>r.classList.remove('active-print'));
  const row=document.getElementById('mpr_'+printId);
  if(row)row.classList.add('active-print');
  // Swap image
  const pr=db.exec('SELECT img_l,name FROM cards WHERE id=?',[printId]);
  if(!pr[0])return;
  const img_l=pr[0].values[0][0], name=pr[0].values[0][1];
  const imgEl=document.getElementById('mimg-img');
  if(imgEl&&img_l){imgEl.src=img_l}
  else if(img_l){document.getElementById('mimg').innerHTML=`<img id="mimg-img" src="${h(img_l)}" alt="${h(name||'')}">`}
}
function ftxt(t){return h(t).replace(/\{I\}/g,'◆').replace(/\{E\}/g,'⟳').replace(/\{S\}/g,'✦').replace(/\n/g,'<br>')}
function cmod(){document.getElementById('dmod').classList.add('h')}
function cdmod(e){if(e.target===document.getElementById('dmod'))cmod()}

// ═══════════════════════════════════════════════════════════════════
// COLLECTION
// ═══════════════════════════════════════════════════════════════════
function togCard(id){
  coll.has(id)?coll.delete(id):coll.add(id);
  localStorage.setItem('lv_coll',JSON.stringify([...coll]));
  updColl();run();
  const tog=document.getElementById('ctog');
  if(tog){const on=coll.has(id);tog.classList.toggle('on',on);tog.querySelector('.cl2').textContent=on?'In your collection':'Add to collection';tog.querySelector('.ck').textContent=on?'✓':''}
  // refresh per-print badge if printings section is visible
  const cb=document.getElementById('mpcb_'+id);
  if(cb)cb.classList.toggle('on',coll.has(id));
}
function updColl(){document.getElementById('cpill').textContent=`${coll.size} collected`}
function togColl(){collOnly=!collOnly;const b=document.getElementById('cbtn');b.textContent=collOnly?'Show All':'Show Collected';b.classList.toggle('on',collOnly);page=1;run()}

// ═══════════════════════════════════════════════════════════════════
// IMPORT (collection)
// ═══════════════════════════════════════════════════════════════════
function openImp(){document.getElementById('imod').classList.remove('h');document.getElementById('ires').textContent='Paste your list then click Import.';document.getElementById('ires').className='ires'}
function closeImod(){document.getElementById('imod').classList.add('h')}
function cimod(e){if(e.target===document.getElementById('imod'))closeImod()}
function doImport(){
  const txt=document.getElementById('itxt').value.trim();if(!txt)return;
  const lines=txt.split('\n').map(l=>l.trim()).filter(Boolean);let matched=0,tot=0,nf=[];
  for(const line of lines){const m=line.match(/^(?:\d+\s*[xX×]\s*)?(.+)$/);if(!m)continue;tot++;const raw=m[1].trim();const di=raw.indexOf(' - ');const name=di>-1?raw.substring(0,di).trim():raw;const ver=di>-1?raw.substring(di+3).trim():null;let res;if(ver)res=db.exec(`SELECT id FROM cards WHERE LOWER(name)=LOWER(?) AND LOWER(version)=LOWER(?) LIMIT 1`,[name,ver]);else res=db.exec(`SELECT id FROM cards WHERE LOWER(name)=LOWER(?) LIMIT 1`,[name]);if(res[0]?.values[0]){coll.add(res[0].values[0][0]);matched++}else nf.push(raw)}
  localStorage.setItem('lv_coll',JSON.stringify([...coll]));updColl();run();
  const el=document.getElementById('ires');if(!nf.length){el.textContent=`✓ Matched ${matched}/${tot} cards.`;el.className='ires ok'}else{el.innerHTML=`Matched ${matched}/${tot}. Not found: ${nf.slice(0,4).map(n=>`<em>${h(n)}</em>`).join(', ')}${nf.length>4?` +${nf.length-4} more`:''}`;el.className=matched?'ires':'ires err'}
}

// ═══════════════════════════════════════════════════════════════════
// DECK MANAGER
// ═══════════════════════════════════════════════════════════════════
function getCurDeck(){return curDeckId?decks.find(d=>d.id===curDeckId):null}
function saveDecks(){localStorage.setItem('lv_decks',JSON.stringify(decks));updDeckBadge()}
function updDeckBadge(){const b=document.getElementById('deckCountBadge');b.textContent=decks.length?`(${decks.length})`:'';}

function toggleDeckStats(btn){
  const body=document.getElementById('deckStatsBody');
  const arr=btn.querySelector('.stats-toggle-arr');
  const open=body.classList.toggle('open');
  arr.classList.toggle('open',open);
  btn.setAttribute('aria-expanded',open);
}

function toggleBkClass(btn){
  const extra=document.getElementById('bkClassExtra');
  if(!extra)return;
  const open=extra.style.display==='none';
  extra.style.display=open?'block':'none';
  btn.textContent=open
    ?'Show less ▴'
    :`+ ${extra.children.length} more ▾`;
}

function createNewDeck(){
  const id='d_'+Date.now();
  const deck={id,name:'New Deck',cards:{},sideboard:{}};
  decks.push(deck);saveDecks();
  openDeckBuilder(id);
}

function openDeckBuilder(id){
  curDeckId=id;
  dDeckFilter=null;
  document.getElementById('dFiltDeck').classList.remove('on');
  document.getElementById('dFiltSB').classList.remove('on');
  document.getElementById('decksHome').style.display='none';
  document.getElementById('deckBuilder').style.display='flex';
  const deck=getCurDeck();
  document.getElementById('deckNameInput').value=deck?deck.name:'';
  DF.q=document.getElementById('srch').value.trim();
  dpage=1;drun();renderDeckPanel();
}

function backToDecks(){
  curDeckId=null;
  dDeckFilter=null;
  document.getElementById('dFiltDeck').classList.remove('on');
  document.getElementById('dFiltSB').classList.remove('on');
  document.getElementById('deckBuilder').style.display='none';
  document.getElementById('decksHome').style.display='block';
  renderDecksHome();
}

function renderDecksHome(){
  updDeckBadge();
  const el=document.getElementById('decksList');
  if(!decks.length){el.innerHTML=`<div class="deck-empty"><div style="font-size:2rem">✦</div><div>No decks yet. Create one to get started!</div></div>`;return}
  el.innerHTML=decks.map(d=>{
    const tot=Object.values(d.cards).reduce((a,b)=>a+(b?.qty??b),0);
    const inks=getDeckInks(d);
    return `<div class="deck-card" onclick="openDeckBuilder('${d.id}')">
      <div class="deck-card-title">${h(d.name)}</div>
      <div class="deck-card-meta">${tot} card${tot!==1?'s':''} · ${Object.keys(d.cards).length} unique</div>
      <div class="deck-card-inks">${inks.map(ink=>inkIcon(ink,12)).join('')}</div>
      <div class="deck-card-actions" onclick="event.stopPropagation()">
        <button class="btn" onclick="openDeckBuilder('${d.id}')" style="font-size:.63rem;padding:.3rem .6rem">Edit</button>
        <button class="btn danger" onclick="deleteDeck('${d.id}')" style="font-size:.63rem;padding:.3rem .6rem">Delete</button>
        <button class="btn" onclick="exportDeck('${d.id}')" style="font-size:.63rem;padding:.3rem .6rem">Export</button>
      </div>
    </div>`;
  }).join('');
}

function getDeckInks(deck){
  const inks=new Set();
  Object.keys(deck.cards).forEach(id=>{const r=db.exec('SELECT ink FROM cards WHERE id=?',[id]);if(r[0]?.values[0]?.[0])inks.add(r[0].values[0][0])});
  return[...inks];
}

function saveDeck(){
  const deck=getCurDeck();if(!deck)return;
  deck.name=document.getElementById('deckNameInput').value.trim()||'Untitled Deck';
  saveDecks();
  // brief visual feedback
  const btn=event.target;const orig=btn.textContent;btn.textContent='Saved!';setTimeout(()=>btn.textContent=orig,1200);
}

function deleteCurDeck(){
  if(!curDeckId)return;
  if(!confirm('Delete this deck?'))return;
  deleteDeck(curDeckId);backToDecks();
}

function deleteDeck(id){decks=decks.filter(d=>d.id!==id);saveDecks();renderDecksHome()}

// ── DECK CARD MANAGEMENT ──
// Deck card values are {qty, foil}. Migrate legacy plain-number entries on access.

function addToDeck(cardId){
  const deck=getCurDeck();if(!deck)return;
  const e=cardEntry(deck,cardId);
  deck.cards[cardId]=e?{qty:e.qty+1,foil:e.foil}:{qty:1,foil:false};
  saveDecks();renderDeckPanel();drun();
}

function removeFromDeck(cardId){
  const deck=getCurDeck();if(!deck)return;
  const e=cardEntry(deck,cardId);if(!e)return;
  if(e.qty>1)deck.cards[cardId]={qty:e.qty-1,foil:e.foil};
  else delete deck.cards[cardId];
  saveDecks();renderDeckPanel();drun();
}

function setDeckQty(cardId,qty){
  const deck=getCurDeck();if(!deck)return;
  qty=parseInt(qty)||0;
  if(qty<=0)delete deck.cards[cardId];
  else{const e=cardEntry(deck,cardId);deck.cards[cardId]={qty,foil:e?e.foil:false};}
  saveDecks();renderDeckPanel();drun();
}

function setDeckFoil(cardId){
  const deck=getCurDeck();if(!deck)return;
  const e=cardEntry(deck,cardId);if(!e)return;
  deck.cards[cardId]={qty:e.qty,foil:!e.foil};
  saveDecks();renderDeckPanel();drun();
}

// ── SIDEBOARD MANAGEMENT ──
function addToSideboard(cardId){
  const deck=getCurDeck();if(!deck)return;
  if(!deck.sideboard)deck.sideboard={};
  const e=sbEntry(deck,cardId);
  deck.sideboard[cardId]=e?{qty:e.qty+1,foil:e.foil}:{qty:1,foil:false};
  saveDecks();renderDeckPanel();drun();
}
function removeFromSideboard(cardId){
  const deck=getCurDeck();if(!deck)return;
  const e=sbEntry(deck,cardId);if(!e)return;
  if(e.qty>1)deck.sideboard[cardId]={qty:e.qty-1,foil:e.foil};
  else delete deck.sideboard[cardId];
  saveDecks();renderDeckPanel();drun();
}
function setSideboardQty(cardId,qty){
  const deck=getCurDeck();if(!deck)return;
  qty=parseInt(qty)||0;
  if(qty<=0)delete deck.sideboard[cardId];
  else{const e=sbEntry(deck,cardId);deck.sideboard[cardId]={qty,foil:e?e.foil:false};}
  saveDecks();renderDeckPanel();drun();
}
function setSideboardFoil(cardId){
  const deck=getCurDeck();if(!deck)return;
  const e=sbEntry(deck,cardId);if(!e)return;
  deck.sideboard[cardId]={qty:e.qty,foil:!e.foil};
  saveDecks();renderDeckPanel();drun();
}

// ── DECK PANEL RENDER ──
function renderDeckPanel(){
  const deck=getCurDeck();if(!deck)return;
  // Always read fresh from deck.cards — never cache entries before mutations
  const entries=Object.entries(deck.cards).map(([id,v])=>[id,typeof v==='number'?{qty:v,foil:false}:v]);
  const totalCards=entries.reduce((s,[,e])=>s+(+e.qty||0),0);
  const uniq=entries.length;

  // get card data for all entries
  const cardData={};
  if(entries.length){
    const ids=entries.map(([id])=>`'${id}'`).join(',');
    const res=db.exec(`SELECT id,name,version,ink,cost,rarity,img_s,types,classes FROM cards WHERE id IN(${ids})`);
    if(res[0]){const{columns,values}=res[0];values.forEach(r=>{const o={};columns.forEach((c,i)=>o[c]=r[i]);cardData[o.id]=o})}
  }

  // avg cost (only cards that have a cost)
  let totalCost=0,costCount=0;
  entries.forEach(([id,e])=>{const c=cardData[id];if(c&&c.cost!=null){totalCost+=c.cost*e.qty;costCount+=e.qty}});
  const avgCost=costCount>0?(totalCost/costCount).toFixed(1):'—';

  // ink counts
  const inkCounts={};
  entries.forEach(([id,e])=>{const c=cardData[id];if(c?.ink){inkCounts[c.ink]=(inkCounts[c.ink]||0)+e.qty}});
  const inkKeys=Object.keys(inkCounts);

  // update stats — read totalCards/uniq fresh from deck.cards to guarantee accuracy
  const displayTotal=Object.values(deck.cards).reduce((s,v)=>s+(+(v?.qty??v)||0),0);
  const displayUniq=Object.keys(deck.cards).length;
  document.getElementById('dsTot').textContent=displayTotal;
  document.getElementById('dsUniq').textContent=displayUniq;
  document.getElementById('dsAvg').textContent=avgCost;
  document.getElementById('dsInks').textContent=inkKeys.length||'—';

  // ink curve (cost 0–10+) — colored by ink composition at each cost slot
  const curveByInk=Array.from({length:11},()=>({}));
  entries.forEach(([id,e])=>{
    const c=cardData[id];if(c?.cost==null)return;
    const slot=Math.min(10,c.cost);
    const ink=c.ink||'_none';
    curveByInk[slot][ink]=(curveByInk[slot][ink]||0)+e.qty;
  });
  const curve=curveByInk.map(slot=>Object.values(slot).reduce((a,b)=>a+b,0));
  const maxCurve=Math.max(...curve,1);
  const barsEl=document.getElementById('curveBars');
  barsEl.innerHTML=curve.map((v,i)=>{
    const slotInks=curveByInk[i];
    // Build stacked colored segments inside the bar
    const segments=Object.entries(slotInks).sort((a,b)=>b[1]-a[1]).map(([ink,cnt])=>{
      const color=IC[ink]||'var(--amber-d)';
      const pct=Math.round((cnt/v)*100);
      return`<div style="height:${pct}%;background:${color};min-height:1px"></div>`;
    }).join('');
    return`<div class="curve-bar-wrap">
      <div class="curve-bar-val">${v||''}</div>
      <div class="curve-bar" style="height:${Math.round((v/maxCurve)*44)}px;background:var(--s3);overflow:hidden;display:flex;flex-direction:column-reverse">${v?segments:''}</div>
      <div class="curve-bar-lbl">${i===10?'10+':i}</div>
    </div>`;
  }).join('');

  // ink composition — use ink icons
  const inkEl=document.getElementById('inkComp');
  inkEl.innerHTML=Object.entries(inkCounts).sort((a,b)=>b[1]-a[1]).map(([ink,cnt])=>
    `<div class="ink-seg">${inkIcon(ink,8)}<span>${ink}</span> ${cnt}</div>`
  ).join('');

  // ── type & classification breakdown ──
  const typeCounts={}, classCounts={};
  entries.forEach(([id,e])=>{
    const c=cardData[id];if(!c)return;
    try{JSON.parse(c.types||'[]').forEach(t=>{typeCounts[t]=(typeCounts[t]||0)+e.qty})}catch{}
    try{
      const types=JSON.parse(c.types||'[]');
      if(types.includes('Character')){
        JSON.parse(c.classes||'[]').forEach(cl=>{classCounts[cl]=(classCounts[cl]||0)+e.qty});
      }
    }catch{}
  });

  const bkEl=document.getElementById('deckBreakdown');
  if(!Object.keys(typeCounts).length){bkEl.innerHTML='';return;}

  // Card types — pill chips (name + count, no bar), like ink-seg
  const typeItems=Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]);
  const typePills=typeItems.map(([label,cnt])=>
    `<div class="type-seg">${h(label)} <b>${cnt}</b></div>`
  ).join('');

  // Classifications — bar rows, sort by count desc, show top 12
  const classItems=Object.entries(classCounts).sort((a,b)=>b[1]-a[1]);
  const maxClass=Math.max(...classItems.map(([,v])=>v),1);
  const SHOW=5;
  const visClasses=classItems.slice(0,SHOW);
  const hidClasses=classItems.slice(SHOW);
  const hiddenCount=hidClasses.length;

  function classBarsHtml(items){
    return items.map(([label,cnt])=>`
      <div class="bk-row">
        <div class="bk-name" title="${h(label)}">${h(label)}</div>
        <div class="bk-bar-track"><div class="bk-bar-fill" style="width:${Math.round((cnt/maxClass)*100)}%;background:var(--ip)"></div></div>
        <div class="bk-count">${cnt}</div>
      </div>`).join('');
  }

  bkEl.innerHTML=`
    <div class="bk-section" style="padding:.45rem 0 0">
      <div class="bk-label" style="padding:0 1rem .3rem">Card Types</div>
      <div class="type-chips">${typePills}</div>
    </div>
    ${classItems.length?`
    <div class="bk-section" style="padding:.1rem 1rem .5rem">
      <div class="bk-label" style="margin-bottom:.4rem">Classifications</div>
      ${classBarsHtml(visClasses)}
      ${hiddenCount>0?`
        <div id="bkClassExtra" style="display:none">${classBarsHtml(hidClasses)}</div>
        <button onclick="toggleBkClass(this)" style="font-family:'DM Mono',monospace;font-size:.6rem;color:var(--amber);background:none;border:none;cursor:pointer;padding:.2rem 0;text-align:left">
          + ${hiddenCount} more ▾
        </button>`:''}
    </div>`:''}
  `;

  // deck list sorted by cost then name
  const sorted=entries.sort(([ia],[ib])=>{
    const ca=cardData[ia],cb=cardData[ib];
    if((ca?.cost??99)<(cb?.cost??99))return -1;
    if((ca?.cost??99)>(cb?.cost??99))return 1;
    return(ca?.name||'').localeCompare(cb?.name||'');
  });

  const listEl=document.getElementById('deckList');
  if(!sorted.length){listEl.innerHTML=`<div class="deck-empty"><div style="font-size:1.5rem">✦</div><div>No cards yet.<br>Click cards on the left to add them.</div></div>`;}
  else{
    listEl.innerHTML=sorted.map(([id,e])=>{
      const c=cardData[id];if(!c)return'';
      const rar=c.rarity||'Common';
      return`<div class="dk-entry">
        ${c.img_s?`<img class="dk-thumb" src="${h(c.img_s)}" loading="lazy" onerror="this.style.display='none'">`:`<div class="dk-thumb-ph">✦</div>`}
        <div class="dk-name">
          <div class="cn" style="font-size:.65rem">${h(c.name)}</div>
          <div class="cv" style="font-size:.57rem">${c.version?h(c.version):'&nbsp;'}</div>
          <div style="display:flex;align-items:center;gap:3px;margin-top:2px">
            ${c.ink?inkIcon(c.ink,9):''}
            <span class="rb ${RC[rar]||'rC'}" style="font-size:.5rem;padding:0 3px">${RA[rar]||'?'}</span>
            ${c.cost!=null?`<span style="font-family:'DM Mono',monospace;font-size:.55rem;color:var(--dim)">${c.cost}◆</span>`:''}
          </div>
        </div>
        <button class="foil-btn${e.foil?' on':''}" onclick="setDeckFoil('${id}')" title="${e.foil?'Foil — click to remove':'Non-foil — click to mark as foil'}">${e.foil?'✦ Foil':'Foil'}</button>
        <div class="dk-qty">
          <div class="qty-btn" onclick="removeFromDeck('${id}')">−</div>
          <span class="qty-num">${e.qty}</span>
          <div class="qty-btn" onclick="addToDeck('${id}')">+</div>
        </div>
        <button class="dk-remove" onclick="setDeckQty('${id}',0)" title="Remove">✕</button>
      </div>`;
    }).join('');
  }

  // ── SIDEBOARD ──
  const sbEntries=Object.entries(deck.sideboard||{}).map(([id,v])=>[id,typeof v==='number'?{qty:v,foil:false}:v]);
  const sbEl=document.getElementById('deckSideboard');

  if(!sbEntries.length){sbEl.innerHTML='';return;}

  // Fetch card data for sideboard entries
  const sbData={};
  const sbIds=sbEntries.map(([id])=>`'${id}'`).join(',');
  const sbRes=db.exec(`SELECT id,name,version,ink,cost,rarity,img_s FROM cards WHERE id IN(${sbIds})`);
  if(sbRes[0]){const{columns,values}=sbRes[0];values.forEach(r=>{const o={};columns.forEach((c,i)=>o[c]=r[i]);sbData[o.id]=o})}

  const sbSorted=sbEntries.sort(([ia],[ib])=>{
    const ca=sbData[ia],cb=sbData[ib];
    if((ca?.cost??99)<(cb?.cost??99))return -1;
    if((ca?.cost??99)>(cb?.cost??99))return 1;
    return(ca?.name||'').localeCompare(cb?.name||'');
  });
  const sbTotal=sbEntries.reduce((s,[,e])=>s+e.qty,0);

  sbEl.innerHTML=`<div class="sb-section">
    <div class="sb-header">
      <span>Sideboard</span>
      <span class="sb-count">${sbTotal} card${sbTotal!==1?'s':''}</span>
    </div>
    <div class="sb-list">${sbSorted.map(([id,e])=>{
      const c=sbData[id];if(!c)return'';
      const rar=c.rarity||'Common';
      return`<div class="dk-entry">
        ${c.img_s?`<img class="dk-thumb" src="${h(c.img_s)}" loading="lazy" onerror="this.style.display='none'">`:`<div class="dk-thumb-ph">✦</div>`}
        <div class="dk-name">
          <div class="cn" style="font-size:.65rem">${h(c.name)}</div>
          <div class="cv" style="font-size:.57rem">${c.version?h(c.version):'&nbsp;'}</div>
          <div style="display:flex;align-items:center;gap:3px;margin-top:2px">
            ${c.ink?inkIcon(c.ink,9):''}
            <span class="rb ${RC[rar]||'rC'}" style="font-size:.5rem;padding:0 3px">${RA[rar]||'?'}</span>
            ${c.cost!=null?`<span style="font-family:'DM Mono',monospace;font-size:.55rem;color:var(--dim)">${c.cost}◆</span>`:''}
          </div>
        </div>
        <button class="foil-btn${e.foil?' on':''}" onclick="setSideboardFoil('${id}')" title="${e.foil?'Foil':'Non-foil'}">${e.foil?'✦ Foil':'Foil'}</button>
        <div class="dk-qty">
          <div class="qty-btn" onclick="removeFromSideboard('${id}')">−</div>
          <span class="qty-num">${e.qty}</span>
          <div class="qty-btn" onclick="addToSideboard('${id}')">+</div>
        </div>
        <button class="dk-remove" onclick="setSideboardQty('${id}',0)" title="Remove">✕</button>
      </div>`;
    }).join('')}</div>
  </div>`;
}

// ── DECK EXPORT ──
function getDeckText(deck){
  if(!deck)return'';
  const entries=Object.entries(deck.cards);
  const sbEntries=Object.entries(deck.sideboard||{});
  const allIds=[...new Set([...entries.map(([id])=>id),...sbEntries.map(([id])=>id)])];
  if(!allIds.length)return'';
  const cardData={};
  const res=db.exec(`SELECT id,name,version FROM cards WHERE id IN(${allIds.map(()=>'?').join(',')})`,allIds);
  if(res[0]){const{columns,values}=res[0];values.forEach(r=>{const o={};columns.forEach((c,i)=>o[c]=r[i]);cardData[o.id]=o})}
  const fmt=([id,v])=>{
    const c=cardData[id];if(!c)return'';
    const e=typeof v==='number'?{qty:v,foil:false}:v;
    return`${e.qty}x ${c.name}${c.version?' - '+c.version:''}${e.foil?' (foil)':''}`;
  };
  const mainLines=entries.map(fmt).filter(Boolean).join('\n');
  const sbLines=sbEntries.map(fmt).filter(Boolean).join('\n');
  return mainLines+(sbLines?'\n\nSideboard:\n'+sbLines:'');
}

function exportDeckTxt(){
  const deck=getCurDeck();if(!deck)return;
  const txt=getDeckText(deck);if(!txt)return;
  const blob=new Blob([txt],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${deck.name.replace(/[^a-z0-9]/gi,'_')}.txt`;a.click();URL.revokeObjectURL(a.href);
}
function exportDeck(id){const deck=decks.find(d=>d.id===id);if(!deck)return;const txt=getDeckText(deck);if(!txt)return;const blob=new Blob([txt],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${deck.name.replace(/[^a-z0-9]/gi,'_')}.txt`;a.click();URL.revokeObjectURL(a.href)}
function copyDeckTxt(){const txt=getDeckText(getCurDeck());if(!txt)return;navigator.clipboard.writeText(txt).then(()=>{const btn=event.target;const orig=btn.textContent;btn.textContent='Copied!';setTimeout(()=>btn.textContent=orig,1400)})}

// ── DECK IMPORT ──
function openDeckImport(){document.getElementById('dimod').classList.remove('h');document.getElementById('dires').textContent='Paste a list then click Import.';document.getElementById('dires').className='ires'}
function closeDImod(){document.getElementById('dimod').classList.add('h')}
function doDeckImport(){
  const deck=getCurDeck();if(!deck)return;
  if(!deck.sideboard)deck.sideboard={};
  const txt=document.getElementById('ditxt').value.trim();if(!txt)return;
  const lines=txt.split('\n').map(l=>l.trim()).filter(Boolean);
  let matched=0,tot=0,nf=[];
  let isSB=false;
  for(const line of lines){
    if(/^sideboard:?$/i.test(line)){isSB=true;continue;}
    const m=line.match(/^(?:(\d+)\s*[xX×]\s*)?(.+)$/);if(!m)continue;tot++;
    const qty=parseInt(m[1]||'1'),raw=m[2].replace(/\(foil\)/i,'').trim();
    const di=raw.indexOf(' - ');const name=di>-1?raw.substring(0,di).trim():raw;const ver=di>-1?raw.substring(di+3).trim():null;
    let res;if(ver)res=db.exec(`SELECT id FROM cards WHERE LOWER(name)=LOWER(?) AND LOWER(version)=LOWER(?) LIMIT 1`,[name,ver]);
    else res=db.exec(`SELECT id FROM cards WHERE LOWER(name)=LOWER(?) LIMIT 1`,[name]);
    if(res[0]?.values[0]){
      const id=res[0].values[0][0];
      if(isSB){
        const cur=deck.sideboard[id];
        const curQty=cur?(typeof cur==='number'?cur:cur.qty):0;
        deck.sideboard[id]={qty:curQty+qty,foil:cur?.foil||false};
      }else{
        const cur=deck.cards[id];
        const curQty=cur?(typeof cur==='number'?cur:cur.qty):0;
        deck.cards[id]={qty:curQty+qty,foil:cur?.foil||false};
      }
      matched++;
    }else nf.push(raw);
  }
  saveDecks();renderDeckPanel();drun();
  const el=document.getElementById('dires');if(!nf.length){el.textContent=`✓ Added ${matched}/${tot} cards.`;el.className='ires ok'}else{el.innerHTML=`Added ${matched}/${tot}. Not found: ${nf.slice(0,4).map(n=>`<em>${h(n)}</em>`).join(', ')}${nf.length>4?` +${nf.length-4} more`:''}`;el.className=matched?'ires':'ires err'}
}

// ═══════════════════════════════════════════════════════════════════
// VIEW / SEARCH
// ═══════════════════════════════════════════════════════════════════
function sv(v){view=v;document.getElementById('gbtn').classList.toggle('on',v==='g');document.getElementById('lbtn').classList.toggle('on',v==='l');run()}
function dsv(v){dview=v;document.getElementById('dgbtn').classList.toggle('on',v==='g');document.getElementById('dlbtn').classList.toggle('on',v==='l');drun()}

let st;
document.getElementById('srch').addEventListener('input',e=>{
  clearTimeout(st);st=setTimeout(()=>{
    const q=e.target.value.trim();
    F.q=q;DF.q=q;
    page=1;dpage=1;
    if(curTab==='browse')run();
    else if(curDeckId)drun();
  },260);
});

document.addEventListener('keydown',e=>{if(e.key==='Escape'){cmod();closeImod();closeDImod()}});

// ═══════════════════════════════════════════════════════════════════
// DECK PANEL RESIZE
// ═══════════════════════════════════════════════════════════════════
(function(){
  const resizer=document.getElementById('deckResizer');
  if(!resizer)return;
  let dragging=false,startX=0,startW=0;

  function getPanel(){return document.querySelector('.deck-panel')}

  function onStart(clientX){
    const panel=getPanel();if(!panel)return;
    dragging=true;startX=clientX;startW=panel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
  }
  function onMove(clientX){
    if(!dragging)return;
    const panel=getPanel();if(!panel)return;
    const newW=Math.min(520,Math.max(220,startW+(startX-clientX)));
    panel.style.flexBasis=newW+'px';
  }
  function onEnd(){
    if(!dragging)return;
    dragging=false;
    resizer.classList.remove('dragging');
    document.body.style.cursor='';
    document.body.style.userSelect='';
  }

  resizer.addEventListener('mousedown',e=>{onStart(e.clientX);e.preventDefault()});
  document.addEventListener('mousemove',e=>{onMove(e.clientX)});
  document.addEventListener('mouseup',onEnd);

  resizer.addEventListener('touchstart',e=>{onStart(e.touches[0].clientX);e.preventDefault()},{passive:false});
  document.addEventListener('touchmove',e=>{if(dragging)onMove(e.touches[0].clientX)},{passive:true});
  document.addEventListener('touchend',onEnd);
})();

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
boot();
