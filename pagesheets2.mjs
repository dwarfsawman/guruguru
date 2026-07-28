const BASE="http://127.0.0.1:5199";
const R=process.argv[2], PID=process.argv[3], OUT=process.argv[4];
const sharp=(await import("sharp")).default;
const {mkdirSync,writeFileSync,rmSync}=await import("node:fs");
rmSync(OUT,{recursive:true,force:true}); mkdirSync(OUT,{recursive:true});
const run=await (await fetch(`${BASE}/api/script-manga-runs/${R}`)).json();
const tasks=run.tasks??[];
const order=[]; const seen=new Set();
for(const t of tasks){ if(!seen.has(t.pageId)){ seen.add(t.pageId); order.push(t.pageId); } }
const files=[];
for (const [i,pid] of order.entries()) {
  const res=await fetch(`${BASE}/api/projects/${PID}/pages/${pid}/preview.png`);
  if(!res.ok){ console.log("page",i+1,res.status); continue; }
  const f=`${OUT}/page${String(i+1).padStart(2,"0")}.png`;
  writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  files.push({file:f,n:i+1,id:pid});
}
writeFileSync(`${OUT}/pages.json`, JSON.stringify(files,null,2));
const CW=310,CH=440,COLS=4,ROWS=2;
for(let s=0;s<Math.ceil(files.length/(COLS*ROWS));s++){
  const g=files.slice(s*COLS*ROWS,(s+1)*COLS*ROWS);
  const tiles=await Promise.all(g.map(async(x,i)=>({input:await sharp(x.file).resize(CW-8,CH-24,{fit:"contain",background:"#fff"}).toBuffer(),left:(i%COLS)*CW+4,top:(Math.floor(i/COLS))*CH+20})));
  const labels=g.map((x,i)=>`<text x="${(i%COLS)*CW+8}" y="15" font-size="16" fill="#c00" font-family="sans-serif" transform="translate(0,${Math.floor(i/COLS)*CH})">p${x.n}</text>`).join("");
  await sharp({create:{width:CW*COLS,height:CH*ROWS,channels:3,background:"#ffffff"}})
    .composite([...tiles,{input:Buffer.from(`<svg width="${CW*COLS}" height="${CH*ROWS}">${labels}</svg>`),left:0,top:0}])
    .png().toFile(`${OUT}/readthrough${s+1}.png`);
}
console.log("run pages:",files.length,"sheets:",Math.ceil(files.length/(COLS*ROWS)));
