
const P={
"gpt-image-2":{low:[.006,.005,.005],medium:[.053,.041,.041],high:[.211,.165,.165]},
"gpt-image-1.5":{low:[.009,.013,.013],medium:[.034,.05,.05],high:[.133,.2,.2]},
"gpt-image-1":{low:[.011,.016,.016],medium:[.042,.063,.063],high:[.167,.25,.25]},
"gpt-image-1-mini":{low:[.005,.006,.006],medium:[.011,.015,.015],high:[.036,.052,.052]}};
const sizes=["1024x1024","1024x1536","1536x1024"],$=id=>document.getElementById(id);
let emotion="neutral",templateId=null;
document.querySelectorAll("[data-e]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-e]").forEach(x=>x.classList.remove("on"));b.classList.add("on");emotion=b.dataset.e});
$("image").onchange=e=>{const f=e.target.files[0];if(!f)return;$("preview").src=URL.createObjectURL(f);$("preview").hidden=false;$("dropText").hidden=true;templateId=null;$("tplPanel").hidden=true;price()};
function price(){const m=$("model").value,q=$("quality").value,s=$("size").value,n=+$("frames").value,v=P[m][q][sizes.indexOf(s)],t=v*(n+1);$("per").textContent="$"+v.toFixed(3);$("total").textContent="$"+t.toFixed(3);$("bigCost").textContent="$"+t.toFixed(3);$("costMeta").textContent=n+" images + 1 gabarit · "+$("model").selectedOptions[0].text.split(" — ")[0];$("pipeline").textContent="1 gabarit + "+n+" générations (5 en parallèle)";$("go").textContent=templateId?"Générer "+n+" frames":"Générer le gabarit"}
["model","quality","size","frames"].forEach(id=>$(id).onchange=price);price();

