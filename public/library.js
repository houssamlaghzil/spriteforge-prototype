
const $=id=>document.getElementById(id);
const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const hex=s=>/^#[0-9a-fA-F]{6}$/.test(s||"")?s:"#0a0f18";
const uuid=s=>/^[0-9a-f-]{36}$/.test(s||"")?s:"";
const fmtUsd=v=>"$"+(+v).toFixed(2);
const rel=iso=>{const s=(Date.now()-new Date(iso).getTime())/1000;
  if(s<60)return "à l’instant";
  if(s<3600)return "il y a "+Math.floor(s/60)+" min";
  if(s<86400)return "il y a "+Math.floor(s/3600)+" h";
  return new Intl.DateTimeFormat("fr-FR",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(iso))};
const full=iso=>new Intl.DateTimeFormat("fr-FR",{dateStyle:"full",timeStyle:"short"}).format(new Date(iso));
const sheetOf=g=>{
  if(g.sheet)return g.sheet;
  const [w,h]=(g.size||"1024x1024").split("x").map(Number),n=g.framesCompleted||g.framesRequested||24;
  const cols=Math.ceil(Math.sqrt(n));
  return {cols,rows:Math.ceil(n/cols),w,h,count:n};
};

function state(html){$("state").innerHTML=html}
function skeletons(){
  $("cards").innerHTML=Array.from({length:8},(_,i)=>'<div class="card skel" style="--i:'+i+'"><div class="thumb"></div><div class="cbody"><i></i><i class="w60"></i></div></div>').join("");
}

async function load(){
  skeletons();
  let r,list;
  try{r=await fetch("/api/generations");list=await r.json()}
  catch{$("cards").innerHTML="";return state('<div class="panel statecard"><b>Serveur injoignable</b><p>Impossible de contacter le serveur SpriteForge. Vérifie qu’il est démarré, puis recharge la page.</p></div>')}
  if(r.status===503){$("cards").innerHTML="";return state('<div class="panel statecard"><b>Archive non configurée</b><p>La Bibliothèque a besoin de MongoDB et MinIO. Lance la stack complète avec <code>docker compose up</code> — en local simple (<code>npm start</code>), les générations ne sont pas conservées.</p></div>')}
  if(!r.ok){$("cards").innerHTML="";return state('<div class="panel statecard"><b>Erreur</b><p>'+esc(list?.error||"Erreur serveur ("+r.status+")")+'</p></div>')}
  if(!list.length){$("cards").innerHTML="";return state('<div class="panel statecard empty"><b>Aucune génération archivée</b><p>Ta première animation t’attend : choisis un personnage, valide son gabarit, lance les frames.</p><a class="btn cta" href="/">Passer au Studio</a></div>')}
  state("");
  const done=list.filter(g=>g.status==="done");
  $("stTotal").textContent=list.length;
  $("stFrames").textContent=list.reduce((a,g)=>a+(g.framesCompleted||0),0);
  $("stCost").textContent=fmtUsd(done.reduce((a,g)=>a+(g.officialOutputEstimateUsd||0),0));
  $("libStats").hidden=false;
  $("cards").innerHTML=list.map((g,i)=>card(g,i)).join("");
  list.forEach(g=>wire(g));
}

// Docs d'ancien schéma (sans flags) : une génération réussie a toujours sa sprite
// sheet dans MinIO, mais pas de ZIP archivé ni de preview.
function avail(g){
  const ok=g.status==="done",st=g.storage||{};
  return {sprite:st.hasSprite??ok,zip:st.hasZip===true,preview:st.hasPreview===true&&!!g.previewSheet};
}

function card(g,i){
  const ok=g.status==="done";
  const st=avail(g);
  const id=uuid(g.jobId);
  const chip=ok?'<span class="chip ok">Réussie</span>':'<span class="chip part">Partielle · '+(+g.framesCompleted||0)+"/"+(+g.framesRequested||0)+"</span>";
  const cost=g.officialOutputEstimateUsd?" · "+fmtUsd(g.officialOutputEstimateUsd):"";
  const dur=g.durationMs?Math.round(g.durationMs/1000)+" s":"";
  return '<article class="card" style="--i:'+(+i)+';--cardbg:'+hex(g.background)+'" data-id="'+id+'">'
    +'<div class="thumb'+(st.sprite?" playable":"")+'"'+(st.sprite?' tabindex="0" role="button" aria-label="Rejouer l’animation"':"")+'>'
    +'<img loading="lazy" alt="" src="/api/generations/'+id+'/thumb">'
    +'<div class="hover-anim" hidden></div>'
    +chip+(st.sprite?'<span class="playhint">▶</span>':"")
    +'</div><div class="cbody">'
    +'<div class="crow1"><b>'+(+g.framesCompleted||0)+' frames</b><time title="'+esc(full(g.createdAt))+'">'+esc(rel(g.createdAt))+"</time></div>"
    +'<div class="crow2">'+esc(g.model)+" · "+esc(g.quality)+" · "+esc((g.size||"").replace("x","×"))+cost+(dur?" · "+dur:"")+"</div>"
    +'<div class="cact">'
    +(st.sprite?'<button class="btn play" type="button">▶ Rejouer</button>':'<span class="btn off" title="Sprite sheet non disponible pour cette génération">▶ Rejouer</span>')
    +(st.zip?'<a class="btn ghost" href="/api/generations/'+id+'/zip">⬇ ZIP</a>':"")
    +"</div></div></article>";
}

