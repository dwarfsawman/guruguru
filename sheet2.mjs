const BASE="http://127.0.0.1:5199";
const R=process.argv[2], OUT=process.argv[3];
const sharp=(await import("sharp")).default;
const {mkdirSync,writeFileSync}=await import("node:fs");
mkdirSync(OUT,{recursive:true});
const d=await (await fetch(`${BASE}/api/script-manga-runs/${R}`)).json();
const tasks=d.tasks??[];
const meta=[];
for (const [i,t] of tasks.entries()) {
  const ids=t.candidateAssetIds??[];
  const files=[];
  for (const [k,a] of ids.entries()) {
    const res=await fetch(`${BASE}/api/assets/${a}/image`);
    if(!res.ok) continue;
    const f=`${OUT}/p${String(i+1).padStart(2,"0")}_c${k+1}.png`;
    writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    files.push({file:f, assetId:a, idx:k+1});
  }
  meta.push({panel:i+1, taskId:t.id, panelId:t.panelId, pageId:t.pageId, candidates:files});
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(meta,null,2));
// one sheet per panel: its candidates side by side
const CW=470, CH=470;
for (const m of meta) {
  if(!m.candidates.length) continue;
  const n=m.candidates.length;
  const tiles=await Promise.all(m.candidates.map(async (c,i)=>({
    input: await sharp(c.file).resize(CW-8,CH-30,{fit:"contain",background:"#fff"}).toBuffer(),
    left:i*CW+4, top:26
  })));
  const labels=m.candidates.map((c,i)=>`<text x="${i*CW+8}" y="20" font-size="20" fill="#c00" font-family="sans-serif">P${m.panel} cand${c.idx}</text>`).join("");
  await sharp({create:{width:CW*n,height:CH,channels:3,background:"#ffffff"}})
    .composite([...tiles,{input:Buffer.from(`<svg width="${CW*n}" height="${CH}">${labels}</svg>`),left:0,top:0}])
    .png().toFile(`${OUT}/panel${String(m.panel).padStart(2,"0")}.png`);
}
console.log("panels:", meta.length, "candidates each:", meta.map(m=>m.candidates.length).join(","));