const log=(lvl,...a)=>(console[lvl]||console.log)("[SpriteForge]",...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmtDur=s=>s>=60?Math.floor(s/60)+" min "+String(Math.round(s%60)).padStart(2,"0")+" s":Math.round(s)+" s";
async function readJson(r){try{return await r.json()}catch{return{}}}
function msg(t,c){$("msg").className=c;$("msg").textContent=t}

const PHASES={assembly:"assemblage de la sprite sheet et du ZIP…",archive:"archivage (MinIO + MongoDB)…"};
function setProgress(done,total,phase,t0){
  $("progress").hidden=false;
  $("pfill").style.width=(total?done/total*100:0)+"%";
  const elapsed=(Date.now()-t0)/1000;
  if(PHASES[phase]){$("ptext").textContent=done+"/"+total+" frames — "+PHASES[phase];$("peta").textContent=""}
  else{$("ptext").textContent=done+"/"+total+" frames · "+fmtDur(elapsed)+" écoulées";
    $("peta").textContent=done?"≈ "+fmtDur(elapsed/done*(total-done))+" restantes":"estimation en cours…"}
}

let animState=null;
function stopAnim(){if(animState){cancelAnimationFrame(animState.raf);animState=null}}
function applyZoom(){const z=+$("zoom").value;$("zoomVal").textContent=z+"%";const cv=$("anim");if(cv.width)cv.style.width=Math.round(cv.width*z/100)+"px"}
$("fps").oninput=()=>{$("fpsVal").textContent=$("fps").value+" img/s"};
$("zoom").oninput=applyZoom;
$("playBtn").onclick=()=>{if(!animState)return;animState.playing=!animState.playing;$("playBtn").textContent=animState.playing?"⏸ Pause":"▶ Lecture"};

function showPreview(id,sheet){
  if(!sheet)return;
  stopAnim();
  const img=new Image();
  img.onload=()=>{
    $("previewPanel").hidden=false;
    const cv=$("anim"),ctx=cv.getContext("2d");
    const scale=Math.min(1,640/sheet.w);
    cv.width=Math.round(sheet.w*scale);cv.height=Math.round(sheet.h*scale);
    applyZoom();
    const st=animState={img,sheet,i:0,playing:true,last:0,raf:0};
    $("playBtn").textContent="⏸ Pause";
    const tick=t=>{
      st.raf=requestAnimationFrame(tick);
      if(!st.playing||t-st.last<1000/+$("fps").value)return;
      st.last=t;
      const sx=(st.i%sheet.cols)*sheet.w,sy=Math.floor(st.i/sheet.cols)*sheet.h;
      ctx.clearRect(0,0,cv.width,cv.height);
      ctx.drawImage(img,sx,sy,sheet.w,sheet.h,0,0,cv.width,cv.height);
      $("frameInfo").textContent="frame "+(st.i+1)+"/"+sheet.count;
      st.i=(st.i+1)%sheet.count;
    };
    st.raf=requestAnimationFrame(tick);
    log("log","Aperçu de l'animation prêt ("+sheet.count+" frames, grille "+sheet.cols+"×"+sheet.rows+").");
    $("previewPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
  };
  img.onerror=()=>log("warn","Impossible de charger la sprite sheet pour l'aperçu.");
  img.src="/api/jobs/"+id+"/sprite";
}

function download(id){const a=document.createElement("a");a.href="/api/jobs/"+id+"/download";a.download="";document.body.appendChild(a);a.click();a.remove()}

async function track(id){
  const t0=Date.now();
  let printed=0,misses=0;
  setProgress(0,+$("frames").value,"generation",t0);
  msg("Génération en cours — progression ci-dessous, détails dans la console du navigateur (F12).","info");
  while(true){
    await sleep(1000);
    let r,s;
    try{r=await fetch("/api/jobs/"+id);s=await readJson(r)}
    catch{if(++misses>=10)throw new Error("Serveur injoignable pendant le suivi de la génération.");log("warn","Statut injoignable, nouvel essai…");continue}
    misses=0;
    if(!r.ok)throw new Error(s.error||"Erreur serveur (HTTP "+r.status+")");
    for(const l of(s.logs||[]).slice(printed))log(l.level==="error"?"error":l.level==="warn"?"warn":"log",l.text);
    printed=(s.logs||[]).length;
    setProgress(s.done,s.total,s.phase,t0);
    if(s.status==="done"){download(id);showPreview(id,s.sheet);msg("Terminé en "+fmtDur(s.durationMs/1000)+". ZIP téléchargé.","ok");return}
    if(s.status==="failed"){
      if(s.hasZip){download(id);msg(s.error+" — les "+s.done+" frames déjà générées ont été téléchargées.","err")}
      else msg(s.error||"La génération a échoué.","err");
      return;
    }
  }
}

function formData(){
  const d=new FormData();
  d.append("image",$("image").files[0]);d.append("apiKey",$("key").value);d.append("emotion",emotion);
  d.append("model",$("model").value);d.append("quality",$("quality").value);
  d.append("size",$("size").value);d.append("style",$("style").value);
  d.append("bg",$("bgcolor").value);
  return d;
}

function applyBg(){$("tplBox").style.background=$("bgcolor").value}
$("bgcolor").oninput=applyBg;

async function generateTemplate(){
  msg("Génération du gabarit (~30 s à 1 min)…","info");
  log("log","Génération du gabarit de référence…");
  const r=await fetch("/api/template",{method:"POST",body:formData()});
  const j=await readJson(r);
  if(!r.ok)throw new Error(j.error||"Erreur serveur (HTTP "+r.status+")");
  templateId=j.templateId;
  if(j.keyed)log("log","Modèle sans transparence native : fond uni imposé dans le prompt puis détouré au chroma côté serveur.");
  if(!j.usable)log("warn","Gabarit sans fond transparent exploitable : recadrage et normalisation couleur seront limités.");
  if(j.inputFidelity===false)log("warn","Ce modèle ne supporte pas input_fidelity : la fidélité du visage repose sur le gabarit seul (gpt-image-1.5 le supporte si besoin).");
  $("tplImg").src="/api/template/"+templateId+"/image";
  applyBg();
  $("tplPanel").hidden=false;
  $("tplPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
  log("log","Gabarit "+templateId+" prêt.");
  msg("Gabarit prêt. Vérifie l'identité et le cadrage ci-dessous, puis lance la génération des frames.","ok");
}

$("go").onclick=async()=>{
  const f=$("image").files[0];
  if(!f)return msg("Ajoute une image.","err");
  if(!$("key").value)return msg("Ajoute ta clé API.","err");
  const b=$("go");
  b.disabled=true;
  stopAnim();$("previewPanel").hidden=true;
  try{
    if(!templateId){
      b.textContent="Gabarit en cours…";
      await generateTemplate();
    }else{
      b.textContent="Génération en cours…";
      const d=formData();
      d.append("frames",$("frames").value);d.append("templateId",templateId);
      msg("Démarrage de la génération…","info");
      const r=await fetch("/api/generate",{method:"POST",body:d});
      const j=await readJson(r);
      if(!r.ok)throw new Error(j.error||"Erreur serveur (HTTP "+r.status+")");
      log("log","Job "+j.jobId+" démarré : "+j.total+" frames ancrées sur le gabarit, 5 requêtes en parallèle.");
      await track(j.jobId);
    }
  }catch(e){log("error",e);msg(e.message,"err")}
  finally{$("progress").hidden=true;b.disabled=false;price()}
};

$("tplRedo").onclick=async()=>{
  if(!$("image").files[0])return msg("Ajoute une image.","err");
  if(!$("key").value)return msg("Ajoute ta clé API.","err");
  const b=$("tplRedo");
  b.disabled=true;b.textContent="Gabarit en cours…";
  try{await generateTemplate()}catch(e){log("error",e);msg(e.message,"err")}
  finally{b.disabled=false;b.textContent="↻ Régénérer le gabarit";price()}
};
