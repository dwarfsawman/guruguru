// 完成 run の書き出し: PNG(zip) / JPEG(zip) / PPTX / ORA と、プロジェクト全体の .gguru。
// PDF は GURUGURU が直接持たないので、書き出したページ画像から組み立てる。
const BASE="http://127.0.0.1:5199";
const R=process.argv[2], PID=process.argv[3], OUT=process.argv[4];
const {mkdirSync,writeFileSync}=await import("node:fs");
mkdirSync(OUT,{recursive:true});
const grab=async(url,body,name)=>{
  const res=await fetch(url,{method:body?"POST":"GET",headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});
  if(!res.ok){ console.log("FAIL",name,res.status,(await res.text()).slice(0,200)); return null; }
  const buf=Buffer.from(await res.arrayBuffer());
  const f=`${OUT}/${name}`; writeFileSync(f,buf);
  console.log("wrote",name,(buf.length/1048576).toFixed(2),"MB");
  return f;
};
await grab(`${BASE}/api/script-manga-runs/${R}/export`,{format:"png"},"seiri-touban-pages-png.zip");
await grab(`${BASE}/api/script-manga-runs/${R}/export`,{format:"jpeg",quality:92},"seiri-touban-pages-jpeg.zip");
await grab(`${BASE}/api/script-manga-runs/${R}/export`,{format:"pptx"},"seiri-touban.pptx");
await grab(`${BASE}/api/script-manga-runs/${R}/export`,{format:"ora"},"seiri-touban.ora.zip");
await grab(`${BASE}/api/projects/${PID}/export`,null,"seiri-touban-project.gguru");
