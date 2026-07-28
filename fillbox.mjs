// 残った偽文字をページオブジェクト層の BoxObject で塗りつぶす。
// 生成アセットは書き換えない(レタリング層で処理する)ので、候補や修復履歴は無傷。
// usage: bun fillbox.mjs <PID> <PAGEID> '<json array of {x,y,w,h,fill?}>'  (page 単位の座標)
const BASE="http://127.0.0.1:5199";
const [PID,PAGEID,RECTS]=process.argv.slice(2);
const rects=JSON.parse(RECTS);
const cur=await (await fetch(`${BASE}/api/projects/${PID}/pages/${PAGEID}`)).json();
const page=cur.page??cur;
const objects=[...(page.objects??[])];
let n=0;
for (const r of rects) {
  objects.push({
    id:`box_fill_${Date.now()}_${n++}`, kind:"box",
    position:{x:r.x,y:r.y}, size:{x:r.w,y:r.h},
    fill:r.fill??"#ffffff", strokeColor:"#ffffff", strokeWidth:0, cornerRadius:0, rotation:0
  });
}
const res=await fetch(`${BASE}/api/projects/${PID}/pages/${PAGEID}/objects`,{
  method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({objects})});
console.log(res.status, res.ok?`filled ${n} rect(s)`:(await res.text()).slice(0,250));
