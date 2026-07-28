const BASE="http://127.0.0.1:5199";
const PID="project_1ed9d6e0-8f66-4d4b-ae8c-c81b5b6ac31b";
const OUT="C:/Users/raven/work/mangaWorks/gakuen/02_model_tests/refsets";
const sharp=(await import("sharp")).default;
const {mkdirSync,writeFileSync}=await import("node:fs");
mkdirSync(OUT,{recursive:true});
const all=(await (await fetch(`${BASE}/api/projects/${PID}/reference-sets`)).json()).referenceSets??[];
const meta=[];
for (const s of all) {
  for (const img of s.images??[]) {
    const cands=img.candidates??[];
    const files=[];
    for (const [i,c] of cands.entries()) {
      const res=await fetch(`${BASE}/api/assets/${c.assetId}/image`);
      if(!res.ok) continue;
      const f=`${OUT}/${s.characterName.replace(/\s/g,"")}_${img.role}_${i+1}.png`;
      writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      files.push({file:f, assetId:c.assetId, idx:i+1});
    }
    meta.push({setId:s.id, name:s.characterName, role:img.role, files});
    if(files.length){
      const CW=400,CH=520;
      const tiles=await Promise.all(files.map(async(f,i)=>({input:await sharp(f.file).resize(CW-8,CH-28,{fit:"contain",background:"#fff"}).toBuffer(),left:i*CW+4,top:24})));
      const labels=files.map((f,i)=>`<text x="${i*CW+8}" y="18" font-size="18" fill="#c00" font-family="sans-serif">${s.characterName} ${img.role} #${f.idx}</text>`).join("");
      await sharp({create:{width:CW*files.length,height:CH,channels:3,background:"#ffffff"}})
        .composite([...tiles,{input:Buffer.from(`<svg width="${CW*files.length}" height="${CH}">${labels}</svg>`),left:0,top:0}])
        .png().toFile(`${OUT}/sheet_${s.characterName.replace(/\s/g,"")}_${img.role}.png`);
    }
  }
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(meta,null,2));
console.log(meta.map(m=>`${m.name}/${m.role}: ${m.files.length}`).join("  "));
