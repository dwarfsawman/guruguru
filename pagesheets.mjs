// 完成ページのプレビューを取得し、8ページずつのグリッドにして通読監査に使う。
const BASE="http://127.0.0.1:5199";
const PID=process.argv[2], OUT=process.argv[3];
const sharp=(await import("sharp")).default;
const {mkdirSync,writeFileSync}=await import("node:fs");
mkdirSync(OUT,{recursive:true});
const d=await (await fetch(`${BASE}/api/projects/${PID}/pages`)).json();
const pages=(d.pages??[]).sort((a,b)=>(a.pageIndex??a.index??0)-(b.pageIndex??b.index??0));
const files=[];
for (const [i,p] of pages.entries()) {
  const res=await fetch(`${BASE}/api/projects/${PID}/pages/${p.id}/preview.png`);
  if(!res.ok){ console.log("page",i+1,"preview",res.status); continue; }
  const f=`${OUT}/page${String(i+1).padStart(2,"0")}.png`;
  writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  files.push({file:f, n:i+1, id:p.id});
}
writeFileSync(`${OUT}/pages.json`, JSON.stringify(files,null,2));
const CW=330, CH=470, COLS=4, ROWS=2;
for (let s=0; s<Math.ceil(files.length/(COLS*ROWS)); s++) {
  const g=files.slice(s*COLS*ROWS,(s+1)*COLS*ROWS);
  const tiles=await Promise.all(g.map(async (x,i)=>({
    input: await sharp(x.file).resize(CW-8,CH-26,{fit:"contain",background:"#fff"}).toBuffer(),
    left:(i%COLS)*CW+4, top:Math.floor(i/COLS)*CH+22 })));
  const labels=g.map((x,i)=>`<text x="${(i%COLS)*CW+8}" y="${Math.floor(i/COLS)*CH+16}" font-size="17" fill="#c00" font-family="sans-serif">p${x.n}</text>`).join("");
  await sharp({create:{width:CW*COLS,height:CH*ROWS,channels:3,background:"#ffffff"}})
    .composite([...tiles,{input:Buffer.from(`<svg width="${CW*COLS}" height="${CH*ROWS}">${labels}</svg>`),left:0,top:0}])
    .png().toFile(`${OUT}/readthrough${s+1}.png`);
}
console.log("pages:",files.length,"sheets:",Math.ceil(files.length/(COLS*ROWS)));
