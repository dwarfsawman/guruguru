const BASE="http://127.0.0.1:5199";
const R=process.argv[2]; const OUT=process.argv[3];
const sharp=(await import("sharp")).default;
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(OUT,{recursive:true});
const d=await (await fetch(`${BASE}/api/script-manga-runs/${R}`)).json();
const tasks=d.tasks??[];
const items=[];
for (const [i,t] of tasks.entries()) {
  const a=(t.candidateAssetIds??[])[0];
  if(!a){ console.log("no candidate", t.panelId); continue; }
  const res=await fetch(`${BASE}/api/assets/${a}/image`);
  if(!res.ok){ console.log("fetch fail", t.panelId, res.status); continue; }
  const buf=Buffer.from(await res.arrayBuffer());
  const file=`${OUT}/${String(i+1).padStart(2,"0")}_${t.panelId}.png`;
  writeFileSync(file, buf);
  items.push({file, label:`${i+1} ${t.panelId}`, taskId:t.id, assetId:a});
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(items,null,2));
// contact sheets of 6 (3x2)
const CW=430, CH=600;
for (let s=0; s<Math.ceil(items.length/6); s++) {
  const group=items.slice(s*6,s*6+6);
  const tiles=await Promise.all(group.map(async g=>({
    input: await sharp(g.file).resize(CW-10,CH-10,{fit:"contain",background:"#fff"}).toBuffer(),
    left:(group.indexOf(g)%3)*CW+5, top:Math.floor(group.indexOf(g)/3)*CH+5
  })));
  const labels = group.map((g,i)=>`<text x="${(i%3)*CW+10}" y="${Math.floor(i/3)*CH+20}" font-size="22" fill="#c00" font-family="sans-serif">${g.label}</text>`).join("");
  const svg=Buffer.from(`<svg width="${CW*3}" height="${CH*2}">${labels}</svg>`);
  await sharp({create:{width:CW*3,height:CH*2,channels:3,background:"#ffffff"}})
    .composite([...tiles,{input:svg,left:0,top:0}]).png().toFile(`${OUT}/sheet${s+1}.png`);
  console.log("sheet", s+1, "with", group.length);
}
console.log("total", items.length);