// Signature de la page : la carte s'anime au survol via la mini sprite sheet.
function wire(g){
  const el=document.querySelector('.card[data-id="'+uuid(g.jobId)+'"]');
  if(!el)return;
  const st=avail(g);
  if(st.sprite){
    el.querySelector(".btn.play").onclick=()=>openPlayer(g);
    const th=el.querySelector(".thumb");
    th.onclick=()=>openPlayer(g);
    th.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openPlayer(g)}};
  }
  if(!st.preview||reducedMotion)return;
  const ps=g.previewSheet,anim=el.querySelector(".hover-anim");
  let img=null,raf=0,idx=0,last=0;
  const stop=()=>{cancelAnimationFrame(raf);raf=0;anim.hidden=true};
  el.querySelector(".thumb").addEventListener("mouseenter",()=>{
    if(!img){
      img=new Image();
      img.onload=()=>{
        anim.style.backgroundImage="url('/api/generations/"+uuid(g.jobId)+"/preview')";
        anim.style.backgroundSize=(ps.cols*100)+"% auto";
      };
      img.src="/api/generations/"+uuid(g.jobId)+"/preview";
    }
    if(raf)return;
    const tick=t=>{
      raf=requestAnimationFrame(tick);
      if(!img.complete||t-last<1000/12)return;
      last=t;anim.hidden=false;
      anim.style.backgroundPosition=(ps.cols>1?(idx%ps.cols)/(ps.cols-1)*100:0)+"% "+(ps.rows>1?Math.floor(idx/ps.cols)/(ps.rows-1)*100:0)+"%";
      idx=(idx+1)%ps.count;
    };
    raf=requestAnimationFrame(tick);
  });
  el.querySelector(".thumb").addEventListener("mouseleave",stop);
}

// Lecteur plein format
let player=null,lastFocus=null;
function stopPlayer(){if(player){cancelAnimationFrame(player.raf);player=null}}
function closePlayer(){stopPlayer();$("pModal").hidden=true;document.body.style.overflow="";if(lastFocus)lastFocus.focus()}
$("pClose").onclick=closePlayer;
$("pBack").onclick=closePlayer;
addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("pModal").hidden)closePlayer()});
$("pFps").oninput=()=>$("pFpsVal").textContent=$("pFps").value+" img/s";
$("pZoom").oninput=()=>{const z=+$("pZoom").value;$("pZoomVal").textContent=z+"%";const cv=$("pCanvas");if(cv.width)cv.style.width=Math.round(cv.width*z/100)+"px"};
$("pPlay").onclick=()=>{if(!player)return;player.playing=!player.playing;$("pPlay").textContent=player.playing?"⏸ Pause":"▶ Lecture"};

function openPlayer(g){
  lastFocus=document.activeElement;
  const sheet=sheetOf(g);
  $("pTitle").textContent=g.framesCompleted+" frames · "+g.model;
  $("pMeta").textContent=g.quality+" · "+g.size.replace("x","×")+" · "+full(g.createdAt);
  $("pInfo").textContent="";
  $("pLoad").hidden=false;
  $("pModal").hidden=false;
  document.body.style.overflow="hidden";
  $("pClose").focus();
  stopPlayer();
  const cv=$("pCanvas"),ctx=cv.getContext("2d");
  ctx.clearRect(0,0,cv.width,cv.height);
  const img=new Image();
  img.onload=()=>{
    if($("pModal").hidden)return;
    $("pLoad").hidden=true;
    const scale=Math.min(1,560/sheet.w);
    cv.width=Math.round(sheet.w*scale);cv.height=Math.round(sheet.h*scale);
    cv.style.width=Math.round(cv.width*(+$("pZoom").value)/100)+"px";
    const st=player={raf:0,i:0,playing:true,last:0};
    $("pPlay").textContent="⏸ Pause";
    const tick=t=>{
      st.raf=requestAnimationFrame(tick);
      if(!st.playing||t-st.last<1000/+$("pFps").value)return;
      st.last=t;
      const sx=(st.i%sheet.cols)*sheet.w,sy=Math.floor(st.i/sheet.cols)*sheet.h;
      ctx.clearRect(0,0,cv.width,cv.height);
      ctx.drawImage(img,sx,sy,sheet.w,sheet.h,0,0,cv.width,cv.height);
      $("pInfo").textContent="frame "+(st.i+1)+"/"+sheet.count;
      st.i=(st.i+1)%sheet.count;
    };
    st.raf=requestAnimationFrame(tick);
  };
  img.onerror=()=>{$("pLoad").textContent="Impossible de charger la sprite sheet."};
  img.src="/api/generations/"+uuid(g.jobId)+"/sprite";
  $("pStage").style.background=hex(g.background);
}

load();
